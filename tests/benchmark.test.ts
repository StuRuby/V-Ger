import { describe, expect, it } from "vitest";
import {
  BENCHMARK_DEV_TASKS,
  BENCHMARK_HOLDOUT_TASKS,
  BENCHMARK_TOTAL_TASKS,
  loadBenchmarkTasks,
  validateBenchmarkMetrics,
  validateBenchmarkTasks
} from "../src/benchmark.js";

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
});
