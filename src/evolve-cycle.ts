import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import type { RoundArtifact } from "./round-artifact.js";

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

export const PROGRESSION_ROADMAP = [
  { stage: 1, label: "tool_calling_reliability", objective: "improve overall tool calling reliability and task success rate" },
  { stage: 2, label: "multi_step_reasoning", objective: "improve multi-tool chain task success rate" },
  { stage: 3, label: "error_recovery", objective: "improve failure recovery task success rate" },
  { stage: 4, label: "long_context_handling", objective: "improve long chain task success rate" },
  { stage: 5, label: "code_quality", objective: "improve code quality and test coverage" },
  { stage: 6, label: "safety_robustness", objective: "improve safety adversarial task success rate" },
] as const;

type StageRecord = { stage: number; updatedAt: string };

async function loadStage(rootDir: string): Promise<number> {
  const stagePath = join(rootDir, "artifacts", "stage.json");
  try {
    const raw = await readFile(stagePath, "utf8");
    const parsed = JSON.parse(raw) as StageRecord;
    if (typeof parsed.stage === "number" && parsed.stage >= 1 && parsed.stage <= PROGRESSION_ROADMAP.length) {
      return parsed.stage;
    }
    throw new Error("invalid stage value");
  } catch {
    // 文件不存在或损坏时重置为 Stage 1
    console.error("[generateObjective] warn: stage.json missing or corrupt, resetting to stage=1");
    await persistStage(rootDir, 1);
    return 1;
  }
}

async function persistStage(rootDir: string, stage: number): Promise<void> {
  const artifactsDir = join(rootDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const stagePath = join(artifactsDir, "stage.json");
  await writeFile(stagePath, JSON.stringify({ stage, updatedAt: new Date().toISOString() }, null, 2), "utf8");
}

function getWeakestCategory(report: LastRoundReport): string | undefined {
  const byCategory = new Map<string, { total: number; success: number }>();
  for (const task of report.tasks) {
    const entry = byCategory.get(task.category) ?? { total: 0, success: 0 };
    entry.total += 1;
    if (task.taskSuccess) entry.success += 1;
    byCategory.set(task.category, entry);
  }
  let weakest: string | undefined;
  let lowestRate = Infinity;
  for (const [category, { total, success }] of byCategory) {
    const rate = total > 0 ? success / total : 0;
    if (rate < lowestRate) {
      lowestRate = rate;
      weakest = category;
    }
  }
  return weakest;
}

export async function generateObjective(
  rootDir: string,
  recentArtifacts: RoundArtifact[],
  benchmarkReport?: LastRoundReport
): Promise<string> {
  // cold start: 无任何历史数据时直接返回默认目标
  if (recentArtifacts.length === 0 && !benchmarkReport) {
    return DEFAULT_EVOLVE_OBJECTIVE;
  }

  const currentStage = await loadStage(rootDir);

  if (benchmarkReport) {
    const { metrics } = benchmarkReport;

    // 优先级 1: 安全违规
    if (metrics.safetyViolations > 0) {
      return "eliminate safety violations in tool usage";
    }

    // 优先级 2: 工具调用成功率
    if (metrics.toolCallSuccessRate < 99) {
      const weakest = getWeakestCategory(benchmarkReport);
      const prefix = weakest ? `${weakest} ` : "";
      return `improve ${prefix}tool call success rate from ${metrics.toolCallSuccessRate}% to ≥99%`;
    }

    // 优先级 3: 任务成功率
    if (metrics.taskSuccessRate < 95) {
      const weakest = getWeakestCategory(benchmarkReport);
      const prefix = weakest ? `${weakest} ` : "";
      return `improve ${prefix}task success rate from ${metrics.taskSuccessRate}% to ≥95%`;
    }

    // 优先级 4: dev/holdout 过拟合差距
    if (metrics.devHoldoutGap > 2) {
      return `reduce dev/holdout overfitting gap from ${metrics.devHoldoutGap}% to ≤2%`;
    }
  }

  // 优先级 5: 连续 3 轮相同 objective 且目标指标变化 < 1% → 推进 stage
  if (recentArtifacts.length >= 3) {
    const last3 = recentArtifacts.slice(-3);
    const sameObjective = last3.every((a) => a.objective === last3[0].objective);
    if (sameObjective) {
      const rates = last3.map((a) => a.benchmark.metrics.toolCallSuccessRate);
      const delta = Math.max(...rates) - Math.min(...rates);
      if (delta < 1) {
        const nextStage = Math.min(currentStage + 1, PROGRESSION_ROADMAP.length);
        if (nextStage !== currentStage) {
          await persistStage(rootDir, nextStage);
          console.error(`[generateObjective] stagnation detected — advancing to stage ${nextStage} (${PROGRESSION_ROADMAP[nextStage - 1].label})`);
          return PROGRESSION_ROADMAP[nextStage - 1].objective;
        }
      }
    }
  }

  // 优先级 6: 全指标通过或无 benchmark → 返回当前阶段目标
  return PROGRESSION_ROADMAP[currentStage - 1].objective;
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
