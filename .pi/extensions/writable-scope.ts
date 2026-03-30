import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  isWritablePathAllowed,
  normalizeAbsolutePath,
  normalizeRepoRoot,
  toRepoRelativePath
} from "../../src/writable-policy.js";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

    const absolutePath = normalizeAbsolutePath(event.input.path, ctx.cwd);
    const repoRoot = normalizeRepoRoot(ctx.cwd);
    const relativePath = toRepoRelativePath(absolutePath, repoRoot);

    if (!relativePath || !isWritablePathAllowed(relativePath)) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Blocked write/edit outside writable scope: ${absolutePath}`, "warning");
      }
      return { block: true, reason: `Path "${absolutePath}" is outside writable scope policy.` };
    }

    return undefined;
  });
}
