import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { normalize, resolve } from "node:path";

const ALLOWED_PREFIXES = ["src/", "tests/", "benchmarks/", "docs/"];
const DENIED_DIR_PREFIXES = [".pi/", "scripts/", ".github/"];
const DENIED_ROOT_FILES = new Set(["package.json", "package-lock.json", "tsconfig.json", "AGENTS.md"]);

function normalizeAbsolutePath(input: unknown, cwd: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  return normalize(resolve(cwd, raw)).replace(/\\/g, "/");
}

function normalizeRepoRoot(): string {
  return normalize(resolve(process.cwd())).replace(/\\/g, "/");
}

function toRepoRelativePath(absolutePath: string, repoRoot: string): string | undefined {
  if (!absolutePath) return undefined;
  if (absolutePath === repoRoot) return "";
  if (!absolutePath.startsWith(`${repoRoot}/`)) return undefined;
  return absolutePath.slice(repoRoot.length + 1);
}

function isDotEnvPath(relativePath: string): boolean {
  const filename = relativePath.split("/").at(-1) ?? "";
  return filename === ".env" || filename.startsWith(".env.");
}

function isPathAllowed(relativePath: string): boolean {
  if (!relativePath) return false;
  if (isDotEnvPath(relativePath)) return false;
  if (DENIED_ROOT_FILES.has(relativePath)) return false;
  if (DENIED_DIR_PREFIXES.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix))) {
    return false;
  }
  return ALLOWED_PREFIXES.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix));
}

export default function (pi: ExtensionAPI) {
  const repoRoot = normalizeRepoRoot();

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

    const absolutePath = normalizeAbsolutePath(event.input.path, ctx.cwd);
    const relativePath = toRepoRelativePath(absolutePath, repoRoot);

    if (!relativePath || !isPathAllowed(relativePath)) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Blocked write/edit outside writable scope: ${absolutePath}`, "warning");
      }
      return { block: true, reason: `Path "${absolutePath}" is outside writable scope policy.` };
    }

    return undefined;
  });
}
