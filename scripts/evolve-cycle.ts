import { spawn } from "node:child_process";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";
import { getKimiApiKey, selectKimiModel } from "../src/config.js";
import {
  buildEvolvePrompt,
  DEFAULT_EVOLVE_OBJECTIVE,
  findMissingHarnessExtensions,
  parseEvolveObjective
} from "../src/evolve-cycle.js";

type CheckCommand = {
  cmd: string;
  args: string[];
};

const POST_CHECKS: CheckCommand[] = [
  { cmd: "npm", args: ["run", "typecheck"] },
  { cmd: "npm", args: ["test"] }
];

function runCommand(command: CheckCommand, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command.cmd, command.args, { cwd, stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function runPostChecks(cwd: string): Promise<boolean> {
  for (const command of POST_CHECKS) {
    const code = await runCommand(command, cwd);
    if (code !== 0) {
      return false;
    }
  }
  return true;
}

async function main() {
  const cwd = process.cwd();

  try {
    getKimiApiKey(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Missing KIMI_API_KEY");
    process.exit(1);
  }

  const missingExtensions = await findMissingHarnessExtensions(cwd);
  if (missingExtensions.length > 0) {
    console.error("Harness extension gate failed. Missing required extensions:");
    for (const extension of missingExtensions) {
      console.error(`- ${extension}`);
    }
    process.exit(1);
  }

  const objective = parseEvolveObjective(process.argv.slice(2)) ?? DEFAULT_EVOLVE_OBJECTIVE;
  const prompt = buildEvolvePrompt(objective);

  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);
  const availableModels = await modelRegistry.getAvailable();
  const model = selectKimiModel(availableModels);

  if (!model) {
    console.error("No available kimi-coding model found. Check KIMI_API_KEY and provider availability.");
    process.exit(1);
  }

  const { session } = await createAgentSession({
    cwd,
    model,
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry
  });

  let sawToolExecution = false;
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "tool_execution_start") {
      sawToolExecution = true;
      console.error(`[tool:start] ${event.toolName}`);
    }
  });

  try {
    await session.prompt(prompt);
    process.stdout.write("\n");
  } catch (error) {
    console.error(`Evolution cycle failed during agent run: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  } finally {
    session.dispose();
  }

  const checksPassed = await runPostChecks(cwd);
  if (!checksPassed) {
    console.error("Post-check gate failed.");
    process.exit(1);
  }

  if (!sawToolExecution) {
    console.error("Warning: No tool execution observed during this evolution cycle.");
  }

  console.error("Manual evolve cycle completed.");
}

void main();
