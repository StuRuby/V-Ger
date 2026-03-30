import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";
import { getKimiApiKey, selectKimiModel } from "../src/config.js";
import {
  BENCHMARK_DEV_TASKS,
  BENCHMARK_HOLDOUT_TASKS,
  BENCHMARK_TOTAL_TASKS,
  type BenchmarkMetrics,
  getBenchmarkReportPath,
  loadBenchmarkTasks,
  validateBenchmarkTasks
} from "../src/benchmark.js";
import {
  buildEvolvePrompt,
  DEFAULT_EVOLVE_OBJECTIVE,
  findMissingHarnessExtensions,
  parseEvolveObjective,
  type LastRoundReport
} from "../src/evolve-cycle.js";
import { createRoundId, type GateCheckResult, writeRoundArtifact } from "../src/round-artifact.js";

type CheckCommand = {
  cmd: string;
  args: string[];
  name: string;
};

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const POST_CHECKS: CheckCommand[] = [
  { name: "typecheck", cmd: "npm", args: ["run", "typecheck"] },
  { name: "test", cmd: "npm", args: ["test"] }
];

function runCommand(command: CheckCommand, cwd: string, inheritOutput: boolean): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command.cmd, command.args, {
      cwd,
      stdio: inheritOutput ? "inherit" : "pipe"
    });

    let stdout = "";
    let stderr = "";

    if (!inheritOutput) {
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }

    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: String(error) }));
  });
}

async function runPostChecks(cwd: string): Promise<GateCheckResult[]> {
  const results: GateCheckResult[] = [];
  // 后置检查按顺序短路执行，目的是尽快暴露第一个失败门，而不是堆叠噪音日志。
  for (const command of POST_CHECKS) {
    const result = await runCommand(command, cwd, true);
    results.push({
      name: command.name,
      exitCode: result.code,
      passed: result.code === 0
    });
    if (result.code !== 0) {
      return results;
    }
  }
  return results;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const result = await runCommand({ name: "git", cmd: "git", args }, cwd, false);
  if (result.code !== 0) {
    return "";
  }
  return result.stdout.trim();
}

async function getChangedFiles(cwd: string): Promise<string[]> {
  const raw = await runGit(["status", "--porcelain"], cwd);
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[A-Z?]+\s+/, ""));
}

function pickFailReason(parts: Array<string | undefined>): string | undefined {
  return parts.find((item) => typeof item === "string" && item.trim().length > 0);
}

async function main() {
  const cwd = process.cwd();
  const roundId = createRoundId();
  const startedAt = new Date();
  const objective = parseEvolveObjective(process.argv.slice(2)) ?? DEFAULT_EVOLVE_OBJECTIVE;

  // 尝试把上一轮 benchmark 结果注入 prompt，让本轮演化优先修复最弱项。
  let lastReport: LastRoundReport | undefined;
  try {
    const reportPath = getBenchmarkReportPath(cwd);
    const raw = await readFile(reportPath, "utf8");
    lastReport = JSON.parse(raw) as LastRoundReport;
  } catch {
    // 首次运行或报告不存在时不阻塞演化；保持 prompt 回退到基础版本。
  }

  const prompt = buildEvolvePrompt(objective, lastReport);

  let failReason: string | undefined;
  const checks: GateCheckResult[] = [];
  const toolExecutions: string[] = [];
  let benchmarkSuiteErrors: string[] = [];
  let benchmarkMetricErrors: string[] = [];
  let benchmarkSuiteOk = false;
  let agentRunOk = false;

  // failReason 是整轮演化的统一失败出口；后面所有 gate 都只负责补充第一个有意义的失败原因。
  try {
    getKimiApiKey(process.env);
  } catch (error) {
    failReason = error instanceof Error ? error.message : "Missing KIMI_API_KEY";
  }

  const missingExtensions = await findMissingHarnessExtensions(cwd);
  if (!failReason && missingExtensions.length > 0) {
    failReason = `Harness extension gate failed: ${missingExtensions.join(", ")}`;
    console.error("Harness extension gate failed. Missing required extensions:");
    for (const extension of missingExtensions) {
      console.error(`- ${extension}`);
    }
  }

  if (!failReason) {
    const authStorage = AuthStorage.create();
    const modelRegistry = new ModelRegistry(authStorage);
    const availableModels = await modelRegistry.getAvailable();
    const model = selectKimiModel(availableModels);

    if (!model) {
      failReason = "No available kimi-coding model found. Check KIMI_API_KEY and provider availability.";
    } else {
      const { session } = await createAgentSession({
        cwd,
        model,
        sessionManager: SessionManager.inMemory(),
        authStorage,
        modelRegistry
      });

      session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          process.stdout.write(event.assistantMessageEvent.delta);
        }
        if (event.type === "tool_execution_start") {
          toolExecutions.push(event.toolName);
          console.error(`[tool:start] ${event.toolName}`);
        }
      });

      try {
        await session.prompt(prompt);
        process.stdout.write("\n");
        agentRunOk = true;
      } catch (error) {
        failReason = `Evolution cycle failed during agent run: ${error instanceof Error ? error.message : "unknown error"}`;
      } finally {
        session.dispose();
      }
    }
  }

  if (agentRunOk) {
    const postChecks = await runPostChecks(cwd);
    checks.push(...postChecks);
    if (checks.some((item) => !item.passed)) {
      failReason = pickFailReason([failReason, "Post-check gate failed."]);
    }
  }

  const benchmarkTasks = await loadBenchmarkTasks(cwd);
  const benchmarkSuite = validateBenchmarkTasks(benchmarkTasks);
  benchmarkSuiteErrors = benchmarkSuite.errors;
  benchmarkSuiteOk = benchmarkSuite.ok;

  if (!benchmarkSuite.ok) {
    failReason = pickFailReason([failReason, "Benchmark suite scaffold validation failed."]);
  }
  if (benchmarkTasks.length !== BENCHMARK_TOTAL_TASKS) {
    failReason = pickFailReason([failReason, "Benchmark task count is invalid."]);
  }

  // 真实 benchmark 单独跑脚本并读回报告，这样脚本本身也能作为独立 gate 复用。
  let benchmarkMetrics: BenchmarkMetrics = {
    toolCallSuccessRate: 0,
    taskSuccessRate: 0,
    safetyViolations: 0,
    devHoldoutGap: 0
  };

  if (!failReason) {
    const benchResult = await runCommand(
      { name: "benchmark", cmd: "node", args: ["--env-file=.env", "dist/scripts/benchmark-tool-calling.js", "--sample-dev", "5", "--sample-holdout", "2"] },
      cwd,
      true
    );
    if (benchResult.code !== 0) {
      failReason = pickFailReason([failReason, "Benchmark execution failed."]);
    }
    // 即使 benchmark 非 0 退出，也尽量读报告，方便保留失败现场和具体指标。
    try {
      const reportPath = getBenchmarkReportPath(cwd);
      const reportRaw = await readFile(reportPath, "utf8");
      const report = JSON.parse(reportRaw) as { metrics: BenchmarkMetrics; metricErrors: string[]; passed: boolean };
      benchmarkMetrics = report.metrics;
      benchmarkMetricErrors = report.metricErrors;
      if (!report.passed) {
        failReason = pickFailReason([failReason, "Benchmark metric threshold gate failed."]);
      }
    } catch {
      failReason = pickFailReason([failReason, "Could not read benchmark report."]);
    }
  }

  const endedAt = new Date();
  const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)) || "unknown";
  const commitSha = (await runGit(["rev-parse", "HEAD"], cwd)) || "unknown";
  const changedFiles = await getChangedFiles(cwd);

  const artifact = {
    roundId,
    objective,
    branch,
    commitSha,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    changedFiles,
    toolExecutions,
    checks,
    benchmark: {
      suiteOk: benchmarkSuiteOk,
      suiteErrors: benchmarkSuiteErrors,
      metrics: benchmarkMetrics,
      metricErrors: benchmarkMetricErrors,
      passed: benchmarkSuiteOk && benchmarkMetricErrors.length === 0
    },
    safetyInterceptEvents: [],
    status: failReason ? ("failed" as const) : ("passed" as const),
    failReason
  };

  const artifactPath = await writeRoundArtifact(artifact, cwd);
  console.error(`ROUND_ARTIFACT=${artifactPath}`);
  console.error(
    `BENCHMARK_SUITE_TOTAL=${benchmarkTasks.length} DEV=${BENCHMARK_DEV_TASKS} HOLDOUT=${BENCHMARK_HOLDOUT_TASKS}`
  );

  if (failReason) {
    console.error(failReason);
    process.exit(1);
  }

  if (toolExecutions.length === 0) {
    console.error("Warning: No tool execution observed during this evolution cycle.");
  }

  console.error("Manual evolve cycle completed.");
}

void main();
