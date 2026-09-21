import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
	let tempRoot: string | undefined;

	afterEach(() => {
		vi.unstubAllEnvs();
		if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	});

	it("preserves max thinking and the requested model for both worker roles", () => {
		tempRoot = mkdtempSync(join(tmpdir(), "om-config-"));
		const agentDir = join(tempRoot, "agent");
		const cwd = join(tempRoot, "project");
		mkdirSync(agentDir);
		mkdirSync(cwd);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				"observational-memory": {
					models: {
						observer: { provider: "openai-codex", id: "gpt-5.6-luna", thinking: "max" },
						consolidator: { provider: "openai-codex", id: "gpt-5.6-luna", thinking: "max" },
					},
				},
			}),
		);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

		const config = loadConfig(cwd);

		expect(config.models).toEqual({
			observer: { provider: "openai-codex", id: "gpt-5.6-luna", thinking: "max" },
			consolidator: { provider: "openai-codex", id: "gpt-5.6-luna", thinking: "max" },
		});
	});
});
