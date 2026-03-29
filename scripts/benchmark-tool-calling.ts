import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadBenchmarkTasks, validateBenchmarkTasks } from "../src/benchmark.js";

type BenchmarkReport = {
  generatedAt: string;
  mode: "scaffold_integrity";
  totalTasks: number;
  splitCounts: { dev: number; holdout: number };
  categoryCounts: Record<string, number>;
  ok: boolean;
  errors: string[];
};

function parseArgs(args: string[]): { outPath: string } {
  let outPath = join("artifacts", "benchmarks", "tool-calling-v1-latest.json");

  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "--out" && i + 1 < args.length) {
      outPath = args[i + 1];
      i += 1;
    }
  }

  return { outPath: resolve(outPath) };
}

async function main() {
  const { outPath } = parseArgs(process.argv.slice(2));
  const tasks = await loadBenchmarkTasks(process.cwd());
  const validation = validateBenchmarkTasks(tasks);

  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    mode: "scaffold_integrity",
    totalTasks: validation.totalTasks,
    splitCounts: validation.splitCounts,
    categoryCounts: validation.categoryCounts,
    ok: validation.ok,
    errors: validation.errors
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (!validation.ok) {
    console.error("Benchmark scaffold validation failed:");
    for (const error of validation.errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Benchmark scaffold validation passed (${validation.totalTasks} tasks).`);
  console.log(`Report: ${outPath}`);
}

void main();
