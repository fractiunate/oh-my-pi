/**
 * Cognee memory runtime parity tests.
 *
 * These tests prove the generic `createMemoryRuntimeContext` routes
 * `status/search/save` through the active `MemoryBackend` hooks unchanged for a
 * Cognee-shaped backend, forwards query/options exactly without trimming,
 * normalizes string save input to `{ content }`, propagates unavailable
 * Cognee results without rewording them, and preserves the existing no-session
 * and hookless-backend fallbacks.
 *
 * No live Cognee server is required: `resolveMemoryBackend` is spied to return
 * a fake Cognee `MemoryBackend`. The `"cognee"` literal is cast locally because
 * `CogneeBackendAdapter` (which owns adding `"cognee"` to `MemoryBackendId`) is
 * not present in this worktree; production types are not altered here.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackend from "@oh-my-pi/pi-coding-agent/memory-backend";
import { createMemoryRuntimeContext } from "@oh-my-pi/pi-coding-agent/memory-backend";
import type {
	MemoryBackend,
	MemoryBackendOperationContext,
	MemoryBackendSaveInput,
	MemoryBackendSaveResult,
	MemoryBackendSearchOptions,
	MemoryBackendSearchResult,
	MemoryBackendStatus,
} from "@oh-my-pi/pi-coding-agent/memory-backend/types";

/**
 * Plan-authorized local widening: `MemoryBackendId` does not yet include
 * `"cognee"` in this worktree (owned by `CogneeBackendAdapter`). Every use of
 * this const stands in for that future union member; no production type is
 * altered from this package.
 */
const COGNEE_ID = "cognee" as never;

/**
 * Minimal Cognee-shaped fake backend. Required hooks are no-ops; optional
 * `status/search/save` hooks are installed per test via `overrides`.
 */
interface FakeCogneeOverrides {
	status?: (context: MemoryBackendOperationContext) => Promise<MemoryBackendStatus>;
	search?: (
		context: MemoryBackendOperationContext,
		query: string,
		options?: MemoryBackendSearchOptions,
	) => Promise<MemoryBackendSearchResult>;
	save?: (context: MemoryBackendOperationContext, input: MemoryBackendSaveInput) => Promise<MemoryBackendSaveResult>;
	stats?: (agentDir: string, cwd: string, session?: unknown) => Promise<string | undefined>;
	diagnose?: (agentDir: string, cwd: string, session?: unknown) => Promise<string | undefined>;
	clear?: (agentDir: string, cwd: string, session?: unknown) => Promise<void>;
	enqueue?: (agentDir: string, cwd: string, session?: unknown) => Promise<void>;
}

function createFakeCogneeBackend(overrides: FakeCogneeOverrides = {}): MemoryBackend {
	const backend = {
		id: COGNEE_ID,
		async start() {},
		async buildDeveloperInstructions() {
			return undefined;
		},
		async clear(agentDir: string, cwd: string, session?: unknown) {
			await overrides.clear?.(agentDir, cwd, session);
		},
		async enqueue(agentDir: string, cwd: string, session?: unknown) {
			await overrides.enqueue?.(agentDir, cwd, session);
		},
		async status(context: MemoryBackendOperationContext) {
			if (!overrides.status) throw new Error("fake cognee status not configured");
			return overrides.status(context);
		},
		async search(context: MemoryBackendOperationContext, query: string, options?: MemoryBackendSearchOptions) {
			if (!overrides.search) throw new Error("fake cognee search not configured");
			return overrides.search(context, query, options);
		},
		async save(context: MemoryBackendOperationContext, input: MemoryBackendSaveInput) {
			if (!overrides.save) throw new Error("fake cognee save not configured");
			return overrides.save(context, input);
		},
		async stats(agentDir: string, cwd: string, session?: unknown) {
			return overrides.stats?.(agentDir, cwd, session);
		},
		async diagnose(agentDir: string, cwd: string, session?: unknown) {
			return overrides.diagnose?.(agentDir, cwd, session);
		},
	};
	return backend as unknown as MemoryBackend;
}

const COGNEE_ACTIVE_STATUS: MemoryBackendStatus = {
	backend: COGNEE_ID,
	active: true,
	writable: true,
	searchable: true,
	scope: "project:oh-my-pi",
	retainBank: "project:oh-my-pi",
	recallBanks: ["global:omp", "project:oh-my-pi"],
	lastRecall: true,
	lastMemory: "2026-06-30T12:00:00.000Z",
	message: undefined,
	error: undefined,
};

function cogneeInactiveStatus(): MemoryBackendStatus {
	return {
		backend: COGNEE_ID,
		active: false,
		writable: false,
		searchable: false,
		scope: "project:oh-my-pi",
		message: "Cognee backend is not configured/initialised/available.",
		error: "missing api key",
	};
}

function cogneeEmptySearch(query: string): MemoryBackendSearchResult {
	return {
		backend: COGNEE_ID,
		query,
		count: 0,
		items: [],
		message: "Cognee backend is not configured/initialised/available.",
	};
}

describe("createMemoryRuntimeContext — Cognee backend", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("returns Cognee status through the backend hook and forwards the original context identity", async () => {
		const settings = Settings.isolated({ "memory.backend": "cognee" });
		const session = { settings } as never;
		const agentDir = "/tmp/agent";
		const cwd = "/tmp/project";
		let captured: MemoryBackendOperationContext | undefined;
		const backend = createFakeCogneeBackend({
			status: async context => {
				captured = context;
				return COGNEE_ACTIVE_STATUS;
			},
		});
		const spy = vi.spyOn(memoryBackend, "resolveMemoryBackend");
		spy.mockResolvedValue(backend);

		const memory = createMemoryRuntimeContext({ agentDir, cwd, session } as never);
		const status = await memory.status();

		expect(status).toMatchObject({
			backend: "cognee",
			active: true,
			writable: true,
			searchable: true,
			scope: "project:oh-my-pi",
			retainBank: "project:oh-my-pi",
			recallBanks: ["global:omp", "project:oh-my-pi"],
			lastRecall: true,
			lastMemory: "2026-06-30T12:00:00.000Z",
		});
		expect(captured).toBeDefined();
		expect(captured?.agentDir).toBe(agentDir);
		expect(captured?.cwd).toBe(cwd);
		expect(captured?.session).toBe(session);
	});

	it("search forwards query and options exactly without trimming or remapping", async () => {
		const settings = Settings.isolated({ "memory.backend": "cognee" });
		const session = { settings } as never;
		const agentDir = "/tmp/agent";
		const cwd = "/tmp/project";
		const ac = new AbortController();
		const options = { limit: 2, signal: ac.signal };
		const query = "  project conventions?  ";
		let capturedContext: MemoryBackendOperationContext | undefined;
		let capturedQuery: string | undefined;
		let capturedOptions: MemoryBackendSearchOptions | undefined;
		const backend = createFakeCogneeBackend({
			search: async (context, q, opts) => {
				capturedContext = context;
				capturedQuery = q;
				capturedOptions = opts;
				return {
					backend: COGNEE_ID,
					query: q,
					count: 1,
					items: [{ id: "e1", content: "prefer concise reports", source: "recall", score: 0.9 }],
				};
			},
		});
		const spy = vi.spyOn(memoryBackend, "resolveMemoryBackend");
		spy.mockResolvedValue(backend);

		const memory = createMemoryRuntimeContext({ agentDir, cwd, session } as never);
		const result = await memory.search(query, options);

		expect(capturedQuery).toBe(query);
		expect(capturedOptions).toBe(options);
		expect(capturedContext?.agentDir).toBe(agentDir);
		expect(capturedContext?.cwd).toBe(cwd);
		expect(capturedContext?.session).toBe(session);
		expect(result).toMatchObject({
			backend: "cognee",
			query,
			count: 1,
		});
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.content).toBe("prefer concise reports");
	});

	it("save normalizes string input to { content } before calling the backend hook", async () => {
		const settings = Settings.isolated({ "memory.backend": "cognee" });
		const session = { settings };
		let captured: MemoryBackendSaveInput | undefined;
		const backend = createFakeCogneeBackend({
			save: async (_context, input) => {
				captured = input;
				return { backend: COGNEE_ID, stored: 1, ids: ["run-1"] };
			},
		});
		const spy = vi.spyOn(memoryBackend, "resolveMemoryBackend");
		spy.mockResolvedValue(backend);

		const memory = createMemoryRuntimeContext({
			agentDir: "/tmp/agent",
			cwd: "/tmp/project",
			session: session as never,
		});
		const result = await memory.save("remember this");

		expect(captured).toEqual({ content: "remember this" });
		expect(result).toMatchObject({ backend: "cognee", stored: 1, ids: ["run-1"] });
	});

	it("save passes object input through unchanged as MemoryBackendSaveInput", async () => {
		const settings = Settings.isolated({ "memory.backend": "cognee" });
		const session = { settings };
		const input = { content: "remember", context: "test", source: "extension", importance: 0.7 };
		let captured: MemoryBackendSaveInput | undefined;
		const backend = createFakeCogneeBackend({
			save: async (_context, inp) => {
				captured = inp;
				return { backend: COGNEE_ID, stored: 1 };
			},
		});
		const spy = vi.spyOn(memoryBackend, "resolveMemoryBackend");
		spy.mockResolvedValue(backend);

		const memory = createMemoryRuntimeContext({
			agentDir: "/tmp/agent",
			cwd: "/tmp/project",
			session: session as never,
		});
		await memory.save(input);

		expect(captured).toEqual(input);
	});

	it("propagates misconfigured/unavailable Cognee results without throwing or rewording", async () => {
		const settings = Settings.isolated({ "memory.backend": "cognee" });
		const session = { settings };
		const backend = createFakeCogneeBackend({
			status: async () => cogneeInactiveStatus(),
			search: async (_ctx, q) => cogneeEmptySearch(q),
			save: async () => ({
				backend: COGNEE_ID,
				stored: 0,
				message: "Cognee backend is not configured/initialised/available.",
			}),
		});
		const spy = vi.spyOn(memoryBackend, "resolveMemoryBackend");
		spy.mockResolvedValue(backend);

		const memory = createMemoryRuntimeContext({
			agentDir: "/tmp/agent",
			cwd: "/tmp/project",
			session: session as never,
		});

		const status = await memory.status();
		expect(status).toMatchObject({
			backend: "cognee",
			active: false,
			message: "Cognee backend is not configured/initialised/available.",
			error: "missing api key",
		});

		const search = await memory.search("anything");
		expect(search).toMatchObject({
			backend: "cognee",
			count: 0,
			items: [],
			message: "Cognee backend is not configured/initialised/available.",
		});

		const save = await memory.save("note");
		expect(save).toMatchObject({
			backend: "cognee",
			stored: 0,
			message: "Cognee backend is not configured/initialised/available.",
		});
	});

	it("returns the existing generic off unavailable shapes when no session is present", async () => {
		const memory = createMemoryRuntimeContext({ agentDir: "/tmp/agent", cwd: "/tmp/project" });

		await expect(memory.status()).resolves.toMatchObject({
			backend: "off",
			active: false,
			writable: false,
			searchable: false,
			message: "No active agent session.",
		});
		await expect(memory.search("anything")).resolves.toMatchObject({
			backend: "off",
			count: 0,
			items: [],
		});
		await expect(memory.save("note")).resolves.toMatchObject({
			backend: "off",
			stored: 0,
		});
	});

	it("keeps the generic hookless fallback for the local backend", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const memory = createMemoryRuntimeContext({
			agentDir: "/tmp/agent",
			cwd: "/tmp/project",
			session: { settings } as never,
		});

		// Real local backend exposes no status/search hooks; runtime must keep
		// the generic hookless fallback wording rather than throwing.
		await expect(memory.status()).resolves.toMatchObject({
			backend: "local",
			active: true,
			writable: true,
			searchable: false,
		});
		await expect(memory.search("project preference")).resolves.toMatchObject({
			backend: "local",
			count: 0,
		});
	});
});
