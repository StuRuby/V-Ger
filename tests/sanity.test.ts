import { describe, expect, it } from "vitest";
import { buildStartupConfig, getKimiApiKey, parsePromptArgs, selectKimiModel } from "../src/config.js";

describe("config bootstrap", () => {
  it("parses one-shot CLI prompt", () => {
    expect(parsePromptArgs(["list", "files"])).toBe("list files");
  });

  it("returns undefined for empty prompt args", () => {
    expect(parsePromptArgs([])).toBeUndefined();
    expect(parsePromptArgs(["", "   "])).toBeUndefined();
  });

  it("fails fast when KIMI_API_KEY is missing", () => {
    expect(() => getKimiApiKey({})).toThrow("Missing KIMI_API_KEY");
  });

  it("builds startup config with prompt, key and cwd", () => {
    const config = buildStartupConfig(["hello"], { KIMI_API_KEY: "test-key" }, "/tmp/v-ger");
    expect(config.prompt).toBe("hello");
    expect(config.apiKey).toBe("test-key");
    expect(config.cwd).toBe("/tmp/v-ger");
  });

  it("selects kimi-coding model from available models", () => {
    // 这里直接覆盖 provider 过滤规则，保证入口不会误选到其他供应商模型。
    const model = selectKimiModel([
      { provider: "openai", id: "gpt-4o" },
      { provider: "kimi-coding", id: "kimi-k2" }
    ]);
    expect(model).toEqual({ provider: "kimi-coding", id: "kimi-k2" });
  });
});
