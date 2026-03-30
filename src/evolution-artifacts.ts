import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

export type RoundCheckResult = {
  name: string;
  exitCode: number;
  passed: boolean;
};

export type BenchmarkGateResult = {
  ok: boolean;
  reportPath?: string;
  summary?: string;
};

export type RoundStatus = "passed" | "failed";

export type RoundArtifact = {
  roundId: string;
  objective: string;
  branch: string;
  headSha: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  changedFiles: string[];
  checks: RoundCheckResult[];
  benchmark: BenchmarkGateResult;
  safetyInterceptEvents: string[];
  toolExecutions: string[];
  status: RoundStatus;
  failReason?: string;
};

type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function execCapture(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    // 统一用 capture 模式执行 git 辅助命令，避免这些元数据查询污染主流程输出。
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on("error", (error) => resolve({ exitCode: 1, stdout, stderr: String(error) }));
  });
}

export function buildRoundId(date: Date = new Date()): string {
  const timestamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  // 时间戳保证大体可排序，随机后缀避免同一秒内多次生成时冲突。
  return `${timestamp}-${randomSuffix}`;
}

export async function getGitBranch(cwd: string): Promise<string> {
  const result = await execCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return result.exitCode === 0 ? result.stdout.trim() || "unknown" : "unknown";
}

export async function getGitHeadSha(cwd: string): Promise<string> {
  const result = await execCapture("git", ["rev-parse", "HEAD"], cwd);
  return result.exitCode === 0 ? result.stdout.trim() || "unknown" : "unknown";
}

export async function getChangedFiles(cwd: string): Promise<string[]> {
  const result = await execCapture("git", ["status", "--porcelain"], cwd);
  if (result.exitCode !== 0) return [];

  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      // rename 场景只保留箭头右侧的新路径，便于 artifact 消费方直接定位当前文件。
      const normalized = line.replace(/^([A-Z? ]{1,2})\s+/, "");
      const arrowIndex = normalized.indexOf(" -> ");
      return arrowIndex >= 0 ? normalized.slice(arrowIndex + 4) : normalized;
    });
}

export async function writeRoundArtifact(rootDir: string, artifact: RoundArtifact): Promise<string> {
  const artifactDir = join(rootDir, "artifacts", "evolution");
  await mkdir(artifactDir, { recursive: true });
  const filePath = join(artifactDir, `${artifact.roundId}.json`);
  // 末尾保留换行，方便在终端直接查看和后续做文本拼接。
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return filePath;
}
