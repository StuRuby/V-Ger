import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateBenchmarkMetrics,
  BENCHMARK_DEV_TASKS,
  BENCHMARK_HOLDOUT_TASKS,
  BENCHMARK_TOTAL_TASKS,
  type BenchmarkTask,
  loadBenchmarkTasks,
  selectBenchmarkTasks,
  validateBenchmarkMetrics,
  validateBenchmarkTasks
} from "../src/benchmark.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("benchmark scaffold", () => {
  it("loads and validates v1 benchmark seed with expected counts", async () => {
    const tasks = await loadBenchmarkTasks(process.cwd());
    const validation = validateBenchmarkTasks(tasks);

    expect(tasks.length).toBe(BENCHMARK_TOTAL_TASKS);
    expect(validation.ok).toBe(true);
    expect(validation.splitCounts.dev).toBe(BENCHMARK_DEV_TASKS);
    expect(validation.splitCounts.holdout).toBe(BENCHMARK_HOLDOUT_TASKS);
  });

  it("fails metric validation when thresholds are not met", () => {
    const errors = validateBenchmarkMetrics({
      toolCallSuccessRate: 98,
      taskSuccessRate: 94,
      safetyViolations: 1,
      devHoldoutGap: 3
    });
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });

  it("selects requested dev and holdout sample sizes", async () => {
    // 抽样测试固定覆盖 dev/holdout 两侧，确保 CLI 采样参数不会破坏 split 边界。
    const tasks = await loadBenchmarkTasks(process.cwd());
    const selected = selectBenchmarkTasks(tasks, 3, 2);
    expect(selected.filter((task) => task.split === "dev")).toHaveLength(3);
    expect(selected.filter((task) => task.split === "holdout")).toHaveLength(2);
  });

  it("shuffles each split before sampling", () => {
    const tasks: BenchmarkTask[] = [
      { id: "dev-1", split: "dev", category: "single_tool", prompt: "d1", requiredTools: ["read_file"] },
      { id: "dev-2", split: "dev", category: "single_tool", prompt: "d2", requiredTools: ["read_file"] },
      { id: "dev-3", split: "dev", category: "single_tool", prompt: "d3", requiredTools: ["read_file"] },
      { id: "holdout-1", split: "holdout", category: "single_tool", prompt: "h1", requiredTools: ["read_file"] },
      { id: "holdout-2", split: "holdout", category: "single_tool", prompt: "h2", requiredTools: ["read_file"] }
    ];
    // 固定随机序列，确保测试验证的是“先洗牌再截断”，而不是依赖真实随机结果。
    vi.spyOn(Math, "random").mockReturnValue(0);

    const selected = selectBenchmarkTasks(tasks, 2, 1);

    expect(selected.map((task) => task.id)).toEqual(["dev-2", "dev-3", "holdout-2"]);
  });

  it("calculates benchmark metrics from task results", () => {
    const metrics = calculateBenchmarkMetrics([
      { id: "a", split: "dev", category: "single_tool", toolSuccess: true, taskSuccess: true, safetyViolation: false },
      { id: "b", split: "dev", category: "single_tool", toolSuccess: true, taskSuccess: false, safetyViolation: false },
      { id: "c", split: "holdout", category: "single_tool", toolSuccess: false, taskSuccess: false, safetyViolation: true },
      { id: "d", split: "holdout", category: "single_tool", toolSuccess: true, taskSuccess: true, safetyViolation: false }
    ]);

    expect(metrics.toolCallSuccessRate).toBe(75);
    expect(metrics.taskSuccessRate).toBe(50);
    expect(metrics.safetyViolations).toBe(1);
    expect(metrics.devHoldoutGap).toBe(0);
  });
});
