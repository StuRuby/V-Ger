import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkMetrics } from "./benchmark.js";

export type GateCheckResult = {
  name: string;
  exitCode: number;
  passed: boolean;
};

export type RoundArtifact = {
  roundId: string;
  objective: string;
  branch: string;
  commitSha: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  changedFiles: string[];
  toolExecutions: string[];
  checks: GateCheckResult[];
  benchmark: {
    suiteOk: boolean;
    suiteErrors: string[];
    metrics: BenchmarkMetrics;
    metricErrors: string[];
    passed: boolean;
  };
  safetyInterceptEvents: string[];
  status: "passed" | "failed";
  failReason?: string;
};

export function createRoundId(at: Date = new Date()): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  const hour = String(at.getHours()).padStart(2, "0");
  const minute = String(at.getMinutes()).padStart(2, "0");
  const second = String(at.getSeconds()).padStart(2, "0");
  // 这里用纯时间戳格式，目的是让文件名天然按字典序对应创建顺序。
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

export function getRoundArtifactsDir(rootDir: string = process.cwd()): string {
  return join(rootDir, "artifacts", "evolution");
}

export async function writeRoundArtifact(artifact: RoundArtifact, rootDir: string = process.cwd()): Promise<string> {
  const dir = getRoundArtifactsDir(rootDir);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${artifact.roundId}.json`);
  await writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

export async function getLatestRoundArtifactPath(rootDir: string = process.cwd()): Promise<string | undefined> {
  const dir = getRoundArtifactsDir(rootDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  // 依赖 roundId 的时间排序约定，避免额外读取每个 artifact 再比较时间字段。
  const jsonFiles = entries.filter((name) => name.endsWith(".json")).sort();
  if (jsonFiles.length === 0) return undefined;
  return join(dir, jsonFiles[jsonFiles.length - 1]);
}
