import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { basename, normalize, resolve } from "node:path";

function canonicalizePath(input: unknown, cwd: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  return normalize(resolve(cwd, raw)).replace(/\\/g, "/");
}

function isProtectedPath(absolutePath: string, cwd: string): boolean {
  if (!absolutePath) return false;

  const normalizedCwd = normalize(resolve(cwd)).replace(/\\/g, "/");
  const relToCwd = absolutePath.startsWith(`${normalizedCwd}/`) ? absolutePath.slice(normalizedCwd.length + 1) : "";
  const filename = basename(absolutePath);
  const segments = absolutePath.split("/").filter(Boolean);

  // 这里保护的是“高风险路径”，即使 writable-scope 已经有限制，也要额外兜底拦截。
  if (
    filename === ".env" ||
    filename.startsWith(".env.") ||
    relToCwd === "tmp/ak.md" ||
    relToCwd === ".git" ||
    relToCwd.startsWith(".git/") ||
    relToCwd === "node_modules" ||
    relToCwd.startsWith("node_modules/") ||
    segments.includes(".git") ||
    segments.includes("node_modules")
  ) {
    return true;
  }

  return false;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") {
      return undefined;
    }

    const absolutePath = canonicalizePath(event.input.path, ctx.cwd);
    if (!isProtectedPath(absolutePath, ctx.cwd)) {
      return undefined;
    }

    // UI 通知只是给操作者可见性；真正阻断依赖返回 block 结果。
    if (ctx.hasUI) {
      ctx.ui.notify(`Blocked write/edit to protected path: ${absolutePath}`, "warning");
    }

    return { block: true, reason: `Path "${absolutePath}" is protected by V-Ger policy` };
  });
}
