/**
 * Herdr control layer for subagent panes and agents.
 *
 * Herdr owns pane topology and recognized-agent lifecycle. This module keeps
 * all CLI calls, JSON parsing, and terminal reads in one place so the
 * orchestration code can stay focused on Pi sessions and subagent behavior.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;

interface HerdrEnvelope<T = any> {
  result?: T;
  error?: { code?: string; message?: string };
  [key: string]: any;
}

function herdrBinary(): string {
  return process.env.HERDR_BIN_PATH?.trim() || "herdr";
}

function errorText(error: any): string {
  const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : error?.stderr;
  const stdout = Buffer.isBuffer(error?.stdout) ? error.stdout.toString("utf8") : error?.stdout;
  const detail = String(stderr || stdout || error?.message || error).trim();
  try {
    const parsed = JSON.parse(detail);
    return parsed?.error?.message ?? parsed?.message ?? detail;
  } catch {
    return detail;
  }
}

function runHerdrSync(args: string[], timeout = 15_000): string {
  try {
    return execFileSync(herdrBinary(), args, {
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
  } catch (error: any) {
    throw new Error(`herdr ${args.join(" ")} failed: ${errorText(error)}`);
  }
}

async function runHerdr(args: string[], timeout = 35_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(herdrBinary(), args, {
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    return stdout;
  } catch (error: any) {
    throw new Error(`herdr ${args.join(" ")} failed: ${errorText(error)}`);
  }
}

function parseResponse<T>(stdout: string, command: string): HerdrEnvelope<T> {
  try {
    return JSON.parse(stdout.trim()) as HerdrEnvelope<T>;
  } catch (error: any) {
    throw new Error(`Could not parse herdr ${command} response: ${error?.message ?? String(error)}`);
  }
}

// ── Availability ──

let commandAvailable: boolean | undefined;

/** True only inside a Herdr pane with a working Herdr CLI on PATH. */
export function isHerdrAvailable(): boolean {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return false;
  if (commandAvailable !== undefined) return commandAvailable;
  try {
    execFileSync(herdrBinary(), ["--version"], {
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });
    commandAvailable = true;
  } catch {
    commandAvailable = false;
  }
  return commandAvailable;
}

export function herdrSetupHint(): string {
  return "Start Pi inside Herdr so HERDR_ENV and HERDR_PANE_ID are available.";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`Herdr is required for subagents. ${herdrSetupHint()}`);
  }
}

export function getHerdrIntegrationPath(agentConfigDir: string): string {
  return join(agentConfigDir, "extensions", "herdr-agent-state.ts");
}

// ── Pane topology and terminal primitives ──

export interface SurfaceOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface SubagentSurface {
  surface: string;
  /** Set only for a top-level subagent's owned tab. */
  tabId?: string;
}

/** Create a right split from the current Herdr pane without changing focus. */
export function createSurface(name: string, options?: SurfaceOptions): string {
  return createSurfaceSplit(name, "right", process.env.HERDR_PANE_ID, options);
}

/**
 * Create a branch surface: top-level agents get a labeled no-focus tab, while
 * nested agents split inside their parent's tab so the branch stays grouped.
 */
export function createSubagentSurface(
  name: string,
  task: string,
  options?: SurfaceOptions,
): SubagentSurface {
  if (process.env.PI_SUBAGENT_ID) {
    return { surface: createSurface(name, options) };
  }
  return createTabSurface(name, task, options);
}

/** Create an owned, labeled Herdr tab and return its root shell pane. */
export function createTabSurface(
  name: string,
  task: string,
  options?: SurfaceOptions,
): SubagentSurface {
  requireHerdr();
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (!workspaceId) throw new Error("Cannot create a subagent tab without HERDR_WORKSPACE_ID.");

  const labelPrefix = `sub: ${name.replace(/\s+/g, " ").trim()} — `;
  const taskText = task.replace(/\s+/g, " ").trim();
  const labelBudget = Math.max(0, 60 - labelPrefix.length);
  const taskLabel = taskText.length > labelBudget
    ? `${taskText.slice(0, Math.max(0, labelBudget - 1)).trimEnd()}…`
    : taskText;
  const label = `${labelPrefix}${taskLabel}`.slice(0, 60);

  const args = ["tab", "create", "--workspace", workspaceId, "--label", label, "--no-focus"];
  if (options?.cwd) args.push("--cwd", options.cwd);
  for (const [key, value] of Object.entries(options?.env ?? {})) {
    args.push("--env", `${key}=${value}`);
  }

  const response = parseResponse<{
    tab?: { tab_id?: string };
    root_pane?: { pane_id?: string };
  }>(runHerdrSync(args), "tab create");
  const tabId = response.result?.tab?.tab_id;
  const surface = response.result?.root_pane?.pane_id;
  if (typeof tabId !== "string" || !tabId || typeof surface !== "string" || !surface) {
    throw new Error(`herdr tab create returned no tab or root pane ID: ${JSON.stringify(response)}`);
  }
  return { surface, tabId };
}

/** Close a Herdr tab created for a top-level subagent. */
export function closeSubagentTab(tabId: string): void {
  requireHerdr();
  runHerdrSync(["tab", "close", tabId]);
}

/** Create a Herdr split. Herdr supports right/down split directions. */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  options?: SurfaceOptions,
): string {
  void name; // Herdr agent aliases, set by startAgent(), label the child agent.
  requireHerdr();
  if (direction === "left" || direction === "up") {
    throw new Error(`Herdr pane split does not support direction "${direction}"; use right or down.`);
  }

  const source = fromSurface ?? process.env.HERDR_PANE_ID;
  if (!source) throw new Error("Cannot split a Herdr pane without HERDR_PANE_ID.");

  const args = ["pane", "split", source, "--direction", direction, "--no-focus"];
  if (options?.cwd) args.push("--cwd", options.cwd);
  for (const [key, value] of Object.entries(options?.env ?? {})) {
    args.push("--env", `${key}=${value}`);
  }

  const response = parseResponse<{ pane?: { pane_id?: string } }>(
    runHerdrSync(args),
    "pane split",
  );
  const paneId = response.result?.pane?.pane_id;
  if (typeof paneId !== "string" || !paneId) {
    throw new Error(`herdr pane split returned no pane ID: ${JSON.stringify(response)}`);
  }
  return paneId;
}

/** Start a supported agent in a shell pane; args are passed directly to its CLI. */
export async function startAgent(
  name: string,
  kind: "pi" | "claude",
  paneId: string,
  args: string[],
): Promise<void> {
  requireHerdr();
  const commandArgs = ["agent", "start", name, "--kind", kind, "--pane", paneId, "--", ...args];
  const stdout = await runHerdr(commandArgs, 35_000);
  parseResponse(stdout, "agent start");
}

/** Submit a single prompt atomically to a recognized Herdr agent. */
export function promptAgent(target: string, prompt: string): void {
  requireHerdr();
  runHerdrSync(["agent", "prompt", target, prompt]);
}

/** Run a normal shell command in a pane (used by surface-level tests). */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  runHerdrSync(["pane", "run", surface, command]);
}

/** Read recent terminal output from a pane as plain text. */
export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  return runHerdrSync([
    "pane",
    "read",
    surface,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(Math.max(1, lines)),
  ]);
}

/** Async variant for watcher loops. */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  return runHerdr([
    "pane",
    "read",
    surface,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(Math.max(1, lines)),
  ]);
}

/** Close a Herdr pane. */
export function closeSurface(surface: string): void {
  requireHerdr();
  runHerdrSync(["pane", "close", surface]);
}

/** Whether Herdr still recognizes an agent in the subagent's pane. */
export async function isAgentRunning(surface: string): Promise<boolean> {
  requireHerdr();
  const stdout = await runHerdr(["agent", "list"]);
  const response = parseResponse<{ agents?: Array<{ pane_id?: string }> }>(stdout, "agent list");
  return response.result?.agents?.some((agent) => agent.pane_id === surface) ?? false;
}

// ── Exit polling ──

export interface PollResult {
  reason: "done" | "sentinel" | "agent-exit" | "error";
  /** Exit status when available. Agent disappearance does not expose an OS exit code. */
  exitCode: number;
  errorMessage?: string;
}

function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Wait for either the extension's error/completion sidecar, a Claude stop
 * sentinel, or Herdr to stop listing an agent in the child pane.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");

    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) return { reason: "sentinel", exitCode: 0 };
      } catch {}
    }

    let agentRunning = true;
    try {
      agentRunning = await isAgentRunning(surface);
    } catch {
      // A transient Herdr/server error must not be confused with agent exit.
    }

    if (!agentRunning) {
      // The process can disappear just before the final sidecar becomes visible.
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
      return { reason: "agent-exit", exitCode: 0 };
    }

    options.onTick?.(Math.floor((Date.now() - start) / 1000));
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
