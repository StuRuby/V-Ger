import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEvolvePrompt, createToolCallLogEntry, findMissingHarnessExtensions, parseEvolveObjective, REQUIRED_EXTENSIONS } from "../src/evolve-cycle.js";

const tempDirs: string[] = [];

describe("evolve cycle helpers", () => {
  afterEach(async () => {
    // Best-effort cleanup is intentionally omitted; temp dirs are OS-managed.
    tempDirs.length = 0;
  });

  it("parses objective from CLI args", () => {
    expect(parseEvolveObjective(["improve", "tests"])).toBe("improve tests");
    expect(parseEvolveObjective([])).toBeUndefined();
  });

  it("detects missing harness extensions", async () => {
    const root = await mkdtemp(join(tmpdir(), "v-ger-evolve-missing-"));
    tempDirs.push(root);
    await mkdir(join(root, ".pi", "extensions"), { recursive: true });

    const missing = await findMissingHarnessExtensions(root);
    expect(missing.length).toBe(REQUIRED_EXTENSIONS.length);
  });

  it("accepts when all harness extensions exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "v-ger-evolve-present-"));
    tempDirs.push(root);

    for (const relPath of REQUIRED_EXTENSIONS) {
      const absPath = join(root, relPath);
      await mkdir(join(absPath, ".."), { recursive: true });
      await writeFile(absPath, "export default {};");
    }

    const missing = await findMissingHarnessExtensions(root);
    expect(missing).toEqual([]);
  });

  it("builds prompt with objective and verification steps", () => {
    const prompt = buildEvolvePrompt("improve extension tests");
    expect(prompt).toContain("improve extension tests");
    expect(prompt).toContain("npm run typecheck");
    expect(prompt).toContain("npm test");
  });

  it("creates structured tool call log entry for blocked calls", () => {
    const entry = createToolCallLogEntry("write", "blocked", "Path is protected", { path: ".env" });
    expect(entry.toolName).toBe("write");
    expect(entry.action).toBe("blocked");
    expect(entry.reason).toBe("Path is protected");
    expect(entry.input).toEqual({ path: ".env" });
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("creates structured tool call log entry for allowed calls", () => {
    const entry = createToolCallLogEntry("read", "allowed");
    expect(entry.toolName).toBe("read");
    expect(entry.action).toBe("allowed");
    expect(entry.reason).toBeUndefined();
    expect(entry.input).toBeUndefined();
  });
});
