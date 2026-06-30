/**
 * Cognee tool wiring contract tests.
 *
 * Guards the `CogneeToolWiring` workpackage: `createTools` must auto-include
 * `retain`, `recall`, `reflect`, and (when autolearn is enabled) `learn` when
 * `memory.backend === "cognee"`, while `memory_edit` stays Mnemopi-only and is
 * excluded for Cognee. The availability predicate routes through
 * `isMemoryToolsBackend` from `./memory-ops`.
 */

import { describe, expect, it } from "bun:test";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

Bun.env.PI_PYTHON_SKIP_CHECK = "1";

function makeSession(
	settingsOverrides: Partial<Record<SettingPath, unknown>> = {},
	extra: Partial<ToolSession> = {},
): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(settingsOverrides),
		...extra,
	};
}

describe("Cognee tool wiring (createTools)", () => {
	describe("default tool set (no explicit toolNames)", () => {
		it("auto-includes retain, recall, and reflect for memory.backend === cognee", async () => {
			const tools = await createTools(makeSession({ "memory.backend": "cognee" }));
			const names = tools.map(t => t.name);

			expect(names).toContain("retain");
			expect(names).toContain("recall");
			expect(names).toContain("reflect");
		});

		it("auto-includes learn for cognee when autolearn.enabled is true", async () => {
			const tools = await createTools(
				makeSession({ "memory.backend": "cognee", "autolearn.enabled": true }),
			);
			expect(tools.map(t => t.name)).toContain("learn");
		});

		it("excludes learn for cognee when autolearn.enabled is false", async () => {
			const tools = await createTools(
				makeSession({ "memory.backend": "cognee", "autolearn.enabled": false }),
			);
			expect(tools.map(t => t.name)).not.toContain("learn");
		});

		it("excludes memory_edit for cognee (Mnemopi-only)", async () => {
			const tools = await createTools(makeSession({ "memory.backend": "cognee" }));
			expect(tools.map(t => t.name)).not.toContain("memory_edit");
		});

		it("offers none of the memory tools when memory.backend === off", async () => {
			const tools = await createTools(makeSession({ "memory.backend": "off" }));
			const names = tools.map(t => t.name);

			expect(names).not.toContain("retain");
			expect(names).not.toContain("recall");
			expect(names).not.toContain("reflect");
			expect(names).not.toContain("learn");
			expect(names).not.toContain("memory_edit");
		});
	});

	describe("explicit restricted toolNames list", () => {
		it("force-includes retain, recall, reflect into a restricted list for cognee", async () => {
			const tools = await createTools(makeSession({ "memory.backend": "cognee" }), ["read"]);
			const names = tools.map(t => t.name);

			expect(names).toContain("read");
			expect(names).toContain("retain");
			expect(names).toContain("recall");
			expect(names).toContain("reflect");
		});

		it("force-includes learn into a restricted list for cognee + autolearn", async () => {
			const tools = await createTools(
				makeSession({ "memory.backend": "cognee", "autolearn.enabled": true }),
				["read"],
			);
			expect(tools.map(t => t.name)).toContain("learn");
		});

		it("does not force-include memory_edit into a restricted list for cognee", async () => {
			const tools = await createTools(makeSession({ "memory.backend": "cognee" }), ["read"]);
			expect(tools.map(t => t.name)).not.toContain("memory_edit");
		});

		it("leaves a restricted list untouched for memory.backend === off", async () => {
			const tools = await createTools(makeSession({ "memory.backend": "off" }), ["read"]);
			const names = tools.map(t => t.name);

			expect(names).toContain("read");
			expect(names).not.toContain("retain");
			expect(names).not.toContain("recall");
			expect(names).not.toContain("reflect");
			expect(names).not.toContain("learn");
		});
	});

	describe("subagent gating (taskDepth > 0)", () => {
		it("still offers retain/recall/reflect to a cognee subagent (not depth-gated)", async () => {
			const tools = await createTools(
				makeSession({ "memory.backend": "cognee" }, { taskDepth: 1 }),
			);
			const names = tools.map(t => t.name);

			expect(names).toContain("retain");
			expect(names).toContain("recall");
			expect(names).toContain("reflect");
		});

		it("excludes learn from a cognee subagent even with autolearn enabled", async () => {
			const tools = await createTools(
				makeSession({ "memory.backend": "cognee", "autolearn.enabled": true }, { taskDepth: 1 }),
			);
			expect(tools.map(t => t.name)).not.toContain("learn");
		});
	});

	describe("regression: Hindsight and Mnemopi still wired", () => {
		it("auto-includes retain/recall/reflect for hindsight", async () => {
			const tools = await createTools(makeSession({ "memory.backend": "hindsight" }));
			const names = tools.map(t => t.name);

			expect(names).toContain("retain");
			expect(names).toContain("recall");
			expect(names).toContain("reflect");
		});

		it("auto-includes retain/recall/reflect for mnemopi and offers memory_edit", async () => {
			const tools = await createTools(makeSession({ "memory.backend": "mnemopi" }));
			const names = tools.map(t => t.name);

			expect(names).toContain("retain");
			expect(names).toContain("recall");
			expect(names).toContain("reflect");
			expect(names).toContain("memory_edit");
		});
	});
});
