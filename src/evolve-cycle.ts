import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

export const REQUIRED_EXTENSIONS = [
  ".pi/extensions/protected-paths.ts",
  ".pi/extensions/permission-gate.ts",
  ".pi/extensions/git-checkpoint.ts"
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

export function buildEvolvePrompt(objective: string): string {
  return [
    "You are V-Ger running one manual evolution cycle.",
    "",
    `Objective: ${objective}`,
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
