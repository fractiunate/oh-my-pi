/**
 * TUI `/memory` command-controller tests for a Cognee-shaped backend.
 *
 * Proves `CommandController.handleMemoryCommand` routes `stats/diagnose/clear/
 * reset/enqueue/rebuild` through the active `MemoryBackend` hooks and uses
 * truthful non-destructive Cognee wording only when `backend.id === "cognee"`.
 *
 * No live Cognee server is required: `resolveMemoryBackend` is spied to return
 * a fake Cognee `MemoryBackend`. The `"cognee"` literal is cast locally because
 * `CogneeBackendAdapter` (which owns adding `"cognee"` to `MemoryBackendId`) is
 * not present in this worktree; production types are not altered here.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackend from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

/**
 * Plan-authorized local widening: `MemoryBackendId` does not yet include
 * `"cognee"` in this worktree (owned by CogneeBackendAdapter). This const
 * stands in for that future union member; no production type is altered.
 */
const COGNEE_ID = "cognee" as never;

interface FakeCogneeHooks {
	stats?: (agentDir: string, cwd: string, session?: unknown) => Promise<string | undefined>;
	diagnose?: (agentDir: string, cwd: string, session?: unknown) => Promise<string | undefined>;
	clear?: (agentDir: string, cwd: string, session?: unknown) => Promise<void>;
	enqueue?: (agentDir: string, cwd: string, session?: unknown) => Promise<void>;
	buildDeveloperInstructions?: (
		agentDir: string,
		settings: Settings,
		session?: unknown,
	) => Promise<string | undefined>;
}

function createFakeCogneeBackend(hooks: FakeCogneeHooks = {}): MemoryBackend {
	const backend = {
		id: COGNEE_ID,
		async start() {},
		async buildDeveloperInstructions(agentDir: string, settings: Settings, session?: unknown) {
			return hooks.buildDeveloperInstructions?.(agentDir, settings, session);
		},
		async clear(agentDir: string, cwd: string, session?: unknown) {
			await hooks.clear?.(agentDir, cwd, session);
		},
		async enqueue(agentDir: string, cwd: string, session?: unknown) {
			await hooks.enqueue?.(agentDir, cwd, session);
		},
		async stats(agentDir: string, cwd: string, session?: unknown) {
			return hooks.stats?.(agentDir, cwd, session);
		},
		async diagnose(agentDir: string, cwd: string, session?: unknown) {
			return hooks.diagnose?.(agentDir, cwd, session);
		},
	};
	return backend as unknown as MemoryBackend;
}

function createMemoryContext(settings: Settings) {
	const session = {
		settings,
		refreshBaseSystemPrompt: vi.fn(async () => {}),
	};
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const showError = vi.fn();
	const present = vi.fn();
	const ctx = {
		settings,
		session,
		sessionManager: { getCwd: () => "/tmp/project" },
		showStatus,
		showWarning,
		showError,
		present,
	} as unknown as InteractiveModeContext;
	return { ctx, session, showStatus, showWarning, showError, present };
}

describe("CommandController /memory — Cognee backend", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	afterAll(async () => {
		const theme = await getThemeByName("dark");
		if (theme) setThemeInstance(theme);
	});

	it("/memory stats renders backend-provided markdown through ctx.present", async () => {
		const settings = Settings.isolated({ "memory.backend": "cognee" });
		const { ctx, present, showError } = createMemoryContext(settings);
		const backend = createFakeCogneeBackend({
			stats: async () => "# Cognee Stats\nActive: yes",
		});
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(backend);

		await new CommandController(ctx).handleMemoryCommand("/memory stats");

		expect(present).toHaveBeenCalledTimes(1);
		expect(showError).not.toHaveBeenCalled();
	});

	it("/memory diagnose renders backend-provided markdown through ctx.present", async () => {
		const settings = Settings.isolated({ "memory.backend": "cognee" });
		const { ctx, present, showError } = createMemoryContext(settings);
		const backend = createFakeCogneeBackend({
			diagnose: async () => "API key: present (redacted)\napiUrl: http://localhost:8000",
		});
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(backend);

		await new CommandController(ctx).handleMemoryCommand("/memory diagnose");

		expect(present).toHaveBeenCalledTimes(1);
		expect(showError).not.toHaveBeenCalled();
	});

	it("/memory clear calls backend.clear, refreshes the prompt, and shows non-destructive Cognee wording", async () => {
		const settings = Settings.isolated({ "memory.backend": "cognee" });
		const { ctx, session, showStatus } = createMemoryContext(settings);
		const clearCalls: Array<{ agentDir: string; cwd: string; session: unknown }> = [];
		const backend = createFakeCogneeBackend({
			clear: async (agentDir, cwd, sess) => {
				clearCalls.push({ agentDir, cwd, session: sess });
			},
		});
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(backend);

		await new CommandController(ctx).handleMemoryCommand("/memory clear");

		expect(clearCalls).toHaveLength(1);
		expect(clearCalls[0]?.agentDir).toBe(settings.getAgentDir());
		expect(clearCalls[0]?.cwd).toBe("/tmp/project");
		expect(clearCalls[0]?.session).toBe(session);
		expect(session.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalled();
		const statusText = showStatus.mock.calls[0]?.[0] ?? "";
		expect(statusText).toContain("Upstream Cognee datasets were not deleted");
	});

	it("/memory reset mirrors clear behavior and wording", async () => {
		const settings = Settings.isolated({ "memory.backend": "cognee" });
		const { ctx, session, showStatus } = createMemoryContext(settings);
		const clearCalls: Array<{ agentDir: string; cwd: string }> = [];
		const backend = createFakeCogneeBackend({
			clear: async (agentDir, cwd) => {
				clearCalls.push({ agentDir, cwd });
			},
		});
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(backend);

		await new CommandController(ctx).handleMemoryCommand("/memory reset");

		expect(clearCalls).toHaveLength(1);
		expect(session.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		const statusText = showStatus.mock.calls[0]?.[0] ?? "";
		expect(statusText).toContain("Upstream Cognee datasets were not deleted");
	});

	it("/memory enqueue calls backend.enqueue and shows Cognee maintenance wording", async () => {
		const settings = Settings.isolated({ "memory.backend": "cognee" });
		const { ctx, showStatus } = createMemoryContext(settings);
		const enqueueCalls: Array<{ agentDir: string; cwd: string }> = [];
		const backend = createFakeCogneeBackend({
			enqueue: async (agentDir, cwd) => {
				enqueueCalls.push({ agentDir, cwd });
			},
		});
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(backend);

		await new CommandController(ctx).handleMemoryCommand("/memory enqueue");

		expect(enqueueCalls).toHaveLength(1);
		expect(enqueueCalls[0]?.agentDir).toBe(settings.getAgentDir());
		expect(enqueueCalls[0]?.cwd).toBe("/tmp/project");
		const statusText = showStatus.mock.calls[0]?.[0] ?? "";
		expect(statusText).toContain("Cognee memory maintenance enqueued");
	});

	it("/memory rebuild mirrors enqueue behavior and wording", async () => {
		const settings = Settings.isolated({ "memory.backend": "cognee" });
		const { ctx, showStatus } = createMemoryContext(settings);
		const enqueueCalls: Array<{ agentDir: string; cwd: string }> = [];
		const backend = createFakeCogneeBackend({
			enqueue: async (agentDir, cwd) => {
				enqueueCalls.push({ agentDir, cwd });
			},
		});
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(backend);

		await new CommandController(ctx).handleMemoryCommand("/memory rebuild");

		expect(enqueueCalls).toHaveLength(1);
		const statusText = showStatus.mock.calls[0]?.[0] ?? "";
		expect(statusText).toContain("Cognee memory maintenance enqueued");
	});

	it("/memory clear keeps generic wording for non-Cognee backends", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const { ctx, showStatus } = createMemoryContext(settings);
		// Use a fake "local"-id backend with a clear hook to avoid touching disk.
		const fakeLocal = {
			id: "local",
			async start() {},
			async buildDeveloperInstructions() {
				return undefined;
			},
			async clear() {},
			async enqueue() {},
		} as unknown as MemoryBackend;
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(fakeLocal);

		await new CommandController(ctx).handleMemoryCommand("/memory clear");

		const statusText = showStatus.mock.calls[0]?.[0] ?? "";
		expect(statusText).toBe("Memory data cleared and system prompt refreshed.");
		expect(statusText).not.toContain("Cognee");
	});
});
