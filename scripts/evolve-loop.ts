import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { getBenchmarkReportPath } from "../src/benchmark.js";
import { generateObjective } from "../src/evolve-cycle.js";
import { getLatestRoundArtifactPath, loadRecentArtifacts } from "../src/round-artifact.js";
import type { LastRoundReport, OpenTaskIssue } from "../src/evolve-cycle.js";

type LoopConfig = {
  objective: string;
  roundsLimit?: number;
  targetBranch: string;
  maxDurationMinutes: number;
  maxRoundDurationMinutes: number;
  maxRetriesPerRound: number;
  circuitBreakerFailures: number;
};

type CommandRunResult = {
  exitCode: number;
  timedOut: boolean;
};

const DEFAULT_TARGET_BRANCH = "evolve/auto";
const DEFAULT_MAX_DURATION_MINUTES = 120;
const DEFAULT_MAX_ROUND_DURATION_MINUTES = 120;
const DEFAULT_MAX_RETRIES_PER_ROUND = 5;
const DEFAULT_CIRCUIT_BREAKER_FAILURES = 5;

function parseNumberArg(args: string[], keys: string[], fallback: number): number {
  for (const key of keys) {
    const index = args.indexOf(key);
    if (index === -1) continue;
    const raw = args[index + 1];
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function parseOptionalNumberArg(args: string[], keys: string[]): number | undefined {
  for (const key of keys) {
    const index = args.indexOf(key);
    if (index === -1) continue;
    const raw = args[index + 1];
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function parseStringArg(args: string[], keys: string[], fallback: string): string {
  for (const key of keys) {
    const index = args.indexOf(key);
    if (index === -1) continue;
    const raw = args[index + 1]?.trim();
    if (raw) return raw;
  }
  return fallback;
}

function buildConfig(args: string[], objective: string): LoopConfig {
  const maxDurationMinutes = parseNumberArg(
    args,
    ["--max-duration-minutes", "--max-total-minutes"],
    DEFAULT_MAX_DURATION_MINUTES
  );
  const maxRoundDurationMinutes = parseNumberArg(
    args,
    ["--max-round-minutes", "--round-timeout-minutes"],
    DEFAULT_MAX_ROUND_DURATION_MINUTES
  );
  const roundsLimit = parseOptionalNumberArg(args, ["--rounds"]);

  return {
    objective,
    roundsLimit,
    targetBranch: parseStringArg(args, ["--branch"], DEFAULT_TARGET_BRANCH),
    maxDurationMinutes,
    maxRoundDurationMinutes,
    maxRetriesPerRound: parseNumberArg(args, ["--max-retries"], DEFAULT_MAX_RETRIES_PER_ROUND),
    circuitBreakerFailures: parseNumberArg(
      args,
      ["--circuit-breaker-failures", "--circuit-breaker"],
      DEFAULT_CIRCUIT_BREAKER_FAILURES
    )
  };
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
  inheritOutput: boolean = true
): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: inheritOutput ? "inherit" : "pipe"
    });

    let timedOut = false;
    const timeout = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          // 先发 SIGTERM，给脚本清理机会；如果还挂住，再升级到 SIGKILL。
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2_000);
        }, timeoutMs)
      : undefined;

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode: code ?? 1, timedOut });
    });
    child.on("error", () => {
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode: 1, timedOut });
    });
  });
}

async function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("close", (code) => resolve(code === 0 ? stdout.trim() : ""));
    child.on("error", () => resolve(""));
  });
}

async function ensureEvolutionBranch(cwd: string, branch: string): Promise<boolean> {
  const current = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (current === branch) return true;

  // 演化循环固定落在目标分支上，避免把自动提交混进用户当前分支。
  const exists = Boolean(await runGit(["show-ref", "--verify", `refs/heads/${branch}`], cwd));
  const checkoutArgs = exists ? ["checkout", branch] : ["checkout", "-b", branch];
  const result = await runCommand("git", checkoutArgs, cwd);
  return result.exitCode === 0;
}

async function hasWorkingTreeChanges(cwd: string): Promise<boolean> {
  const porcelain = await runGit(["status", "--porcelain"], cwd);
  return porcelain.length > 0;
}

async function commitRound(cwd: string, objective: string): Promise<boolean> {
  const changed = await hasWorkingTreeChanges(cwd);
  if (!changed) {
    console.error("No changes detected after successful round; skipping commit.");
    return true;
  }

  const latestArtifactPath = await getLatestRoundArtifactPath(cwd);
  const artifactId = latestArtifactPath ? basename(latestArtifactPath, ".json") : "unknown";
  const shortSha = (await runGit(["rev-parse", "--short", "HEAD"], cwd)) || "unknown";
  const commitMessage = `chore(evolve): round ${artifactId} objective=${objective} base=${shortSha}`;

  const addResult = await runCommand("git", ["add", "-A"], cwd);
  if (addResult.exitCode !== 0) return false;

  const commitResult = await runCommand("git", ["commit", "-m", commitMessage], cwd);
  return commitResult.exitCode === 0;
}

async function runSingleRoundAttempt(cwd: string, config: LoopConfig): Promise<boolean> {
  const timeoutMs = config.maxRoundDurationMinutes * 60 * 1000;
  const cycleResult = await runCommand(
    "node",
    ["dist/scripts/evolve-cycle.js", config.objective],
    cwd,
    timeoutMs
  );
  if (cycleResult.exitCode !== 0 || cycleResult.timedOut) {
    if (cycleResult.timedOut) {
      console.error(`Round attempt timed out after ${config.maxRoundDurationMinutes} minutes.`);
    }
    return false;
  }

  const gateResult = await runCommand("node", ["dist/scripts/benchmark-gate.js"], cwd);
  if (gateResult.exitCode !== 0) {
    return false;
  }

  // 只有 cycle 和 gate 都成功后才提交，保证每个 round commit 都对应一个完整通过的演化结果。
  return await commitRound(cwd, config.objective);
}

async function fetchOpenTaskIssues(): Promise<OpenTaskIssue[]> {
  return new Promise((resolve) => {
    const child = spawn(
      "gh",
      ["issue", "list", "--label", "v-ger-task", "--state", "open", "--json", "number,title", "--limit", "5"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        // gh not available or not authenticated → skip issues gracefully
        resolve([]);
        return;
      }
      try {
        resolve(JSON.parse(stdout) as OpenTaskIssue[]);
      } catch {
        resolve([]);
      }
    });
    child.on("error", () => resolve([]));
  });
}

async function resolveObjective(cwd: string, args: string[]): Promise<string> {
  const manual = parseStringArg(args, ["--objective"], "");
  if (manual) return manual;

  const [recentArtifacts, benchmarkReport, openIssues] = await Promise.all([
    loadRecentArtifacts(cwd),
    (async (): Promise<LastRoundReport | undefined> => {
      try {
        const raw = await readFile(getBenchmarkReportPath(cwd), "utf8");
        return JSON.parse(raw) as LastRoundReport;
      } catch {
        return undefined;
      }
    })(),
    fetchOpenTaskIssues()
  ]);

  if (openIssues.length > 0) {
    console.error(`[objective] found ${openIssues.length} open task issue(s): ${openIssues.map((i) => `#${i.number}`).join(", ")}`);
  }

  const objective = await generateObjective(cwd, recentArtifacts, benchmarkReport, openIssues);
  console.error(`[objective] generated: ${objective}`);
  return objective;
}

async function main() {
  const cwd = process.cwd();
  const args = process.argv.slice(2);
  const objective = await resolveObjective(cwd, args);
  const config = buildConfig(args, objective);
  const startedAt = Date.now();
  const deadline = startedAt + config.maxDurationMinutes * 60 * 1000;

  if (!(await ensureEvolutionBranch(cwd, config.targetBranch))) {
    console.error(`Failed to switch to evolution branch: ${config.targetBranch}`);
    process.exit(1);
  }

  console.error(
    `Evolution loop config: branch=${config.targetBranch} objective="${config.objective}" maxDuration=${config.maxDurationMinutes}m maxRound=${config.maxRoundDurationMinutes}m maxRetries=${config.maxRetriesPerRound} circuitBreaker=${config.circuitBreakerFailures} roundsLimit=${config.roundsLimit ?? "none"}`
  );

  let consecutiveFailures = 0;
  let roundIndex = 0;
  let successCount = 0;
  while (Date.now() < deadline) {
    if (config.roundsLimit && roundIndex >= config.roundsLimit) {
      break;
    }
    roundIndex += 1;

    const remainingMinutes = Math.max(0, Math.floor((deadline - Date.now()) / 60000));
    console.error(
      `Starting evolution round ${roundIndex}${config.roundsLimit ? `/${config.roundsLimit}` : ""} (remaining ~${remainingMinutes}m)`
    );

    let roundSuccess = false;
    for (let attempt = 1; attempt <= config.maxRetriesPerRound; attempt += 1) {
      console.error(`Round ${roundIndex}: attempt ${attempt}/${config.maxRetriesPerRound}`);
      const ok = await runSingleRoundAttempt(cwd, config);
      if (ok) {
        roundSuccess = true;
        break;
      }
    }

    if (!roundSuccess) {
      consecutiveFailures += 1;
      console.error(`Round ${roundIndex} failed. Consecutive failures: ${consecutiveFailures}`);
    } else {
      consecutiveFailures = 0;
      successCount += 1;
      console.error(`Round ${roundIndex} succeeded.`);
    }

    if (consecutiveFailures >= config.circuitBreakerFailures) {
      console.error(
        `Circuit breaker triggered: ${consecutiveFailures} consecutive failures (threshold=${config.circuitBreakerFailures}).`
      );
      process.exit(1);
    }
  }

  if (roundIndex === 0) {
    console.error("No round executed (duration budget too small or rounds limit is zero).");
    process.exit(1);
  }

  if (successCount === 0) {
    console.error(`All ${roundIndex} round(s) failed. No changes to push.`);
    process.exit(1);
  }

  console.error(`Evolution loop finished. ${successCount}/${roundIndex} round(s) succeeded.`);
}

void main();
