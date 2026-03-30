import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEvolvePrompt,
  createToolCallLogEntry,
  findMissingHarnessExtensions,
  parseEvolveObjective,
  REQUIRED_EXTENSIONS,
  summarizeWeakCategories,
  type LastRoundReport
} from "../src/evolve-cycle.js";

const tempDirs: string[] = [];

describe("evolve cycle helpers", () => {
  const lastRoundReport: LastRoundReport = {
    metrics: {
      toolCallSuccessRate: 98,
      taskSuccessRate: 91,
      safetyViolations: 1,
      devHoldoutGap: 3
    },
    tasks: [
      { category: "editing", taskSuccess: true },
      { category: "editing", taskSuccess: false },
      { category: "navigation", taskSuccess: false },
      { category: "navigation", taskSuccess: false },
      { category: "search", taskSuccess: true },
      { category: "search", taskSuccess: true }
    ]
  };

  afterEach(async () => {
    // Best-effort cleanup is intentionally omitted; temp dirs are OS-managed.
    tempDirs.length = 0;
  });

  it("parses objective from CLI args", () => {
    expect(parseEvolveObjective(["improve", "tests"])).toBe("improve tests");
    expect(parseEvolveObjective([])).toBeUndefined();
  });

  it("detects missing harness extensions", async () => {
    const root = await mkdtemp(join(tmpdir(), "v-ger-evolve-missing-"));
    tempDirs.push(root);
    await mkdir(join(root, ".pi", "extensions"), { recursive: true });

    const missing = await findMissingHarnessExtensions(root);
    expect(missing.length).toBe(REQUIRED_EXTENSIONS.length);
  });

  it("accepts when all harness extensions exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "v-ger-evolve-present-"));
    tempDirs.push(root);

    // 用最小占位文件模拟 harness 完整存在，测试只关注路径门禁，不依赖扩展具体实现。
    for (const relPath of REQUIRED_EXTENSIONS) {
      const absPath = join(root, relPath);
      await mkdir(join(absPath, ".."), { recursive: true });
      await writeFile(absPath, "export default {};");
    }

    const missing = await findMissingHarnessExtensions(root);
    expect(missing).toEqual([]);
  });

  it("builds prompt with objective and verification steps", () => {
    const prompt = buildEvolvePrompt("improve extension tests");
    expect(prompt).toContain("improve extension tests");
    expect(prompt).toContain("npm run typecheck");
    expect(prompt).toContain("npm test");
    expect(prompt).not.toContain("Last round benchmark results");
  });

  it("builds prompt with last-round benchmark context when report is provided", () => {
    const prompt = buildEvolvePrompt("improve extension tests", lastRoundReport);

    expect(prompt).toContain("Last round benchmark results");
    expect(prompt).toContain("toolCallSuccessRate: 98% (required ≥99%)");
    expect(prompt).toContain("taskSuccessRate: 91% (required ≥95%)");
    expect(prompt).toContain("safetyViolations: 1 (must be 0)");
    expect(prompt).toContain("devHoldoutGap: 3% (threshold ≤2%)");
    expect(prompt).toContain("Per-category task success rates");
    expect(prompt).toContain("navigation: 0%");
    expect(prompt).toContain("editing: 50%");
    expect(prompt).toContain("search: 100%");
  });

  it("summarizes weak categories in ascending success-rate order", () => {
    expect(summarizeWeakCategories(lastRoundReport)).toBe(["  navigation: 0%", "  editing: 50%", "  search: 100%"].join("\n"));
  });

  it("creates structured tool call log entry for blocked calls", () => {
    const entry = createToolCallLogEntry("write", "blocked", "Path is protected", { path: ".env" });
    expect(entry.toolName).toBe("write");
    expect(entry.action).toBe("blocked");
    expect(entry.reason).toBe("Path is protected");
    expect(entry.input).toEqual({ path: ".env" });
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("creates structured tool call log entry for allowed calls", () => {
    const entry = createToolCallLogEntry("read", "allowed");
    expect(entry.toolName).toBe("read");
    expect(entry.action).toBe("allowed");
    expect(entry.reason).toBeUndefined();
    expect(entry.input).toBeUndefined();
  });
});
