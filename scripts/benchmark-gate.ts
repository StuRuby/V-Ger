import { readFile } from "node:fs/promises";
import { BENCHMARK_TOTAL_TASKS, loadBenchmarkTasks, validateBenchmarkMetrics, validateBenchmarkTasks } from "../src/benchmark.js";
import { getLatestRoundArtifactPath } from "../src/round-artifact.js";

type RoundArtifactForGate = {
  benchmark?: {
    metrics?: {
      toolCallSuccessRate: number;
      taskSuccessRate: number;
      safetyViolations: number;
      devHoldoutGap: number;
    };
  };
};

function parseRoundArtifactArg(argv: string[]): string | undefined {
  const index = argv.indexOf("--round-artifact");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value?.trim() || undefined;
}

async function loadArtifact(path: string): Promise<RoundArtifactForGate> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as RoundArtifactForGate;
}

async function main() {
  const cwd = process.cwd();
  const tasks = await loadBenchmarkTasks(cwd);
  const suiteValidation = validateBenchmarkTasks(tasks);

  if (!suiteValidation.ok) {
    console.error("Benchmark scaffold validation failed:");
    for (const error of suiteValidation.errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  if (tasks.length !== BENCHMARK_TOTAL_TASKS) {
    console.error(`Benchmark task count mismatch: expected ${BENCHMARK_TOTAL_TASKS}, got ${tasks.length}.`);
    process.exit(1);
  }

  const explicitPath = parseRoundArtifactArg(process.argv.slice(2));
  const artifactPath = explicitPath ?? (await getLatestRoundArtifactPath(cwd));
  if (!artifactPath) {
    console.error("No round artifact available for metric gate.");
    process.exit(1);
  }

  const artifact = await loadArtifact(artifactPath);
  const metrics = artifact.benchmark?.metrics;
  if (!metrics) {
    console.error(`Round artifact ${artifactPath} does not contain benchmark metrics.`);
    process.exit(1);
  }

  const metricErrors = validateBenchmarkMetrics(metrics);
  if (metricErrors.length > 0) {
    console.error("Benchmark metric threshold gate failed:");
    for (const error of metricErrors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.error(`Benchmark gate passed using artifact: ${artifactPath}`);
}

void main();
