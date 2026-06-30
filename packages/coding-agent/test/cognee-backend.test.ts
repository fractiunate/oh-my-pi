/**
 * Cognee backend behavioural contract tests.
 *
 * These exercise `cogneeBackend` start / hooks / scope rebuild without a real
 * Cognee server or the not-yet-joined `./state` module. `./state` is mocked
 * with a structural fake `CogneeSessionState` plus side-channel helpers, and
 * `createCogneeClient` is mocked to inject fake clients. No `fetch` is
 * performed. Once `CogneeTestHarness` joins, the local fakes can be swapped
 * for its shared factories.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CogneeClient } from "@oh-my-pi/pi-coding-agent/cognee/client";
import type { CogneeScope } from "@oh-my-pi/pi-coding-agent/cognee/scope";
import type { CogneeConfig } from "@oh-my-pi/pi-coding-agent/cognee/config";

// ─── Mock ./state (absent until CogneeSessionState joins) ───────────────────

const stateBySession = new WeakMap<object, unknown>();

interface FakeStateOptions {
	sessionId: string;
	client: CogneeClient;
	config: CogneeConfig;
	scope: CogneeScope;
	session: object;
	lastRetainedTurn?: number;
	hasRecalledForFirstTurn?: boolean;
	aliasOf?: unknown;
}

let constructHook: ((opts: FakeStateOptions) => void) | undefined;

vi.mock("@oh-my-pi/pi-coding-agent/cognee/state", () => {
	class FakeCogneeSessionState {
		readonly sessionId: string;
		readonly client: CogneeClient;
		readonly config: CogneeConfig;
		readonly scope: CogneeScope;
		readonly session: object;
		readonly lastRetainedTurn: number;
		readonly hasRecalledForFirstTurn: boolean;
		readonly aliasOf?: unknown;
		lastRecallSnippet?: string;
		lastRetainedAtIso?: string;
		attached = false;
		disposed = false;

		constructor(opts: FakeStateOptions) {
			this.sessionId = opts.sessionId;
			this.client = opts.client;
			this.config = opts.config;
			this.scope = opts.scope;
			this.session = opts.session;
			this.lastRetainedTurn = opts.lastRetainedTurn ?? 0;
			this.hasRecalledForFirstTurn = opts.hasRecalledForFirstTurn ?? false;
			this.aliasOf = opts.aliasOf;
			constructHook?.(opts);
		}

		setSessionId(): void {}
		resetConversationTracking(): void {}
		enqueueRetain(): void {}
		async flushRetainQueue(): Promise<void> {}
		async beforeAgentStartPrompt(): Promise<string | undefined> {
			return undefined;
		}
		async recallForContext(): Promise<{ context: string | null; ok: boolean }> {
			return { context: null, ok: false };
		}
		async recallForCompaction(): Promise<string | undefined> {
			return undefined;
		}
		async forceRetainCurrentSession(): Promise<void> {}
		async maybeRetainOnAgentEnd(): Promise<void> {}
		attachSessionListeners(): void {
			this.attached = true;
		}
		dispose(): void {
			this.disposed = true;
		}
		async search(): Promise<{ count: number; items: unknown[] }> {
			return { count: 0, items: [] };
		}
		async save(): Promise<{ stored: number }> {
			return { stored: 1 };
		}
	}

	return {
		CogneeSessionState: FakeCogneeSessionState,
		getCogneeSessionState: (session: object | undefined) =>
			session ? stateBySession.get(session) : undefined,
		setCogneeSessionState: (session: object, state: unknown) => {
			const previous = stateBySession.get(session);
			stateBySession.set(session, state);
			return previous;
		},
	};
});

// ─── Mock createCogneeClient to inject fakes / simulate failure ─────────────

let clientFactory: (opts: { baseUrl: string; apiKey?: string }) => CogneeClient = () =>
	createFakeCogneeClient();

vi.mock("@oh-my-pi/pi-coding-agent/cognee/client", () => ({
	createCogneeClient: (opts: { baseUrl: string; apiKey?: string }) => clientFactory(opts),
}));

// Import after mocks are registered.
import { cogneeBackend } from "@oh-my-pi/pi-coding-agent/cognee/backend";
import {
	getCogneeSessionState,
	setCogneeSessionState,
} from "@oh-my-pi/pi-coding-agent/cognee/state";

// ─── Fakes ──────────────────────────────────────────────────────────────────

function createFakeCogneeClient(overrides: Partial<CogneeClient> = {}): CogneeClient {
	const calls = {
		remember: [] as unknown[],
		recall: [] as unknown[],
		improve: [] as unknown[],
		forget: [] as unknown[],
		listDatasets: 0,
		getDatasetStatus: 0,
	};
	const base: CogneeClient = {
		remember: async () => ({ ok: true, raw: {} }) as never,
		rememberEntry: async () => ({ ok: true, raw: {} }) as never,
		recall: async () => [] as never,
		improve: async (req: never) => {
			calls.improve.push(req);
			return {} as never;
		},
		forget: async (req: never) => {
			calls.forget.push(req);
			return {} as never;
		},
		listDatasets: async () => {
			calls.listDatasets++;
			return [] as never;
		},
		getDatasetStatus: async () => {
			calls.getDatasetStatus++;
			return { status: "ok" } as never;
		},
		listDatasetData: async () => [] as never,
		createDataset: async () => ({ id: "ds", name: "ds", status: "ok", raw: {} }) as never,
	};
	return { ...base, ...overrides, ...({ __calls: calls } as unknown) } as CogneeClient;
}

interface FakeSessionDeps {
	sessionId: string | null;
	cwd?: string;
	settings?: Settings;
}

function makeFakeSession(deps: FakeSessionDeps) {
	const listeners = new Set<AgentSessionEventListener>();
	const session = {
		sessionId: deps.sessionId,
		settings: deps.settings ?? Settings.isolated(),
		sessionManager: {
			getCwd: () => deps.cwd ?? "/tmp",
			getSessionId: () => deps.sessionId ?? "",
			getSessionFile: () => null,
			getEntries: () => [],
		},
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		refreshBaseSystemPrompt: vi.fn().mockResolvedValue(undefined),
		emit(event: Parameters<AgentSessionEventListener>[0]) {
			for (const l of [...listeners]) l(event);
		},
	};
	return session;
}

function makeConfiguredSettings(overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({
		"memory.backend": "cognee",
		"cognee.apiUrl": "http://localhost:8000",
		...overrides,
	});
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
	resetSettingsForTest();
	constructHook = undefined;
	clientFactory = () => createFakeCogneeClient();
});

afterEach(() => {
	vi.restoreAllMocks();
	constructHook = undefined;
	clientFactory = () => createFakeCogneeClient();
});

// ─── start ──────────────────────────────────────────────────────────────────

describe("cogneeBackend.start", () => {
	it("installs primary state with client, config, and scope for a configured top-level session", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "s1" });
		const fakeClient = createFakeCogneeClient();
		clientFactory = () => fakeClient;

		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		const state = getCogneeSessionState(session) as {
			client: CogneeClient;
			config: CogneeConfig;
			scope: CogneeScope;
			attached: boolean;
		} | undefined;
		expect(state).toBeDefined();
		expect(state?.client).toBe(fakeClient);
		expect(state?.config.apiUrl).toBe("http://localhost:8000");
		expect(state?.scope).toBeDefined();
		expect(state?.attached).toBe(true);
	});

	it("is non-throwing if client construction fails and leaves backend inactive", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "s2" });
		clientFactory = () => {
			throw new Error("client construction failed");
		};

		await expect(
			cogneeBackend.start({
				session: session as never,
				settings,
				modelRegistry: {} as never,
				agentDir: "/tmp",
				taskDepth: 0,
			}),
		).resolves.toBeUndefined();

		expect(getCogneeSessionState(session)).toBeUndefined();
		const status = await cogneeBackend.status!({ agentDir: "/tmp", cwd: "/tmp", session: session as never });
		expect(status.active).toBe(false);
	});

	it("leaves backend inert and warns when cognee.apiUrl is blank", async () => {
		const settings = Settings.isolated({
			"memory.backend": "cognee",
			"cognee.apiUrl": "",
		});
		const session = makeFakeSession({ sessionId: "s3", settings });
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		// logger.warn routes through the logger; spy on it too.
		const { logger } = await import("@oh-my-pi/pi-utils");
		const loggerWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		expect(getCogneeSessionState(session)).toBeUndefined();
		const warned = loggerWarnSpy.mock.calls.some(c => String(c[0]).includes("cognee.apiUrl is unset"));
		expect(warned).toBe(true);
		warnSpy.mockRestore();
	});

	it("installs an alias for taskDepth > 0 with parentCogneeSessionState, sets hasRecalledForFirstTurn, and does not attach listeners", async () => {
		const settings = makeConfiguredSettings();
		const parentSession = makeFakeSession({ sessionId: "parent" });
		const fakeClient = createFakeCogneeClient();
		clientFactory = () => fakeClient;

		await cogneeBackend.start({
			session: parentSession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const parentState = getCogneeSessionState(parentSession);
		expect(parentState).toBeDefined();

		const subSession = makeFakeSession({ sessionId: "sub" });
		await cogneeBackend.start({
			session: subSession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentCogneeSessionState: parentState as never,
		});

		const subState = getCogneeSessionState(subSession) as {
			aliasOf: unknown;
			client: CogneeClient;
			hasRecalledForFirstTurn: boolean;
			attached: boolean;
		} | undefined;
		expect(subState).toBeDefined();
		expect(subState?.aliasOf).toBe(parentState);
		expect(subState?.client).toBe(parentState?.client);
		expect(subState?.hasRecalledForFirstTurn).toBe(true);
		expect(subState?.attached).toBe(false);
	});

	it("returns silently for subagent runs when no parentCogneeSessionState is provided", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "orphan-sub" });

		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
		});

		expect(getCogneeSessionState(session)).toBeUndefined();
	});
});

// ─── buildDeveloperInstructions ─────────────────────────────────────────────

describe("cogneeBackend.buildDeveloperInstructions", () => {
	it("returns undefined when unconfigured", async () => {
		const settings = Settings.isolated({ "memory.backend": "cognee", "cognee.apiUrl": "" });
		expect(await cogneeBackend.buildDeveloperInstructions("/tmp", settings, undefined)).toBeUndefined();
	});

	it("returns the exact static block and appends lastRecallSnippet from primary state", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "s-dev", settings });
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = getCogneeSessionState(session) as { lastRecallSnippet?: string };
		state.lastRecallSnippet = "<memories>snippet</memories>";

		const out = await cogneeBackend.buildDeveloperInstructions("/tmp", settings, session as never);
		expect(out).toContain("## Cognee Memory");
		expect(out).toContain("heuristic context, not authority");
		expect(out).toContain("<memories>snippet</memories>");
	});

	it("truncates to recallMaxRenderChars; with 0 returns static block only", async () => {
		const settings = makeConfiguredSettings({ "cognee.recallMaxRenderChars": 0 });
		const session = makeFakeSession({ sessionId: "s-trunc", settings });
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = getCogneeSessionState(session) as { lastRecallSnippet?: string };
		state.lastRecallSnippet = "<memories>should not appear</memories>";

		const out = await cogneeBackend.buildDeveloperInstructions("/tmp", settings, session as never);
		expect(out).toContain("## Cognee Memory");
		expect(out).not.toContain("should not appear");
	});
});

// ─── beforeAgentStartPrompt ─────────────────────────────────────────────────

describe("cogneeBackend.beforeAgentStartPrompt", () => {
	it("returns undefined without state", async () => {
		const session = makeFakeSession({ sessionId: "s-none" });
		expect(await cogneeBackend.beforeAgentStartPrompt!(session as never, "hi")).toBeUndefined();
	});

	it("delegates to state.beforeAgentStartPrompt", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "s-basp", settings });
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = getCogneeSessionState(session) as {
			beforeAgentStartPrompt: (t: string) => Promise<string | undefined>;
		};
		const spy = vi.spyOn(state, "beforeAgentStartPrompt").mockResolvedValue("injected");
		expect(await cogneeBackend.beforeAgentStartPrompt!(session as never, "hi")).toBe("injected");
		expect(spy).toHaveBeenCalledWith("hi");
	});
});

// ─── status ─────────────────────────────────────────────────────────────────

describe("cogneeBackend.status", () => {
	it("returns inactive shape without state", async () => {
		const session = makeFakeSession({ sessionId: "s-status" });
		const status = await cogneeBackend.status!({ agentDir: "/tmp", cwd: "/tmp", session: session as never });
		expect(status).toMatchObject({
			backend: "cognee",
			active: false,
			writable: false,
			searchable: false,
			message: "Cognee backend is not initialised for this session.",
		});
	});

	it("returns active shape with scope, retainBank, recallBanks, lastRecall, lastMemory", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "s-active", settings });
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = getCogneeSessionState(session) as {
			scope: CogneeScope;
			lastRecallSnippet?: string;
			lastRetainedAtIso?: string;
		};
		state.lastRecallSnippet = "recall";
		state.lastRetainedAtIso = "2026-01-01T00:00:00Z";

		const status = await cogneeBackend.status!({ agentDir: "/tmp", cwd: "/tmp", session: session as never });
		expect(status).toMatchObject({
			backend: "cognee",
			active: true,
			writable: true,
			searchable: true,
			scope: state.scope.label,
			retainBank: state.scope.retainDatasetLabel,
			recallBanks: state.scope.recallDatasetLabels,
			lastRecall: true,
			lastMemory: "2026-01-01T00:00:00Z",
		});
	});
});

// ─── search ─────────────────────────────────────────────────────────────────

describe("cogneeBackend.search", () => {
	it("returns unavailable without state", async () => {
		const session = makeFakeSession({ sessionId: "s-search" });
		const res = await cogneeBackend.search!({ agentDir: "/tmp", cwd: "/tmp", session: session as never }, "q");
		expect(res).toMatchObject({ backend: "cognee", query: "q", count: 0, items: [] });
		expect(res.message).toBe("Cognee backend is not initialised for this session.");
	});

	it("returns empty-query result for blank query", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "s-blank", settings });
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const res = await cogneeBackend.search!({ agentDir: "/tmp", cwd: "/tmp", session: session as never }, "   ");
		expect(res.message).toBe("Search query is empty.");
	});

	it("returns abort result for pre-aborted signal", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "s-abort", settings });
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const controller = new AbortController();
		controller.abort();
		const res = await cogneeBackend.search!(
			{ agentDir: "/tmp", cwd: "/tmp", session: session as never },
			"q",
			{ signal: controller.signal },
		);
		expect(res.message).toBe("Search aborted.");
	});

	it("delegates to state.search and normalizes backend/query", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "s-delegate", settings });
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = getCogneeSessionState(session) as {
			search: (q: string, o?: unknown) => Promise<{ count: number; items: unknown[] }>;
		};
		vi.spyOn(state, "search").mockResolvedValue({ count: 2, items: [{ content: "x" }] });

		const res = await cogneeBackend.search!({ agentDir: "/tmp", cwd: "/tmp", session: session as never }, "find");
		expect(res.backend).toBe("cognee");
		expect(res.query).toBe("find");
		expect(res.count).toBe(2);
	});
});

// ─── save ───────────────────────────────────────────────────────────────────

describe("cogneeBackend.save", () => {
	it("returns unavailable without state", async () => {
		const session = makeFakeSession({ sessionId: "s-save" });
		const res = await cogneeBackend.save!({ agentDir: "/tmp", cwd: "/tmp", session: session as never }, { content: "x" });
		expect(res).toMatchObject({ backend: "cognee", stored: 0 });
		expect(res.message).toBe("Cognee backend is not initialised for this session.");
	});

	it("rejects empty content as stored: 0", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "s-empty", settings });
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const res = await cogneeBackend.save!({ agentDir: "/tmp", cwd: "/tmp", session: session as never }, { content: "   " });
		expect(res.stored).toBe(0);
		expect(res.message).toBe("Memory content is empty.");
	});

	it("delegates trimmed content to state.save and normalizes backend", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "s-trim", settings });
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = getCogneeSessionState(session) as {
			save: (i: { content: string }) => Promise<{ stored: number }>;
		};
		const spy = vi.spyOn(state, "save").mockResolvedValue({ stored: 1 });

		const res = await cogneeBackend.save!({ agentDir: "/tmp", cwd: "/tmp", session: session as never }, { content: "  note  " });
		expect(res.backend).toBe("cognee");
		expect(res.stored).toBe(1);
		expect(spy.mock.calls[0]?.[0].content).toBe("note");
	});
});

// ─── clear ──────────────────────────────────────────────────────────────────

describe("cogneeBackend.clear", () => {
	it("flushes, clears/disposes state, unsubscribes, logs local-only warning, never calls forget", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "s-clear", settings });
		const fakeClient = createFakeCogneeClient();
		clientFactory = () => fakeClient;
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = getCogneeSessionState(session) as {
			flushRetainQueue: () => Promise<void>;
			dispose: () => void;
			disposed: boolean;
		};
		const flushSpy = vi.spyOn(state, "flushRetainQueue");
		const { logger } = await import("@oh-my-pi/pi-utils");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		await cogneeBackend.clear("/tmp", "/tmp", session as never);

		expect(flushSpy).toHaveBeenCalled();
		expect(getCogneeSessionState(session)).toBeUndefined();
		expect(state.disposed).toBe(true);
		const warned = warnSpy.mock.calls.some(c =>
			String(c[0]).includes("only local recall cache/session state was cleared"),
		);
		expect(warned).toBe(true);
	});
});

// ─── enqueue ────────────────────────────────────────────────────────────────

describe("cogneeBackend.enqueue", () => {
	it("on primary state flushes, force-retains, and calls client.improve with routing fields", async () => {
		const settings = makeConfiguredSettings({ "cognee.sessionMemoryEnabled": true });
		const session = makeFakeSession({ sessionId: "s-enq", settings });
		const fakeClient = createFakeCogneeClient();
		clientFactory = () => fakeClient;
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = getCogneeSessionState(session) as {
			flushRetainQueue: () => Promise<void>;
			forceRetainCurrentSession: () => Promise<void>;
			client: CogneeClient;
			scope: CogneeScope;
			config: CogneeConfig;
			sessionId: string;
		};
		const flushSpy = vi.spyOn(state, "flushRetainQueue");
		const forceSpy = vi.spyOn(state, "forceRetainCurrentSession");
		const improveSpy = vi.spyOn(fakeClient, "improve");

		await cogneeBackend.enqueue("/tmp", "/tmp", session as never);

		expect(flushSpy).toHaveBeenCalled();
		expect(forceSpy).toHaveBeenCalled();
		expect(improveSpy).toHaveBeenCalledTimes(1);
		const arg = improveSpy.mock.calls[0]?.[0] as {
			datasetName?: string;
			datasetId?: string;
			sessionIds?: string[];
			nodeName?: string[];
			runInBackground?: boolean;
			buildGlobalContextIndex?: boolean;
		};
		expect(arg.datasetName).toBe(state.scope.datasetName);
		expect(arg.datasetId).toBe(state.scope.datasetId);
		expect(arg.sessionIds).toEqual([state.sessionId]);
		expect(arg.runInBackground).toBe(state.config.runInBackground);
		expect(arg.buildGlobalContextIndex).toBe(state.config.buildGlobalContextIndex);
	});

	it("on alias state returns without retain/improve", async () => {
		const settings = makeConfiguredSettings();
		const parentSession = makeFakeSession({ sessionId: "parent-enq" });
		clientFactory = () => createFakeCogneeClient();
		await cogneeBackend.start({
			session: parentSession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const parentState = getCogneeSessionState(parentSession);

		const subSession = makeFakeSession({ sessionId: "sub-enq" });
		await cogneeBackend.start({
			session: subSession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentCogneeSessionState: parentState as never,
		});
		const parentStateObj = getCogneeSessionState(parentSession) as {
			flushRetainQueue: () => Promise<void>;
			forceRetainCurrentSession: () => Promise<void>;
		};
		const parentFlushSpy = vi.spyOn(parentStateObj, "flushRetainQueue");
		const parentForceSpy = vi.spyOn(parentStateObj, "forceRetainCurrentSession");
		const subState = getCogneeSessionState(subSession) as {
			flushRetainQueue: () => Promise<void>;
			forceRetainCurrentSession: () => Promise<void>;
			client: CogneeClient;
		};
		const flushSpy = vi.spyOn(subState, "flushRetainQueue");
		const forceSpy = vi.spyOn(subState, "forceRetainCurrentSession");
		const improveSpy = vi.spyOn(subState.client, "improve");

		await cogneeBackend.enqueue("/tmp", "/tmp", subSession as never);

		expect(flushSpy).not.toHaveBeenCalled();
		expect(forceSpy).not.toHaveBeenCalled();
		expect(improveSpy).not.toHaveBeenCalled();
		expect(parentFlushSpy).not.toHaveBeenCalled();
		expect(parentForceSpy).not.toHaveBeenCalled();
	});

	it("catches/warns improve failure after successful retain", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "s-enq-fail", settings });
		const fakeClient = createFakeCogneeClient();
		clientFactory = () => fakeClient;
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = getCogneeSessionState(session) as {
			flushRetainQueue: () => Promise<void>;
			forceRetainCurrentSession: () => Promise<void>;
		};
		const forceSpy = vi.spyOn(state, "forceRetainCurrentSession");
		vi.spyOn(fakeClient, "improve").mockRejectedValue(new Error("improve down"));
		const { logger } = await import("@oh-my-pi/pi-utils");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		await expect(cogneeBackend.enqueue("/tmp", "/tmp", session as never)).resolves.toBeUndefined();
		expect(forceSpy).toHaveBeenCalled();
		const warned = warnSpy.mock.calls.some(c => String(c[0]).includes("improve on enqueue failed"));
		expect(warned).toBe(true);
	});
});

// ─── stats ──────────────────────────────────────────────────────────────────

describe("cogneeBackend.stats", () => {
	it("renders markdown, omits API key, catches dataset status/list failures, does not create datasets", async () => {
		const settings = makeConfiguredSettings({ "cognee.apiKey": "secret" });
		const session = makeFakeSession({ sessionId: "s-stats", settings });
		const fakeClient = createFakeCogneeClient({
			getDatasetStatus: async () => {
				throw new Error("status down");
			},
			listDatasets: async () => {
				throw new Error("list down");
			},
			createDataset: async () => {
				throw new Error("must not be called");
			},
		});
		clientFactory = () => fakeClient;
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		const out = await cogneeBackend.stats!("/tmp", "/tmp", session as never);
		expect(out).toContain("## Cognee Memory Stats");
		expect(out).toContain("Configured: yes");
		expect(out).not.toContain("secret");
		expect(out).toContain("status down");
		expect(out).toContain("list down");
	});

	it("renders Configured: no without a client when unconfigured", async () => {
		const settings = Settings.isolated({ "memory.backend": "cognee", "cognee.apiUrl": "" });
		const session = makeFakeSession({ sessionId: "s-stats-no", settings });
		const out = await cogneeBackend.stats!("/tmp", "/tmp", session as never);
		expect(out).toContain("Configured: no");
	});
});

// ─── diagnose ───────────────────────────────────────────────────────────────

describe("cogneeBackend.diagnose", () => {
	it("redacts API key and renders dataset status/list failures as markdown instead of throwing", async () => {
		const settings = makeConfiguredSettings({ "cognee.apiKey": "topsecret" });
		const session = makeFakeSession({ sessionId: "s-diag", settings });
		const fakeClient = createFakeCogneeClient({
			getDatasetStatus: async () => {
				throw new Error("diag status down");
			},
			listDatasets: async () => {
				throw new Error("diag list down");
			},
		});
		clientFactory = () => fakeClient;
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		const out = await cogneeBackend.diagnose!("/tmp", "/tmp", session as never);
		expect(out).toContain("## Cognee Memory Diagnostics");
		expect(out).toContain("<redacted>");
		expect(out).not.toContain("topsecret");
		expect(out).toContain("diag status down");
		expect(out).toContain("diag list down");
	});
});

// ─── preCompactionContext ───────────────────────────────────────────────────

describe("cogneeBackend.preCompactionContext", () => {
	it("returns undefined when unconfigured", async () => {
		const settings = Settings.isolated({ "memory.backend": "cognee", "cognee.apiUrl": "" });
		expect(await cogneeBackend.preCompactionContext!([], settings, undefined)).toBeUndefined();
	});

	it("returns undefined without state", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "s-pcc", settings });
		expect(await cogneeBackend.preCompactionContext!([], settings, session as never)).toBeUndefined();
	});

	it("delegates to state.recallForCompaction", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "s-pcc2", settings });
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = getCogneeSessionState(session) as {
			recallForCompaction: (m: AgentMessage[]) => Promise<string | undefined>;
		};
		vi.spyOn(state, "recallForCompaction").mockResolvedValue("compaction context");

		const out = await cogneeBackend.preCompactionContext!([], settings, session as never);
		expect(out).toBe("compaction context");
	});
});

// ─── live scope rebuild ─────────────────────────────────────────────────────

describe("cogneeBackend live scope rebuild", () => {
	it("rebuilds primary state when cognee.datasetName changes mid-session", async () => {
		const settings = makeConfiguredSettings({ "cognee.scoping": "global" });
		settings.set("cognee.datasetName", "first");
		const session = makeFakeSession({ sessionId: "s-rebuild", settings });
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const initial = getCogneeSessionState(session) as { scope: CogneeScope } | undefined;
		expect(initial?.scope.datasetName).toBe("first");

		settings.set("cognee.datasetName", "second");
		await Bun.sleep(0);

		const next = getCogneeSessionState(session) as { scope: CogneeScope } | undefined;
		expect(next).toBeDefined();
		expect(next).not.toBe(initial);
		expect(next?.scope.datasetName).toBe("second");
	});

	it("does not rebuild when the same datasetName is rewritten", async () => {
		const settings = makeConfiguredSettings({ "cognee.scoping": "global" });
		settings.set("cognee.datasetName", "same");
		const session = makeFakeSession({ sessionId: "s-noop", settings });
		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const initial = getCogneeSessionState(session);

		settings.set("cognee.datasetName", "same");
		await Bun.sleep(0);

		expect(getCogneeSessionState(session)).toBe(initial);
	});
});
