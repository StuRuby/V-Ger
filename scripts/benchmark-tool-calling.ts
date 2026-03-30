import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawn } from "node:child_process";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";
import {
  type BenchmarkTaskResult,
  calculateBenchmarkMetrics,
  getBenchmarkReportPath,
  loadBenchmarkTasks,
  selectBenchmarkTasks,
  validateBenchmarkMetrics
} from "../src/benchmark.js";
import { getKimiApiKey, selectKimiModel } from "../src/config.js";
import { isWritablePathAllowed, normalizeRepoRoot, toRepoRelativePath } from "../src/writable-policy.js";

const TASK_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes per task

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function runCommand(cmd: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: String(error) }));
  });
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const result = await runCommand("git", args, cwd);
  return result.code === 0 ? result.stdout.trim() : "";
}

/** Returns a map of relative-path → status-code from git status --porcelain */
async function getGitPorcelain(cwd: string): Promise<Map<string, string>> {
  const raw = await runGit(["status", "--porcelain", "-u"], cwd);
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const statusCode = line.substring(0, 2).trim();
    const filePath = line.substring(3).trim();
    map.set(filePath, statusCode);
  }
  return map;
}

function parseSampleArg(args: string[], keys: string[], fallback: number): number {
  for (const key of keys) {
    const idx = args.indexOf(key);
    if (idx !== -1 && args[idx + 1]) {
      const val = parseInt(args[idx + 1], 10);
      if (!isNaN(val) && val >= 0) return val;
    }
  }
  return fallback;
}

/** Copy a file from source to destination, creating parent dirs as needed */
function copyFile(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

/** Apply the main repo's dirty state into the worktree directory */
async function applyDirtyState(mainCwd: string, worktree: string, dirtyFiles: Map<string, string>): Promise<void> {
  for (const [filePath, statusCode] of dirtyFiles) {
    const srcPath = join(mainCwd, filePath);
    const destPath = join(worktree, filePath);

    if (statusCode === "D") {
      // Deleted in main → remove from worktree too
      if (existsSync(destPath)) {
        rmSync(destPath);
      }
    } else {
      // Modified, added, or untracked → copy to worktree
      if (existsSync(srcPath)) {
        copyFile(srcPath, destPath);
      }
    }
  }
}

/** Reset worktree writable dirs to HEAD and remove untracked files in those dirs */
async function resetWorktree(worktree: string): Promise<void> {
  await runGit(["checkout", "--", "src", "tests", "benchmarks", "docs"], worktree);
  await runGit(["clean", "-fd", "src", "tests", "benchmarks", "docs"], worktree);
}

/** Get files that changed between two git status snapshots */
function getTaskChangedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [filePath, afterStatus] of after) {
    const beforeStatus = before.get(filePath);
    if (beforeStatus !== afterStatus) {
      changed.push(filePath);
    }
  }
  // Also files that existed before but are now gone (deleted by task)
  for (const filePath of before.keys()) {
    if (!after.has(filePath)) {
      changed.push(filePath);
    }
  }
  return changed;
}

async function main(): Promise<void> {
  const mainCwd = process.cwd();
  const args = process.argv.slice(2);
  const sampleDev = parseSampleArg(args, ["--sample-dev"], 5);
  const sampleHoldout = parseSampleArg(args, ["--sample-holdout"], 2);

  console.error(`[benchmark] starting: sample-dev=${sampleDev} sample-holdout=${sampleHoldout}`);

  // 1. Load and select tasks
  const allTasks = await loadBenchmarkTasks(mainCwd);
  const tasks = selectBenchmarkTasks(allTasks, sampleDev, sampleHoldout);
  console.error(`[benchmark] selected ${tasks.length} tasks (${sampleDev} dev + ${sampleHoldout} holdout)`);

  // 2. Validate Kimi API key
  try {
    getKimiApiKey(process.env);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Missing KIMI_API_KEY";
    console.error(`[benchmark] ${msg}`);
    process.exit(1);
  }

  // 3. Create git worktree
  const worktreeDir = join(tmpdir(), `v-ger-bench-${Date.now()}`);
  console.error(`[benchmark] creating worktree at ${worktreeDir}`);

  const worktreeResult = await runCommand("git", ["worktree", "add", "--detach", worktreeDir, "HEAD"], mainCwd);
  if (worktreeResult.code !== 0) {
    console.error(`[benchmark] failed to create worktree: ${worktreeResult.stderr}`);
    process.exit(1);
  }

  // 4. Symlink node_modules into worktree
  const nodeModulesSrc = join(mainCwd, "node_modules");
  const nodeModulesDst = join(worktreeDir, "node_modules");
  if (existsSync(nodeModulesSrc) && !existsSync(nodeModulesDst)) {
    symlinkSync(nodeModulesSrc, nodeModulesDst);
  }

  // 5. Copy .env if exists
  const envSrc = join(mainCwd, ".env");
  const envDst = join(worktreeDir, ".env");
  if (existsSync(envSrc) && !existsSync(envDst)) {
    copyFileSync(envSrc, envDst);
  }

  // 6. Record main repo dirty state and apply to worktree
  const dirtyFiles = await getGitPorcelain(mainCwd);
  await applyDirtyState(mainCwd, worktreeDir, dirtyFiles);
  console.error(`[benchmark] applied ${dirtyFiles.size} dirty file(s) to worktree`);

  // 7. Setup auth for agent sessions
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);
  const availableModels = await modelRegistry.getAvailable();
  const model = selectKimiModel(availableModels);
  if (!model) {
    console.error("[benchmark] no kimi-coding model available — check KIMI_API_KEY");
    await runCommand("git", ["worktree", "remove", "--force", worktreeDir], mainCwd);
    process.exit(1);
  }

  // 8. Run each task
  const results: BenchmarkTaskResult[] = [];
  const repoRoot = normalizeRepoRoot(worktreeDir);

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    console.error(`[benchmark] task ${i + 1}/${tasks.length}: ${task.id}`);

    const preBenchmarkSnapshot = await getGitPorcelain(worktreeDir);
    const toolsUsed = new Set<string>();
    let sessionError = false;
    let timedOut = false;

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, TASK_TIMEOUT_MS);

    try {
      const { session } = await createAgentSession({
        cwd: worktreeDir,
        model,
        sessionManager: SessionManager.inMemory(),
        authStorage,
        modelRegistry
      });

      session.subscribe((event) => {
        if (event.type === "tool_execution_start") {
          toolsUsed.add(event.toolName);
          console.error(`  [tool:start] ${event.toolName}`);
        }
      });

      try {
        await session.prompt(task.prompt);
        process.stdout.write("\n");
      } catch (error) {
        if (timedOut) {
          console.error(`  [timeout] task exceeded ${TASK_TIMEOUT_MS / 1000}s`);
        } else {
          sessionError = true;
          console.error(`  [error] ${error instanceof Error ? error.message : "unknown"}`);
        }
      } finally {
        session.dispose();
      }
    } catch (outerError) {
      sessionError = true;
      console.error(`  [session-setup-error] ${outerError instanceof Error ? outerError.message : "unknown"}`);
    } finally {
      clearTimeout(timeoutHandle);
    }

    // Determine results for this task
    const postSnapshot = await getGitPorcelain(worktreeDir);
    const changedFiles = getTaskChangedFiles(preBenchmarkSnapshot, postSnapshot);

    const safetyViolation = changedFiles.some((filePath) => {
      const relPath = toRepoRelativePath(join(worktreeDir, filePath), repoRoot);
      return relPath !== undefined && !isWritablePathAllowed(relPath);
    });

    const toolSuccess = task.requiredTools.every((t) => toolsUsed.has(t));
    const taskSuccess = !timedOut && !sessionError && toolSuccess;

    console.error(`  toolsUsed=[${[...toolsUsed].join(",")}] toolSuccess=${toolSuccess} taskSuccess=${taskSuccess} safetyViolation=${safetyViolation}`);

    results.push({
      id: task.id,
      split: task.split,
      category: task.category,
      toolSuccess,
      taskSuccess,
      safetyViolation
    });

    // Reset worktree for next task
    if (i < tasks.length - 1) {
      await resetWorktree(worktreeDir);
      await applyDirtyState(mainCwd, worktreeDir, dirtyFiles);
    }
  }

  // 9. Calculate and validate metrics
  const metrics = calculateBenchmarkMetrics(results);
  const metricErrors = validateBenchmarkMetrics(metrics);
  const passed = metricErrors.length === 0 && results.every((r) => !r.safetyViolation);

  console.error(`[benchmark] metrics: toolCallSuccessRate=${metrics.toolCallSuccessRate} taskSuccessRate=${metrics.taskSuccessRate} safetyViolations=${metrics.safetyViolations} devHoldoutGap=${metrics.devHoldoutGap}`);
  if (metricErrors.length > 0) {
    console.error("[benchmark] metric errors:");
    for (const err of metricErrors) console.error(`  - ${err}`);
  }

  // 10. Cleanup worktree
  console.error(`[benchmark] removing worktree ${worktreeDir}`);
  await runCommand("git", ["worktree", "remove", "--force", worktreeDir], mainCwd);

  // 11. Write report to main repo
  const reportPath = getBenchmarkReportPath(mainCwd);
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    sampleDev,
    sampleHoldout,
    totalTasks: tasks.length,
    tasks: results,
    metrics,
    metricErrors,
    passed
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.error(`[benchmark] report written to ${reportPath}`);

  process.exit(passed ? 0 : 1);
}

void main();
