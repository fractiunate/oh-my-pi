/**
 * Cognee backend behavioural contract tests.
 *
 * These exercise `cogneeBackend` start / hooks / scope rebuild without a real
 * Cognee server. The suite imports the real backend/state/client modules via
 * relative source paths and fakes only the HTTP boundary with per-test
 * `globalThis.fetch` spies, so it does not register module mocks that can leak
 * into sibling Cognee test files in Bun's shared test process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import type { AgentSessionEventListener } from "../src/session/agent-session";
import type { CogneeClient } from "../src/cognee/client";
import type { CogneeScope } from "../src/cognee/scope";
import type { CogneeConfig } from "../src/cognee/config";
import { cogneeBackend } from "../src/cognee/backend";
import { getCogneeSessionState } from "../src/cognee/state";
import {
	createFakeCogneeFetch,
	type FakeCogneeFetchResponse,
	type RecordedCogneeRequest,
} from "./helpers/cognee";

// ─── Fakes ──────────────────────────────────────────────────────────────────

function installFakeCogneeFetch(responses: FakeCogneeFetchResponse[]) {
	const fake = createFakeCogneeFetch(responses);
	vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
	return fake;
}

function installThrowingFetchGetter(message: string): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		get() {
			throw new Error(message);
		},
	});
	return () => {
		if (descriptor) {
			Object.defineProperty(globalThis, "fetch", descriptor);
			return;
		}
		const host: typeof globalThis & { fetch?: typeof fetch } = globalThis;
		delete host.fetch;
	};
}

function jsonRequestBody(request: RecordedCogneeRequest): Record<string, unknown> {
	if (request.body?.kind !== "json") {
		throw new Error(`Expected JSON Cognee request body, got ${request.body?.kind ?? "none"}`);
	}
	const { value } = request.body;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected JSON Cognee request body to be an object");
	}
	return Object.fromEntries(Object.entries(value));
}

interface FakeSessionDeps {
	sessionId: string | null;
	cwd?: string;
	settings?: Settings;
}

function makeFakeSession(deps: FakeSessionDeps) {
	const listeners = new Set<AgentSessionEventListener>();
	const notices: Array<{ level: string; message: string; source?: string }> = [];
	const session = {
		sessionId: deps.sessionId,
		settings: deps.settings ?? Settings.isolated(),
		notices,
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
		listenerCount() {
			return listeners.size;
		},
		refreshBaseSystemPrompt: vi.fn().mockResolvedValue(undefined),
		emit(event: Parameters<AgentSessionEventListener>[0]) {
			for (const l of [...listeners]) l(event);
		},
		emitNotice(level: string, message: string, source?: string) {
			notices.push({ level, message, source });
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
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ─── start ──────────────────────────────────────────────────────────────────

describe("cogneeBackend.start", () => {
	it("installs primary state with client, config, and scope for a configured top-level session", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "s1" });

		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		const state = getCogneeSessionState(session) as
			| { client: CogneeClient; config: CogneeConfig; scope: CogneeScope }
			| undefined;
		expect(state).toBeDefined();
		expect(state?.client).toBeDefined();
		expect(state?.config.apiUrl).toBe("http://localhost:8000");
		expect(state?.scope).toBeDefined();
		expect(session.listenerCount()).toBe(1);
	});

	it("is non-throwing if client construction fails and leaves backend inactive", async () => {
		const settings = makeConfiguredSettings();
		const session = makeFakeSession({ sessionId: "s2" });
		const restoreFetch = installThrowingFetchGetter("client construction failed");

		try {
			await expect(
				cogneeBackend.start({
					session: session as never,
					settings,
					modelRegistry: {} as never,
					agentDir: "/tmp",
					taskDepth: 0,
				}),
			).resolves.toBeUndefined();
		} finally {
			restoreFetch();
		}

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

		const subState = getCogneeSessionState(subSession) as
			| {
					aliasOf: unknown;
					client: CogneeClient;
					hasRecalledForFirstTurn: boolean;
			  }
			| undefined;
		expect(subState).toBeDefined();
		expect(subState?.aliasOf).toBe(parentState);
		expect(subState?.client).toBe(parentState?.client);
		expect(subState?.hasRecalledForFirstTurn).toBe(true);
		expect(parentSession.listenerCount()).toBe(1);
		expect(subSession.listenerCount()).toBe(0);
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

		await cogneeBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = getCogneeSessionState(session) as {
			flushRetainQueue: () => Promise<void>;
			dispose: () => void | Promise<void>;
		};
		const flushSpy = vi.spyOn(state, "flushRetainQueue");
		const { logger } = await import("@oh-my-pi/pi-utils");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		await cogneeBackend.clear("/tmp", "/tmp", session as never);

		expect(flushSpy).toHaveBeenCalled();
		expect(getCogneeSessionState(session)).toBeUndefined();
		expect(session.listenerCount()).toBe(0);
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
		const fakeFetch = installFakeCogneeFetch([{ body: { ok: true } }]);
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

		await cogneeBackend.enqueue("/tmp", "/tmp", session as never);

		expect(flushSpy).toHaveBeenCalled();
		expect(forceSpy).toHaveBeenCalled();
		expect(fakeFetch.requests).toHaveLength(1);
		const [request] = fakeFetch.requests;
		if (!request) throw new Error("Expected Cognee improve request");
		expect(request.method).toBe("POST");
		expect(request.path).toBe("/api/v1/improve");
		const body = jsonRequestBody(request);
		expect(body.datasetName).toBe(state.scope.datasetName);
		expect(body.datasetId).toBe(state.scope.datasetId);
		expect(body.sessionIds).toEqual([state.sessionId]);
		expect(body.runInBackground).toBe(state.config.runInBackground);
		expect(body.buildGlobalContextIndex).toBe(state.config.buildGlobalContextIndex);
	});

	it("on alias state returns without retain/improve", async () => {
		const settings = makeConfiguredSettings();
		const parentSession = makeFakeSession({ sessionId: "parent-enq" });

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
		installFakeCogneeFetch([{ status: 500, body: { detail: "improve down" } }]);
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
		const fakeFetch = installFakeCogneeFetch([
			{ status: 500, body: { detail: "status down" } },
			{ status: 500, body: { detail: "list down" } },
		]);
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
		expect(fakeFetch.requests.some(req => req.method === "POST" && req.path === "/api/v1/datasets")).toBe(false);
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
		installFakeCogneeFetch([
			{ status: 500, body: { detail: "diag status down" } },
			{ status: 500, body: { detail: "diag list down" } },
		]);
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
