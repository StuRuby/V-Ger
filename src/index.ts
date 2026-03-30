import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";
import { buildStartupConfig, selectKimiModel } from "./config.js";

async function main() {
  // 启动阶段先把 CLI 参数、环境变量和 cwd 固化，避免后面初始化半途失败。
  let config: ReturnType<typeof buildStartupConfig>;
  try {
    config = buildStartupConfig(process.argv.slice(2), process.env, process.cwd());
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Startup configuration failed.");
    process.exit(1);
  }

  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);
  const available = await modelRegistry.getAvailable();
  const model = selectKimiModel(available);

  if (!model) {
    console.error("No available kimi-coding model found. Check KIMI_API_KEY and provider availability.");
    process.exit(1);
  }

  // 主入口只维护一次性的 agent session；更复杂的编排放到 scripts/ 里处理。
  const { session } = await createAgentSession({
    cwd: config.cwd,
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
    // 单独把工具调用打到 stderr，便于区分模型自然语言输出和执行轨迹。
    if (event.type === "tool_execution_start") {
      sawToolExecution = true;
      console.error(`[tool:start] ${event.toolName}`);
    }
  });

  try {
    await session.prompt(config.prompt);
    process.stdout.write("\n");
    if (sawToolExecution) {
      console.error("[tool] execution observed");
    }
  } catch (error) {
    console.error(`Agent run failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  } finally {
    session.dispose();
  }
}

void main();
