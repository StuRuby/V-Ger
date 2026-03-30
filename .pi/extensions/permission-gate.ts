import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { hasCommandReferenceToProtectedPath } from "../../src/writable-policy.js";

const DANGEROUS_COMMAND_PATTERNS = [
  /\bsudo\b/i,
  /\b(chmod|chown)\b.*\b777\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-f[d|x]*\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash)\b/i
];

function isRecursiveRm(command: string): boolean {
  if (!/\brm\b/i.test(command)) return false;
  return /\s--recursive\b/i.test(command) || /\s-[a-z]*r[a-z]*\b/i.test(command);
}

function isProtectedPathWriteAttempt(command: string): boolean {
  if (!hasCommandReferenceToProtectedPath(command)) return false;

  // 先确认命令触碰了受保护路径，再识别它是否真的带有写入/破坏语义，减少误拦截只读命令。
  const hasRedirection = /(^|[^<])>>?/.test(command);
  const hasExplicitWriteCommand =
    /\b(rm|mv|cp|touch|mkdir|truncate|install|ln)\b/i.test(command) ||
    /\bsed\s+-i\b/i.test(command) ||
    /\bperl\s+-i\b/i.test(command) ||
    /\btee\b/i.test(command);

  return hasRedirection || hasExplicitWriteCommand;
}

function isDangerousCommand(command: unknown): boolean {
  const normalized = String(command ?? "").trim();
  if (!normalized) return false;
  return (
    isRecursiveRm(normalized) ||
    isProtectedPathWriteAttempt(normalized) ||
    DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = String(event.input.command ?? "");
    if (!isDangerousCommand(command)) return undefined;

    const reason = isProtectedPathWriteAttempt(command)
      ? "Bash command attempts to write protected harness/config paths."
      : "Dangerous bash command blocked in non-interactive mode.";

    if (!ctx.hasUI) {
      return { block: true, reason };
    }

    // 交互模式下把最终决定权交给操作者，避免把所有高风险维护操作都彻底封死。
    const choice = await ctx.ui.select(`Dangerous command detected:\n\n${command}\n\nReason: ${reason}\n\nAllow this command?`, [
      "Yes",
      "No"
    ]);
    if (choice !== "Yes") {
      return { block: true, reason: "Dangerous bash command blocked by user choice." };
    }

    return undefined;
  });
}
