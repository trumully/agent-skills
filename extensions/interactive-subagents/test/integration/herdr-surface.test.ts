/**
 * Integration tests for the Herdr pane surface.
 *
 * These tests exercise real pane creation, command submission, output reads,
 * focus preservation, and cleanup. They make no LLM calls.
 *
 * Run from a Herdr pane with `npm run test:surface`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  createTrackedSurfaceSplit,
  getFocusedSurface,
  getSurfaceTab,
  getTabLabel,
  untrackSurface,
  sendCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  echoCommand,
  writeFileCommand,
  sleep,
  uniqueId,
  trackTempFile,
  waitForFile,
  waitForScreen,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();
if (backends.length === 0) {
  console.log("⚠️  Herdr is not available — skipping Herdr surface integration tests");
  console.log("   Run this test from a Pi process inside a Herdr pane.");
}

for (const backend of backends) {
  describe(`herdr-surface [${backend}]`, { timeout: 60_000 }, () => {
    let env: TestEnv;

    beforeEach(() => {
      env = createTestEnv();
    });

    afterEach(() => {
      cleanupTestEnv(env);
    });

    it("preserves focus while creating and targeting a subagent pane", async () => {
      const focusedBefore = getFocusedSurface();
      assert.ok(focusedBefore, "expected a focused pane before test setup");

      const surface = createTrackedSurface(env, "focus-child");
      await sleep(700);
      assert.equal(getFocusedSurface(), focusedBefore);

      const marker = uniqueId();
      sendCommand(surface, echoCommand(`FOCUS_${marker}`));
      const screen = await waitForScreen(surface, new RegExp(`FOCUS_${marker}`), 20_000, 50);
      assert.ok(screen.includes(`FOCUS_${marker}`));
      assert.equal(getFocusedSurface(), focusedBefore);
    });

    it("keeps nested panes grouped in the top-level agent tab", () => {
      const mainFocus = getFocusedSurface();
      const parent = createTrackedSurface(env, "branch-root");
      const parentTab = getSurfaceTab(parent);
      assert.ok(parentTab, "expected the top-level subagent to get its own tab");
      assert.equal(getTabLabel(parentTab), "sub: branch-root — Herdr surface integration test");

      const child = createTrackedSurfaceSplit(env, "branch-child", "right", parent);
      assert.equal(getSurfaceTab(child), parentTab);
      assert.equal(getFocusedSurface(), mainFocus);
    });

    it("creates a pane, runs a command, reads output, and closes it", async () => {
      const surface = createTrackedSurface(env, "echo-test");
      await sleep(700);

      const marker = uniqueId();
      sendCommand(surface, echoCommand(`MARKER_${marker}`));
      const screen = await waitForScreen(surface, new RegExp(`MARKER_${marker}`), 15_000, 50);
      assert.ok(screen.includes(`MARKER_${marker}`));

      closeSurface(surface);
      untrackSurface(env, surface);
    });

    it("preserves shell-special characters in command output", async () => {
      const surface = createTrackedSurface(env, "escape-test");
      await sleep(700);

      const marker = uniqueId();
      sendCommand(surface, echoCommand(`SPEC_${marker}_$HOME_\"quotes\"_done`));
      const screen = await waitForScreen(surface, new RegExp(`SPEC_${marker}`), 15_000, 50);
      assert.ok(screen.includes(`SPEC_${marker}`));
      assert.ok(screen.includes("$HOME"), "expected $HOME to remain literal");
    });

    it("submits a long command without truncating it", async () => {
      const surface = createTrackedSurface(env, "long-cmd-test");
      await sleep(700);

      const marker = uniqueId();
      const longValue = "X".repeat(500);
      sendCommand(surface, echoCommand(`LONG_${marker}_${longValue}_END`));

      const screen = await waitForScreen(surface, new RegExp(`LONG_${marker}`), 15_000, 80);
      assert.ok(screen.includes(`LONG_${marker}`));
      assert.ok(screen.includes("_END"), "expected the full long output");
    });

    it("reads pane output asynchronously", async () => {
      const surface = createTrackedSurface(env, "async-read-test");
      await sleep(700);

      const marker = uniqueId();
      sendCommand(surface, echoCommand(`ASYNC_${marker}`));
      const screen = await waitForScreen(surface, new RegExp(`ASYNC_${marker}`), 15_000, 50);
      assert.ok(screen.includes(`ASYNC_${marker}`));
      assert.ok((await readScreenAsync(surface, 50)).includes(`ASYNC_${marker}`));
    });

    it("writes output to a file and verifies the command result", async () => {
      const surface = createTrackedSurface(env, "file-test");
      await sleep(700);

      const marker = uniqueId();
      const filePath = join(env.dir, `herdr-surface-${marker}.txt`);
      trackTempFile(env, filePath);
      sendCommand(surface, writeFileCommand(filePath, `FILE_${marker}`, `WRITTEN_${marker}`));

      await waitForScreen(surface, new RegExp(`WRITTEN_${marker}`), 15_000, 50);
      const content = await waitForFile(filePath, 15_000, new RegExp(`FILE_${marker}`));
      assert.ok(content.includes(`FILE_${marker}`));
    });
  });
}
