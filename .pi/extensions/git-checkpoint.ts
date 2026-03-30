import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type CheckpointRef = string;

export default function (pi: ExtensionAPI) {
  const checkpoints = new Map<string, CheckpointRef>();
  let currentEntryId: string | undefined;

  pi.on("tool_result", async (_event, ctx) => {
    const leaf = ctx.sessionManager.getLeafEntry();
    if (leaf?.id) {
      currentEntryId = leaf.id;
    }
  });

  pi.on("turn_start", async () => {
    // 用 git stash create 生成一次只读快照，不修改工作区，适合在每轮开始时做轻量 checkpoint。
    const { stdout } = await pi.exec("git", ["stash", "create"]);
    const ref = stdout.trim();
    if (ref && currentEntryId) {
      checkpoints.set(currentEntryId, ref);
    }
  });

  pi.on("session_before_fork", async (event, ctx) => {
    const ref = checkpoints.get(event.entryId);
    if (!ref) return;

    if (!ctx.hasUI) {
      return;
    }

    // 只有 fork 前才提供恢复入口，避免在正常单线程回合里意外回滚用户已有改动。
    const choice = await ctx.ui.select("Restore code state from checkpoint?", [
      "Yes, restore code to that point",
      "No, keep current code"
    ]);

    if (choice?.startsWith("Yes")) {
      await pi.exec("git", ["stash", "apply", ref]);
      ctx.ui.notify("Code restored to checkpoint", "info");
    }
  });

  pi.on("agent_end", async () => {
    checkpoints.clear();
  });
}
