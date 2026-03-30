import { describe, expect, it, vi } from "vitest";
import gitCheckpoint from "../.pi/extensions/git-checkpoint.js";
import permissionGate from "../.pi/extensions/permission-gate.js";
import protectedPaths from "../.pi/extensions/protected-paths.js";
import writableScope from "../.pi/extensions/writable-scope.js";

type ToolCallHandler = (event: any, ctx: any) => Promise<any> | any;
type EventHandler = (event: any, ctx: any) => Promise<any> | any;

function registerSingleToolCallHandler(registerExtension: (pi: any) => void): ToolCallHandler {
  let handler: ToolCallHandler | undefined;
  registerExtension({
    on(eventName: string, cb: ToolCallHandler) {
      if (eventName === "tool_call") {
        handler = cb;
      }
    }
  });

  if (!handler) {
    throw new Error("tool_call handler was not registered");
  }
  return handler;
}

function setupExtension(registerExtension: (pi: any) => void, execImpl?: (cmd: string, args: string[]) => Promise<any>) {
  // 这里用最小假 pi runtime 驱动 extension，测试重点是钩子行为，不是 Pi 本身。
  const handlers = new Map<string, EventHandler>();
  const execCalls: Array<{ cmd: string; args: string[] }> = [];

  registerExtension({
    on(eventName: string, cb: EventHandler) {
      handlers.set(eventName, cb);
    },
    async exec(cmd: string, args: string[]) {
      execCalls.push({ cmd, args });
      if (execImpl) return execImpl(cmd, args);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
  });

  return { handlers, execCalls };
}

function requireHandler(handlers: Map<string, EventHandler>, eventName: string): EventHandler {
  const handler = handlers.get(eventName);
  if (!handler) {
    throw new Error(`Expected handler "${eventName}" to be registered`);
  }
  return handler;
}

describe("protected-paths extension", () => {
  it("blocks write to .env", async () => {
    const handler = registerSingleToolCallHandler(protectedPaths as any);
    const result = await handler(
      { toolName: "write", input: { path: ".env" } },
      { cwd: "/repo", hasUI: false, ui: { notify() {} } }
    );
    expect(result?.block).toBe(true);
  });

  it("blocks alternate path forms for protected files", async () => {
    const handler = registerSingleToolCallHandler(protectedPaths as any);
    const cases = [
      { path: "./.env", cwd: "/repo" },
      { path: "../.env", cwd: "/repo/src" },
      { path: "/repo/.env", cwd: "/repo" },
      { path: "./tmp/ak.md", cwd: "/repo" }
    ];

    for (const testCase of cases) {
      const result = await handler(
        { toolName: "write", input: { path: testCase.path } },
        { cwd: testCase.cwd, hasUI: false, ui: { notify() {} } }
      );
      expect(result?.block).toBe(true);
    }
  });

  it("allows write to regular source files", async () => {
    const handler = registerSingleToolCallHandler(protectedPaths as any);
    const result = await handler(
      { toolName: "write", input: { path: "src/new-file.ts" } },
      { cwd: "/repo", hasUI: false, ui: { notify() {} } }
    );
    expect(result).toBeUndefined();
  });
});

describe("git-checkpoint extension", () => {
  it("creates checkpoint and restores when user confirms", async () => {
    const notify = vi.fn();
    const { handlers, execCalls } = setupExtension(gitCheckpoint as any, async (cmd, args) => {
      if (cmd === "git" && args[0] === "stash" && args[1] === "create") {
        return { stdout: "ref-123\n" };
      }
      return { stdout: "" };
    });

    await requireHandler(handlers, "tool_result")({}, { sessionManager: { getLeafEntry: () => ({ id: "entry-1" }) } });
    await requireHandler(handlers, "turn_start")({}, {});
    await requireHandler(handlers, "session_before_fork")(
      { entryId: "entry-1" },
      {
        hasUI: true,
        ui: {
          select: async () => "Yes, restore code to that point",
          notify
        }
      }
    );

    expect(execCalls).toEqual([
      { cmd: "git", args: ["stash", "create"] },
      { cmd: "git", args: ["stash", "apply", "ref-123"] }
    ]);
    expect(notify).toHaveBeenCalled();
  });

  it("does not restore in non-interactive mode", async () => {
    const { handlers, execCalls } = setupExtension(gitCheckpoint as any, async (_cmd, _args) => ({ stdout: "ref-abc\n" }));

    await requireHandler(handlers, "tool_result")({}, { sessionManager: { getLeafEntry: () => ({ id: "entry-2" }) } });
    await requireHandler(handlers, "turn_start")({}, {});
    await requireHandler(handlers, "session_before_fork")({ entryId: "entry-2" }, { hasUI: false, ui: {} });

    expect(execCalls).toEqual([{ cmd: "git", args: ["stash", "create"] }]);
  });

  it("clears checkpoints on agent_end", async () => {
    const { handlers, execCalls } = setupExtension(gitCheckpoint as any, async (_cmd, _args) => ({ stdout: "ref-clear\n" }));

    await requireHandler(handlers, "tool_result")({}, { sessionManager: { getLeafEntry: () => ({ id: "entry-3" }) } });
    await requireHandler(handlers, "turn_start")({}, {});
    await requireHandler(handlers, "agent_end")({}, {});
    await requireHandler(handlers, "session_before_fork")(
      { entryId: "entry-3" },
      { hasUI: true, ui: { select: async () => "Yes, restore code to that point", notify() {} } }
    );

    expect(execCalls).toEqual([{ cmd: "git", args: ["stash", "create"] }]);
  });
});

describe("permission-gate extension", () => {
  it("blocks dangerous bash command in non-interactive mode", async () => {
    const handler = registerSingleToolCallHandler(permissionGate as any);
    const result = await handler(
      { toolName: "bash", input: { command: "rm -rf tmp" } },
      { hasUI: false, ui: { select: async () => "No", notify() {} } }
    );
    expect(result?.block).toBe(true);
  });

  it("allows safe bash command", async () => {
    const handler = registerSingleToolCallHandler(permissionGate as any);
    const result = await handler(
      { toolName: "bash", input: { command: "ls -la" } },
      { hasUI: false, ui: { select: async () => "No", notify() {} } }
    );
    expect(result).toBeUndefined();
  });

  it("blocks rm -fr variant in non-interactive mode", async () => {
    const handler = registerSingleToolCallHandler(permissionGate as any);
    const result = await handler(
      { toolName: "bash", input: { command: "rm -fr tmp" } },
      { hasUI: false, ui: { select: async () => "No", notify() {} } }
    );
    expect(result?.block).toBe(true);
  });

  it("blocks bash redirection writes to protected files", async () => {
    const handler = registerSingleToolCallHandler(permissionGate as any);
    const result = await handler(
      { toolName: "bash", input: { command: "echo 'x' > .env" } },
      { hasUI: false, ui: { select: async () => "No", notify() {} } }
    );
    expect(result?.block).toBe(true);
  });

  it("blocks bash copy writes into harness paths", async () => {
    const handler = registerSingleToolCallHandler(permissionGate as any);
    const result = await handler(
      { toolName: "bash", input: { command: "cp src/index.ts .pi/extensions/index.ts" } },
      { hasUI: false, ui: { select: async () => "No", notify() {} } }
    );
    expect(result?.block).toBe(true);
  });

  it("allows read-only commands on protected paths", async () => {
    const handler = registerSingleToolCallHandler(permissionGate as any);
    const result = await handler(
      { toolName: "bash", input: { command: "cat .pi/extensions/permission-gate.ts" } },
      { hasUI: false, ui: { select: async () => "No", notify() {} } }
    );
    expect(result).toBeUndefined();
  });

  it("asks user in interactive mode and allows when user confirms", async () => {
    const handler = registerSingleToolCallHandler(permissionGate as any);
    const result = await handler(
      { toolName: "bash", input: { command: "git reset --hard HEAD~1" } },
      { hasUI: true, ui: { select: async () => "Yes", notify() {} } }
    );
    expect(result).toBeUndefined();
  });
});

describe("writable-scope extension", () => {
  const root = process.cwd();

  it("allows writes in source and test directories", async () => {
    const handler = registerSingleToolCallHandler(writableScope as any);
    const sourceResult = await handler(
      { toolName: "write", input: { path: "src/new-feature.ts" } },
      { cwd: root, hasUI: false, ui: { notify() {} } }
    );
    const testResult = await handler(
      { toolName: "edit", input: { path: "tests/new-feature.test.ts" } },
      { cwd: root, hasUI: false, ui: { notify() {} } }
    );

    expect(sourceResult).toBeUndefined();
    expect(testResult).toBeUndefined();
  });

  it("allows benchmark and docs writes in pragmatic mode", async () => {
    const handler = registerSingleToolCallHandler(writableScope as any);
    const benchmarkResult = await handler(
      { toolName: "write", input: { path: "benchmarks/tool-calling/v1/task.md" } },
      { cwd: root, hasUI: false, ui: { notify() {} } }
    );
    const docsResult = await handler(
      { toolName: "write", input: { path: "docs/notes.md" } },
      { cwd: root, hasUI: false, ui: { notify() {} } }
    );

    expect(benchmarkResult).toBeUndefined();
    expect(docsResult).toBeUndefined();
  });

  it("blocks writes to harness and config paths", async () => {
    const handler = registerSingleToolCallHandler(writableScope as any);
    const blockedPaths = [
      "scripts/evolve-loop.ts",
      ".pi/extensions/protected-paths.ts",
      ".github/workflows/evolve-auto.yml",
      "package.json",
      ".env"
    ];

    for (const path of blockedPaths) {
      const result = await handler(
        { toolName: "write", input: { path } },
        { cwd: root, hasUI: false, ui: { notify() {} } }
      );
      expect(result?.block).toBe(true);
    }
  });

  it("blocks path traversal to outside repository", async () => {
    const handler = registerSingleToolCallHandler(writableScope as any);
    const result = await handler(
      { toolName: "write", input: { path: "../../etc/passwd" } },
      { cwd: `${root}/src`, hasUI: false, ui: { notify() {} } }
    );
    expect(result?.block).toBe(true);
  });
});
