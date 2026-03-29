import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

function isDangerousCommand(command: unknown): boolean {
  const normalized = String(command ?? "").trim();
  if (!normalized) return false;
  return isRecursiveRm(normalized) || DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = String(event.input.command ?? "");
    if (!isDangerousCommand(command)) return undefined;

    if (!ctx.hasUI) {
      return { block: true, reason: "Dangerous bash command blocked in non-interactive mode." };
    }

    const choice = await ctx.ui.select(`Dangerous command detected:\n\n${command}\n\nAllow this command?`, [
      "Yes",
      "No"
    ]);
    if (choice !== "Yes") {
      return { block: true, reason: "Dangerous bash command blocked by user choice." };
    }

    return undefined;
  });
}
