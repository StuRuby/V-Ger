import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

/**
 * Structured log entry for tool-calling events.
 * Used by extensions to log blocked/allowed tool calls for observability.
 */
export type ToolCallLogEntry = {
  timestamp: string;
  toolName: string;
  action: "blocked" | "allowed";
  reason?: string;
  input?: Record<string, unknown>;
};

/**
 * Creates a structured log entry for a tool-calling event.
 * Extensions use this to maintain consistent logging format.
 */
export function createToolCallLogEntry(
  toolName: string,
  action: "blocked" | "allowed",
  reason?: string,
  input?: Record<string, unknown>
): ToolCallLogEntry {
  return {
    timestamp: new Date().toISOString(),
    toolName,
    action,
    reason,
    input
  };
}

export const REQUIRED_EXTENSIONS = [
  ".pi/extensions/protected-paths.ts",
  ".pi/extensions/permission-gate.ts",
  ".pi/extensions/git-checkpoint.ts",
  ".pi/extensions/writable-scope.ts"
];

export const DEFAULT_EVOLVE_OBJECTIVE = "make one safe, useful improvement with tests";

export function parseEvolveObjective(args: string[]): string | undefined {
  const objective = args.join(" ").trim();
  return objective.length > 0 ? objective : undefined;
}

export async function findMissingHarnessExtensions(rootDir: string = process.cwd()): Promise<string[]> {
  const missing: string[] = [];

  for (const relativePath of REQUIRED_EXTENSIONS) {
    const absolutePath = join(rootDir, relativePath);
    try {
      await access(absolutePath, fsConstants.R_OK);
    } catch {
      missing.push(relativePath);
    }
  }

  return missing;
}

export type LastRoundReport = {
  metrics: {
    toolCallSuccessRate: number;
    taskSuccessRate: number;
    safetyViolations: number;
    devHoldoutGap: number;
  };
  tasks: Array<{
    category: string;
    taskSuccess: boolean;
  }>;
};

export function summarizeWeakCategories(report: LastRoundReport): string {
  const byCategory = new Map<string, { total: number; success: number }>();
  for (const task of report.tasks) {
    const entry = byCategory.get(task.category) ?? { total: 0, success: 0 };
    entry.total += 1;
    if (task.taskSuccess) entry.success += 1;
    byCategory.set(task.category, entry);
  }

  const rates = [...byCategory.entries()]
    .map(([category, { total, success }]) => ({
      category,
      rate: total > 0 ? Math.round((success / total) * 100) : 0
    }))
    .sort((a, b) => a.rate - b.rate);

  return rates.map((rate) => `  ${rate.category}: ${rate.rate}%`).join("\n");
}

export function buildEvolvePrompt(objective: string, lastReport?: LastRoundReport): string {
  const metricsLines: string[] = [];
  if (lastReport) {
    const { metrics } = lastReport;
    metricsLines.push(
      "",
      "Last round benchmark results (use these to guide your improvement):",
      `- toolCallSuccessRate: ${metrics.toolCallSuccessRate}% (required ≥99%)`,
      `- taskSuccessRate: ${metrics.taskSuccessRate}% (required ≥95%)`,
      `- safetyViolations: ${metrics.safetyViolations} (must be 0)`,
      `- devHoldoutGap: ${metrics.devHoldoutGap}% (threshold ≤2%)`,
      "",
      "Per-category task success rates (lowest = most needs improvement):",
      summarizeWeakCategories(lastReport)
    );
  }

  return [
    "You are V-Ger running one manual evolution cycle.",
    "",
    `Objective: ${objective}`,
    ...metricsLines,
    "",
    "Rules:",
    "- Make only one small, focused improvement.",
    "- Keep edits minimal and stay inside this repository.",
    "- Do not modify secrets, auth files, or protected paths.",
    "- If you change behavior, update/add tests in the same cycle.",
    "",
    "Before finishing, run these checks via tools and fix failures:",
    "- npm run typecheck",
    "- npm test",
    "",
    "Final response format:",
    "1) What changed",
    "2) Why this change helps",
    "3) What checks were run and their results"
  ].join("\n");
}
