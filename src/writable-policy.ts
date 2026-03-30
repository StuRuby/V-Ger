import { normalize, resolve } from "node:path";

export const WRITABLE_ALLOWED_PREFIXES = ["src/", "tests/", "benchmarks/", "docs/"];
export const WRITABLE_DENIED_DIR_PREFIXES = [".pi/", "scripts/", ".github/"];
export const WRITABLE_DENIED_ROOT_FILES = new Set(["package.json", "package-lock.json", "tsconfig.json", "AGENTS.md"]);

function toUnixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function normalizeAbsolutePath(input: unknown, cwd: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  return toUnixPath(normalize(resolve(cwd, raw)));
}

export function normalizeRepoRoot(path: string): string {
  return toUnixPath(normalize(resolve(path)));
}

export function toRepoRelativePath(absolutePath: string, repoRoot: string): string | undefined {
  if (!absolutePath) return undefined;
  const normalizedRoot = normalizeRepoRoot(repoRoot);
  if (absolutePath === normalizedRoot) return "";
  if (!absolutePath.startsWith(`${normalizedRoot}/`)) return undefined;
  return absolutePath.slice(normalizedRoot.length + 1);
}

export function isDotEnvPath(relativePath: string): boolean {
  const filename = relativePath.split("/").at(-1) ?? "";
  return filename === ".env" || filename.startsWith(".env.");
}

export function isWritablePathAllowed(relativePath: string): boolean {
  if (!relativePath) return false;
  if (isDotEnvPath(relativePath)) return false;
  if (WRITABLE_DENIED_ROOT_FILES.has(relativePath)) return false;
  if (
    WRITABLE_DENIED_DIR_PREFIXES.some(
      (prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix)
    )
  ) {
    return false;
  }
  return WRITABLE_ALLOWED_PREFIXES.some(
    (prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix)
  );
}

export function hasCommandReferenceToProtectedPath(command: string): boolean {
  const patterns = [
    /(^|[\s"'`])\.pi(\/|[\s"'`]|$)/i,
    /(^|[\s"'`])scripts(\/|[\s"'`]|$)/i,
    /(^|[\s"'`])\.github(\/|[\s"'`]|$)/i,
    /(^|[\s"'`])package\.json([\s"'`]|$)/i,
    /(^|[\s"'`])package-lock\.json([\s"'`]|$)/i,
    /(^|[\s"'`])tsconfig\.json([\s"'`]|$)/i,
    /(^|[\s"'`])AGENTS\.md([\s"'`]|$)/i,
    /(^|[\s"'`])\.env([.\w-]*)?([\s"'`]|$)/i
  ];
  return patterns.some((pattern) => pattern.test(command));
}
