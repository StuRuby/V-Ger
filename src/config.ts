/** Provider identifier for Kimi coding models */
export const KIMI_PROVIDER = "kimi-coding";

/**
 * Parses CLI arguments into a single prompt string.
 * @param args - Command line arguments array
 * @returns Joined prompt string, or undefined if empty
 */
export function parsePromptArgs(args: string[]): string | undefined {
  const prompt = args.join(" ").trim();
  return prompt.length > 0 ? prompt : undefined;
}

/**
 * Retrieves the Kimi API key from environment variables.
 * @param env - Environment variables object (defaults to process.env)
 * @returns The trimmed API key
 * @throws Error if KIMI_API_KEY is not set
 */
export function getKimiApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.KIMI_API_KEY?.trim();
  if (!key) {
    throw new Error("Missing KIMI_API_KEY. Set it in your environment or .env file.");
  }
  return key;
}

/**
 * Selects the first available Kimi model from a list of models.
 * @param models - Array of model objects with provider property
 * @returns The first matching Kimi model, or undefined if none found
 */
export function selectKimiModel<T extends { provider: string }>(models: T[]): T | undefined {
  // provider 选择策略刻意保持简单，保证所有入口对“只能用 kimi-coding”这条规则一致。
  return models.find((model) => model.provider === KIMI_PROVIDER);
}

/**
 * Builds the startup configuration for the agent session.
 * @param args - Command line arguments
 * @param env - Environment variables object (defaults to process.env)
 * @param cwd - Current working directory (defaults to process.cwd())
 * @returns Object containing prompt, apiKey, and cwd
 * @throws Error if prompt is empty or KIMI_API_KEY is missing
 */
export function buildStartupConfig(args: string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()) {
  const prompt = parsePromptArgs(args);
  if (!prompt) {
    throw new Error('Usage: node dist/src/index.js "your prompt"');
  }

  // 这里显式读取 apiKey，即使当前启动流程未直接传下去，也能在启动时尽早暴露配置错误。
  const apiKey = getKimiApiKey(env);
  return { prompt, apiKey, cwd };
}
