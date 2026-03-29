import { spawn } from "node:child_process";
import { basename } from "node:path";
import { getLatestRoundArtifactPath } from "../src/round-artifact.js";

type LoopConfig = {
  objective: string;
  rounds: number;
  targetBranch: string;
  maxRoundDurationMinutes: number;
  maxRetriesPerRound: number;
  circuitBreakerFailures: number;
};

type CommandRunResult = {
  exitCode: number;
  timedOut: boolean;
};

const DEFAULT_OBJECTIVE = "improve tool-calling reliability without regressing existing capabilities";
const DEFAULT_ROUNDS = 1;
const DEFAULT_TARGET_BRANCH = "evolve/auto";
const DEFAULT_MAX_ROUND_DURATION_MINUTES = 120;
const DEFAULT_MAX_RETRIES_PER_ROUND = 5;
const DEFAULT_CIRCUIT_BREAKER_FAILURES = 5;

function parseNumberArg(args: string[], key: string, fallback: number): number {
  const index = args.indexOf(key);
  if (index === -1) return fallback;
  const raw = args[index + 1];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseStringArg(args: string[], key: string, fallback: string): string {
  const index = args.indexOf(key);
  if (index === -1) return fallback;
  const raw = args[index + 1]?.trim();
  return raw ? raw : fallback;
}

function buildConfig(args: string[]): LoopConfig {
  return {
    objective: parseStringArg(args, "--objective", DEFAULT_OBJECTIVE),
    rounds: parseNumberArg(args, "--rounds", DEFAULT_ROUNDS),
    targetBranch: parseStringArg(args, "--branch", DEFAULT_TARGET_BRANCH),
    maxRoundDurationMinutes: parseNumberArg(args, "--max-round-minutes", DEFAULT_MAX_ROUND_DURATION_MINUTES),
    maxRetriesPerRound: parseNumberArg(args, "--max-retries", DEFAULT_MAX_RETRIES_PER_ROUND),
    circuitBreakerFailures: parseNumberArg(args, "--circuit-breaker", DEFAULT_CIRCUIT_BREAKER_FAILURES)
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

  return await commitRound(cwd, config.objective);
}

async function main() {
  const cwd = process.cwd();
  const config = buildConfig(process.argv.slice(2));

  if (!(await ensureEvolutionBranch(cwd, config.targetBranch))) {
    console.error(`Failed to switch to evolution branch: ${config.targetBranch}`);
    process.exit(1);
  }

  let consecutiveFailures = 0;
  for (let roundIndex = 1; roundIndex <= config.rounds; roundIndex += 1) {
    console.error(`Starting evolution round ${roundIndex}/${config.rounds}`);

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
      console.error(`Round ${roundIndex} succeeded.`);
    }

    if (consecutiveFailures >= config.circuitBreakerFailures) {
      console.error(
        `Circuit breaker triggered: ${consecutiveFailures} consecutive failures (threshold=${config.circuitBreakerFailures}).`
      );
      process.exit(1);
    }
  }

  console.error("Evolution loop finished.");
}

void main();
