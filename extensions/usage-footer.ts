import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectSubagentUsage, type SubagentUsageTotals } from "./interactive-subagents/pi-extension/subagents/usage.ts";

const STATUS_KEY = "subagent-usage";
const TIMER_KEY = Symbol.for("pi-usage-footer/refresh-timer");
const DEMO_USAGE: SubagentUsageTotals = {
  sessionCount: 2,
  runningCount: 1,
  inputTokens: 12_400,
  outputTokens: 1_850,
  cacheReadTokens: 3_100,
  cacheWriteTokens: 450,
  cost: 0.042,
};

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getUsageCost(usage: any): number {
  return finiteNumber(usage?.cost?.total);
}

function summarizeMainCost(entries: any[]): number {
  let cost = 0;
  for (const entry of entries) {
    if (entry.type === "usage") {
      cost += getUsageCost(entry.usage);
    } else if (entry.type === "message" && entry.message?.role === "assistant") {
      cost += getUsageCost(entry.message.usage);
    } else if (entry.type === "message" && entry.message?.role === "toolResult") {
      cost += getUsageCost(entry.message.usage);
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      cost += getUsageCost(entry.usage);
    }
  }
  return cost;
}

function addUsage(a: SubagentUsageTotals, b: SubagentUsageTotals): SubagentUsageTotals {
  return {
    sessionCount: a.sessionCount + b.sessionCount,
    runningCount: a.runningCount + b.runningCount,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cost: a.cost + b.cost,
  };
}

export default function usageFooter(pi: ExtensionAPI) {
  let demoStartedAt: number | null = null;
  let latestCtx: any = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  const previousTimer = (globalThis as any)[TIMER_KEY] as ReturnType<typeof setInterval> | undefined;
  if (previousTimer) clearInterval(previousTimer);
  (globalThis as any)[TIMER_KEY] = null;

  function refreshStatus(ctx: any): void {
    if (!ctx.hasUI || ctx.mode !== "tui" || process.env.PI_SUBAGENT_ID) return;

    const mainCost = summarizeMainCost(ctx.sessionManager.getEntries());
    const rootArtifactDir = join(
      ctx.sessionManager.getSessionDir(),
      "artifacts",
      ctx.sessionManager.getSessionId(),
    );
    const actualChildren = collectSubagentUsage(rootArtifactDir);
    const demoSeconds = demoStartedAt == null
      ? 0
      : Math.floor((Date.now() - demoStartedAt) / 1_000);
    const demoUsage = demoStartedAt == null
      ? null
      : { ...DEMO_USAGE, cost: DEMO_USAGE.cost + demoSeconds * 0.001 };
    const children = demoUsage ? addUsage(actualChildren, demoUsage) : actualChildren;
    const totalCost = mainCost + children.cost;
    const demoTag = demoUsage ? " SIM" : "";
    const text =
      `main $${mainCost.toFixed(3)} · ` +
      `subagents $${children.cost.toFixed(3)} (${children.runningCount} running / ${children.sessionCount} total) · ` +
      `total $${totalCost.toFixed(3)}${demoTag}`;

    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", text));
  }

  function startPolling(ctx: any): void {
    if (!ctx.hasUI || ctx.mode !== "tui" || process.env.PI_SUBAGENT_ID) return;
    if (!refreshTimer) ctx.ui.setFooter(undefined);
    latestCtx = ctx;
    refreshStatus(ctx);
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (latestCtx) refreshStatus(latestCtx);
    }, 1_000);
    (globalThis as any)[TIMER_KEY] = refreshTimer;
  }

  function stopPolling(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    if ((globalThis as any)[TIMER_KEY]) (globalThis as any)[TIMER_KEY] = null;
    if (latestCtx?.hasUI) latestCtx.ui.setStatus(STATUS_KEY, undefined);
    latestCtx = null;
  }

  pi.on("session_start", (_event, ctx) => {
    stopPolling();
    startPolling(ctx);
  });
  pi.on("session_shutdown", () => {
    stopPolling();
    demoStartedAt = null;
  });

  pi.registerCommand("usage-demo", {
    description: "Toggle simulated subagent usage in the footer without making model calls",
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (requested === "on") demoStartedAt = Date.now();
      else if (requested === "off") demoStartedAt = null;
      else demoStartedAt = demoStartedAt == null ? Date.now() : null;

      startPolling(ctx);
      refreshStatus(ctx);
      ctx.ui.notify(
        demoStartedAt == null
          ? "Usage footer demo off. No usage data was changed."
          : "Usage footer demo on. Two simulated nested agents are shown, one running; only their mock cost ticks. No model calls were made.",
        "info",
      );
    },
  });
}
