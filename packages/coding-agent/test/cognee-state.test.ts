import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type CogneeClient,
	CogneeError,
	type CogneeImproveRequest,
	type CogneeRecallEntry,
	type CogneeRecallRequest,
	type CogneeRememberDataItem,
	type CogneeRememberRequest,
	type CogneeRememberResult,
} from "../src/cognee/client";
import type { CogneeConfig } from "../src/cognee/config";
import type { CogneeScope } from "../src/cognee/scope";
import {
	CogneeSessionState,
	type CogneeSessionStateOptions,
	getCogneeSessionState,
	setCogneeSessionState,
} from "../src/cognee/state";
import type { MemoryBackendSaveInput } from "../src/memory-backend";
import type { AgentSession } from "../src/session/agent-session";

type TestConfig = CogneeConfig;
type TestScope = CogneeScope;

type RememberCall = { request: CogneeRememberRequest; signal?: AbortSignal };
type RecallCall = { request: CogneeRecallRequest; signal?: AbortSignal };
type ImproveCall = { request: CogneeImproveRequest; signal?: AbortSignal };

interface FakeClient extends CogneeClient {
	rememberCalls: RememberCall[];
	recallCalls: RecallCall[];
	improveCalls: ImproveCall[];
	recallEntries: CogneeRecallEntry[];
	rememberResult: CogneeRememberResult;
	improveResult: Record<string, unknown>;
	rememberError?: Error;
	recallError?: Error;
	improveError?: Error;
}

interface FakeSession {
	sessionManager: {
		getEntries(): Array<{
			type: string;
			message: AgentMessage;
			id: string;
			parentId: string | null;
			timestamp: string;
		}>;
		getCwd(): string;
	};
	subscribeListeners: ((event: { type: string; messages?: AgentMessage[] }) => void)[];
	notices: Array<{ level: string; message: string; source?: string }>;
	refreshCount: number;
	subscribe(listener: (event: { type: string; messages?: AgentMessage[] }) => void): () => void;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	refreshBaseSystemPrompt(): Promise<void>;
	emit(event: { type: string; messages?: AgentMessage[] }): void;
}

const asAgentMessage = (message: unknown): AgentMessage => message as AgentMessage;
const asSession = (session: unknown): AgentSession => session as AgentSession;

function makeConfig(overrides: Partial<TestConfig> = {}): TestConfig {
	return {
		apiUrl: "http://cognee.local",
		apiKey: null,
		datasetName: "omp",
		datasetId: null,
		datasetNamePrefix: "",
		scoping: "per-project-tagged",
		autoRecall: true,
		autoRetain: true,
		retainMode: "full-session",
		retainEveryNTurns: 3,
		retainOverlapTurns: 2,
		retainContext: "omp",
		runInBackground: true,
		chunkSize: null,
		chunksPerBatch: null,
		customPrompt: null,
		nodeSet: [],
		ontologyKeys: [],
		graphModel: null,
		recallSearchType: "GRAPH_COMPLETION",
		recallScope: "auto",
		recallTopK: 10,
		recallContextTurns: 2,
		recallMaxQueryChars: 1200,
		recallMaxRenderChars: 12000,
		recallPromptPreamble: "Relevant Cognee memories.",
		onlyContext: false,
		verbose: false,
		improveOnEnqueue: true,
		buildGlobalContextIndex: false,
		sessionMemoryEnabled: true,
		debug: false,
		...overrides,
	} as TestConfig;
}

function makeScope(overrides: Partial<TestScope> = {}): TestScope {
	return {
		label: "project:oh-my-pi",
		datasetName: "omp",
		datasetId: undefined,
		retainDatasetLabel: "omp",
		recallDatasetLabels: ["omp"],
		recallDatasets: ["omp"],
		recallDatasetIds: undefined,
		retainNodeSet: ["project:oh-my-pi"],
		recallNodeName: undefined,
		projectLabel: "oh-my-pi",
		projectNode: "project:oh-my-pi",
		sessionId: undefined,
		...overrides,
	} as TestScope;
}

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
	const client: FakeClient = {
		rememberCalls: [],
		recallCalls: [],
		improveCalls: [],
		recallEntries: [],
		rememberResult: { status: "ok", entryId: "entry-1", contentHash: "hash-1", pipelineRunId: "run-1", raw: {} },
		improveResult: { status: "ok" },
		rememberError: undefined,
		recallError: undefined,
		improveError: undefined,
		async remember(request, signal) {
			this.rememberCalls.push({ request, signal });
			if (this.rememberError) throw this.rememberError;
			return this.rememberResult;
		},
		async recall(request, signal) {
			this.recallCalls.push({ request, signal });
			if (this.recallError) throw this.recallError;
			return this.recallEntries;
		},
		async improve(request, signal) {
			this.improveCalls.push({ request, signal });
			if (this.improveError) throw this.improveError;
			return this.improveResult;
		},
		// Unused client methods — state must never reach these.
		async rememberEntry() {
			throw new Error("rememberEntry must not be called by state");
		},
		async forget() {
			throw new Error("forget must not be called by state");
		},
		async listDatasets() {
			throw new Error("listDatasets must not be called by state");
		},
		async getDatasetStatus() {
			throw new Error("getDatasetStatus must not be called by state");
		},
		async listDatasetData() {
			throw new Error("listDatasetData must not be called by state");
		},
		async createDataset() {
			throw new Error("createDataset must not be called by state");
		},
		...overrides,
	};
	return client;
}

function messageEntry(message: AgentMessage) {
	return {
		type: "message",
		message,
		id: Math.random().toString(36).slice(2),
		parentId: null,
		timestamp: new Date().toISOString(),
	};
}

function makeSession(messages: AgentMessage[] = []): FakeSession {
	const entries = messages.map(messageEntry);
	const session: FakeSession = {
		sessionManager: {
			getEntries: () => [...entries],
			getCwd: () => "/cwd",
		},
		subscribeListeners: [],
		notices: [],
		refreshCount: 0,
		subscribe(listener) {
			session.subscribeListeners.push(listener);
			return () => {
				const idx = session.subscribeListeners.indexOf(listener);
				if (idx !== -1) session.subscribeListeners.splice(idx, 1);
			};
		},
		emitNotice(level, message, source) {
			session.notices.push({ level, message, source });
		},
		async refreshBaseSystemPrompt() {
			session.refreshCount += 1;
		},
		emit(event) {
			for (const listener of [...session.subscribeListeners]) listener(event);
		},
	};
	return session;
}

function userMessage(content: string): AgentMessage {
	return asAgentMessage({ role: "user", content });
}

function assistantMessage(content: string): AgentMessage {
	return asAgentMessage({ role: "assistant", content: [{ type: "text", text: content }] });
}

function makeOptions(
	overrides: Partial<Omit<CogneeSessionStateOptions, "client" | "session">> & {
		client?: FakeClient;
		session?: FakeSession;
	} = {},
): {
	options: CogneeSessionStateOptions;
	session: FakeSession;
	client: FakeClient;
} {
	const session = overrides.session ?? makeSession();
	const client = overrides.client ?? makeClient();
	const config = overrides.config ?? makeConfig();
	const scope = overrides.scope ?? makeScope();
	const options: CogneeSessionStateOptions = {
		sessionId: overrides.sessionId ?? "session-1",
		client,
		config,
		scope,
		session: asSession(session),
		lastRetainedTurn: overrides.lastRetainedTurn,
		hasRecalledForFirstTurn: overrides.hasRecalledForFirstTurn,
		aliasOf: overrides.aliasOf,
	};
	return { options, session, client };
}

function recallEntry(text: string, overrides: Partial<CogneeRecallEntry> = {}): CogneeRecallEntry {
	return { source: "graph", text, ...overrides } as CogneeRecallEntry;
}

function isRememberDataItem(value: unknown): value is CogneeRememberDataItem {
	return value !== null && typeof value === "object" && "content" in value;
}

function rememberDataContent(value: CogneeRememberRequest["data"]): string {
	const first = Array.isArray(value) ? value[0] : value;
	if (isRememberDataItem(first)) return typeof first.content === "string" ? first.content : String(first.content);
	return typeof first === "string" ? first : String(first);
}

function recallPrerequisitesError(): CogneeError {
	return new CogneeError("HTTP 404: Recall prerequisites not met", 404, {
		detail: "Recall prerequisites not met",
	});
}

afterEach(() => {
	// Tests install state on fake sessions via the side channel; nothing to
	// globally reset between cases since each test builds fresh fakes.
});

describe("CogneeSessionState side-channel accessors", () => {
	it("getCogneeSessionState(undefined) returns undefined", () => {
		expect(getCogneeSessionState(undefined)).toBeUndefined();
	});

	it("setCogneeSessionState returns the previous state and stores the new one", () => {
		const { options, session } = makeOptions();
		const state = new CogneeSessionState(options);
		const sessionObj = asSession(session);
		expect(setCogneeSessionState(sessionObj, state)).toBeUndefined();
		expect(getCogneeSessionState(sessionObj)).toBe(state);
		const second = new CogneeSessionState({ ...options, sessionId: "session-2" });
		expect(setCogneeSessionState(sessionObj, second)).toBe(state);
		expect(getCogneeSessionState(sessionObj)).toBe(second);
	});

	it("clearing with undefined deletes the symbol value", () => {
		const { options, session } = makeOptions();
		const sessionObj = asSession(session);
		const state = new CogneeSessionState(options);
		setCogneeSessionState(sessionObj, state);
		expect(setCogneeSessionState(sessionObj, undefined)).toBe(state);
		expect(getCogneeSessionState(sessionObj)).toBeUndefined();
	});
});

describe("CogneeSessionState first-turn recall", () => {
	it("beforeAgentStartPrompt sends expected recall fields, returns a block, sets snippet and flag", async () => {
		const { options, client } = makeOptions();
		client.recallEntries = [recallEntry("Prior note about alpha.")];
		const state = new CogneeSessionState(options);
		const result = await state.beforeAgentStartPrompt("latest task");
		expect(result).toContain("<cognee_memories>");
		expect(state.hasRecalledForFirstTurn).toBe(true);
		expect(state.lastRecallSnippet).toBe(result);
		expect(client.recallCalls).toHaveLength(1);
		const req = client.recallCalls[0].request;
		expect(req.query).toContain("latest task");
		expect(req.searchType).toBe("GRAPH_COMPLETION");
		expect(req.datasets).toEqual(["omp"]);
		expect(req.datasetIds).toBeUndefined();
		expect(req.nodeName).toBeUndefined();
		expect(req.topK).toBe(10);
		expect(req.onlyContext).toBe(false);
		expect(req.verbose).toBe(false);
		expect(req.sessionId).toBe("session-1");
		expect(req.scope).toBeUndefined();
	});

	it("includes recent transcript context in the composed query", async () => {
		const session = makeSession([userMessage("earlier task"), assistantMessage("earlier answer")]);
		const { options, client } = makeOptions({ session });
		client.recallEntries = [recallEntry("Prior note.")];
		const state = new CogneeSessionState(options);
		await state.beforeAgentStartPrompt("latest task");
		expect(client.recallCalls[0].request.query).toContain("earlier task");
	});

	it("empty recall results flip the flag and return undefined", async () => {
		const { options, client } = makeOptions();
		client.recallEntries = [];
		const state = new CogneeSessionState(options);
		const result = await state.beforeAgentStartPrompt("latest task");
		expect(result).toBeUndefined();
		expect(state.hasRecalledForFirstTurn).toBe(true);
		expect(state.lastRecallSnippet).toBeUndefined();
	});

	it("thrown recall returns undefined and leaves the flag false", async () => {
		const { options, client } = makeOptions();
		client.recallError = new Error("network down");
		const state = new CogneeSessionState(options);
		const result = await state.beforeAgentStartPrompt("latest task");
		expect(result).toBeUndefined();
		expect(state.hasRecalledForFirstTurn).toBe(false);
		expect(state.lastRecallSnippet).toBeUndefined();
	});

	it("recovers recall prerequisites before first-turn prompt injection", async () => {
		const { options, client } = makeOptions();
		client.recallEntries = [recallEntry("Prior recovered note.")];
		let recallAttempts = 0;
		client.recall = async function (request, signal) {
			this.recallCalls.push({ request, signal });
			recallAttempts += 1;
			if (recallAttempts === 1) throw recallPrerequisitesError();
			return this.recallEntries;
		};
		const state = new CogneeSessionState(options);

		const result = await state.beforeAgentStartPrompt("latest task");

		expect(result).toContain("Prior recovered note.");
		expect(client.improveCalls).toHaveLength(1);
		expect(client.recallCalls).toHaveLength(2);
		expect(state.hasRecalledForFirstTurn).toBe(true);
	});

	it("a second call does not call client.recall again", async () => {
		const { options, client } = makeOptions();
		client.recallEntries = [recallEntry("note")];
		const state = new CogneeSessionState(options);
		await state.beforeAgentStartPrompt("latest task");
		await state.beforeAgentStartPrompt("latest task 2");
		expect(client.recallCalls).toHaveLength(1);
	});

	it("omits sessionId when sessionMemoryEnabled is false", async () => {
		const { options, client } = makeOptions({ config: makeConfig({ sessionMemoryEnabled: false }) });
		client.recallEntries = [recallEntry("note")];
		const state = new CogneeSessionState(options);
		await state.beforeAgentStartPrompt("latest task");
		expect(client.recallCalls[0].request.sessionId).toBeUndefined();
	});

	it("sends scope when recallScope is not auto", async () => {
		const { options, client } = makeOptions({ config: makeConfig({ recallScope: "graph" }) });
		client.recallEntries = [recallEntry("note")];
		const state = new CogneeSessionState(options);
		await state.beforeAgentStartPrompt("latest task");
		expect(client.recallCalls[0].request.scope).toBe("graph");
	});

	it("returns undefined for empty prompt without flipping the flag", async () => {
		const { options, client } = makeOptions();
		const state = new CogneeSessionState(options);
		const result = await state.beforeAgentStartPrompt("   ");
		expect(result).toBeUndefined();
		expect(state.hasRecalledForFirstTurn).toBe(false);
		expect(client.recallCalls).toHaveLength(0);
	});

	it("returns undefined when autoRecall is false", async () => {
		const { options, client } = makeOptions({ config: makeConfig({ autoRecall: false }) });
		const state = new CogneeSessionState(options);
		const result = await state.beforeAgentStartPrompt("latest task");
		expect(result).toBeUndefined();
		expect(client.recallCalls).toHaveLength(0);
	});
});

describe("CogneeSessionState listener recall and prompt snippets", () => {
	it("attachSessionListeners subscribes once and reattaches cleanly on a second call", () => {
		const { options, session } = makeOptions();
		const state = new CogneeSessionState(options);
		state.attachSessionListeners();
		expect(session.subscribeListeners).toHaveLength(1);
		state.attachSessionListeners();
		expect(session.subscribeListeners).toHaveLength(1);
	});

	it("agent_start with a latest user message performs recall, stores snippet, and calls refreshBaseSystemPrompt", async () => {
		const session = makeSession([userMessage("hello world")]);
		const { options, client } = makeOptions({ session });
		client.recallEntries = [recallEntry("greeting note")];
		const state = new CogneeSessionState(options);
		state.attachSessionListeners();
		session.emit({ type: "agent_start" });
		// Await any scheduled async listener work.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(state.hasRecalledForFirstTurn).toBe(true);
		expect(state.lastRecallSnippet).toContain("<cognee_memories>");
		expect(session.refreshCount).toBe(1);
	});

	it("does not refresh when recall succeeds with no context", async () => {
		const session = makeSession([userMessage("hello world")]);
		const { options, client } = makeOptions({ session });
		client.recallEntries = [];
		const state = new CogneeSessionState(options);
		state.attachSessionListeners();
		session.emit({ type: "agent_start" });
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(state.hasRecalledForFirstTurn).toBe(true);
		expect(state.lastRecallSnippet).toBeUndefined();
		expect(session.refreshCount).toBe(0);
	});

	it("agent_start does nothing when already recalled for first turn", async () => {
		const session = makeSession([userMessage("hello world")]);
		const { options, client } = makeOptions({ session });
		client.recallEntries = [recallEntry("note")];
		const state = new CogneeSessionState({ ...options, hasRecalledForFirstTurn: true });
		state.attachSessionListeners();
		session.emit({ type: "agent_start" });
		await Promise.resolve();
		await Promise.resolve();
		expect(client.recallCalls).toHaveLength(0);
	});
});

describe("CogneeSessionState auto-retain", () => {
	it("agent_end below threshold does not call remember", async () => {
		const session = makeSession([userMessage("turn 1"), assistantMessage("answer 1")]);
		const { options, client } = makeOptions({ session });
		const state = new CogneeSessionState(options);
		state.attachSessionListeners();
		session.emit({ type: "agent_end", messages: [userMessage("turn 1"), assistantMessage("answer 1")] });
		await Promise.resolve();
		await Promise.resolve();
		expect(client.rememberCalls).toHaveLength(0);
		expect(state.lastRetainedTurn).toBe(0);
	});

	it("at threshold remember omits contentType and sends dataset fields, nodeSet, retain options, and transcript content", async () => {
		const messages: AgentMessage[] = [
			userMessage("turn 1"),
			assistantMessage("answer 1"),
			userMessage("turn 2"),
			assistantMessage("answer 2"),
			userMessage("turn 3"),
			assistantMessage("answer 3"),
		];
		const session = makeSession(messages);
		const { options, client } = makeOptions({ session });
		const state = new CogneeSessionState(options);
		state.attachSessionListeners();
		session.emit({ type: "agent_end", messages });
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(client.rememberCalls).toHaveLength(1);
		const req = client.rememberCalls[0].request;
		expect(req.datasetName).toBe("omp");
		expect(req.datasetId).toBeUndefined();
		expect(req.nodeSet).toEqual(["project:oh-my-pi"]);
		expect(req.runInBackground).toBe(true);
		expect(req.contentType).toBeUndefined();
		expect(req.sessionId).toBe("session-1");
		const data = rememberDataContent(req.data);
		expect(data).toContain("Session: session-1");
		expect(data).toContain("Scope: project:oh-my-pi");
		expect(data).toContain("Project: oh-my-pi");
		expect(data).toContain("[role: user]");
		expect(data).toContain("[role: assistant]");
		expect(state.lastRetainedTurn).toBe(3);
		expect(state.lastRetainedAtIso).toBeDefined();
	});

	it("last-turn mode retains only the bounded recent user-turn window", async () => {
		const messages: AgentMessage[] = [
			userMessage("turn 1"),
			assistantMessage("answer 1"),
			userMessage("turn 2"),
			assistantMessage("answer 2"),
			userMessage("turn 3"),
			assistantMessage("answer 3"),
		];
		const session = makeSession(messages);
		const { options, client } = makeOptions({
			session,
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 3, retainOverlapTurns: 2 }),
		});
		const state = new CogneeSessionState(options);
		state.attachSessionListeners();
		session.emit({ type: "agent_end", messages });
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(client.rememberCalls).toHaveLength(1);
		const data = rememberDataContent(client.rememberCalls[0].request.data);
		// last-turn mode slices to retainEveryNTurns + retainOverlapTurns = 5 user turns,
		// which covers all 3 user turns here; assert the window marker is present.
		expect(data).toContain("[role: user]");
		expect(data).toContain("turn 3");
	});

	it("remember failure does not reject maybeRetainOnAgentEnd and records a warning", async () => {
		const messages: AgentMessage[] = [
			userMessage("turn 1"),
			assistantMessage("answer 1"),
			userMessage("turn 2"),
			assistantMessage("answer 2"),
			userMessage("turn 3"),
			assistantMessage("answer 3"),
		];
		const session = makeSession(messages);
		const { options, client } = makeOptions({ session });
		client.rememberError = new Error("server unavailable");
		const state = new CogneeSessionState(options);
		await state.maybeRetainOnAgentEnd();
		// Must not reject.
		expect(state.lastRetainedTurn).toBe(0);
		expect(state.lastRetainedAtIso).toBeUndefined();
	});

	it("does not retain when autoRetain is false", async () => {
		const messages: AgentMessage[] = [userMessage("t1"), userMessage("t2"), userMessage("t3")];
		const session = makeSession(messages);
		const { options, client } = makeOptions({ session, config: makeConfig({ autoRetain: false }) });
		const state = new CogneeSessionState(options);
		await state.maybeRetainOnAgentEnd();
		expect(client.rememberCalls).toHaveLength(0);
	});

	it("setSessionId changes the session id used in later remember calls", async () => {
		const messages: AgentMessage[] = [
			userMessage("t1"),
			assistantMessage("a1"),
			userMessage("t2"),
			assistantMessage("a2"),
			userMessage("t3"),
			assistantMessage("a3"),
		];
		const session = makeSession(messages);
		const { options, client } = makeOptions({ session });
		const state = new CogneeSessionState(options);
		state.setSessionId("session-999");
		state.attachSessionListeners();
		session.emit({ type: "agent_end", messages });
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(client.rememberCalls[0].request.sessionId).toBe("session-999");
	});

	it("resetConversationTracking clears primary counters and snippet", () => {
		const { options } = makeOptions();
		const state = new CogneeSessionState({ ...options, lastRetainedTurn: 5, hasRecalledForFirstTurn: true });
		state.lastRecallSnippet = "snippet";
		state.lastRetainedAtIso = "2026-01-01T00:00:00.000Z";
		state.resetConversationTracking();
		expect(state.lastRetainedTurn).toBe(0);
		expect(state.hasRecalledForFirstTurn).toBe(false);
		expect(state.lastRecallSnippet).toBeUndefined();
		expect(state.lastRetainedAtIso).toBeUndefined();
	});
});

describe("CogneeSessionState retain queue", () => {
	it("enqueueRetain plus flushRetainQueue sends one remember call with an array of markdown documents", async () => {
		const { options, client } = makeOptions();
		const state = new CogneeSessionState(options);
		setCogneeSessionState(asSession(options.session), state);
		state.enqueueRetain("first memory", "custom-ctx");
		state.enqueueRetain("second memory");
		await state.flushRetainQueue();
		expect(client.rememberCalls).toHaveLength(1);
		const req = client.rememberCalls[0].request;
		expect(Array.isArray(req.data)).toBe(true);
		const docs = req.data as unknown[];
		expect(docs).toHaveLength(2);
		expect(rememberDataContent(docs[0] as CogneeRememberRequest["data"])).toContain("first memory");
		expect(rememberDataContent(docs[0] as CogneeRememberRequest["data"])).toContain("Context: custom-ctx");
		expect(rememberDataContent(docs[0] as CogneeRememberRequest["data"])).toContain("Source: explicit-retain");
		expect(rememberDataContent(docs[1] as CogneeRememberRequest["data"])).toContain("second memory");
		expect(rememberDataContent(docs[1] as CogneeRememberRequest["data"])).toContain("Context: omp");
	});

	it("queue flush swallows client errors and emits a warning notice", async () => {
		const { options, session, client } = makeOptions();
		client.rememberError = new Error("flush failed");
		const state = new CogneeSessionState(options);
		setCogneeSessionState(asSession(session), state);
		state.enqueueRetain("a memory");
		await state.flushRetainQueue();
		expect(
			session.notices.some(n => n.level === "warning" && n.source === "Cognee" && n.message.includes("1 memory")),
		).toBe(true);
	});

	it("queue flush does not reject flushRetainQueue for client errors", async () => {
		const { options, client } = makeOptions();
		client.rememberError = new Error("flush failed");
		const state = new CogneeSessionState(options);
		setCogneeSessionState(asSession(options.session), state);
		state.enqueueRetain("a memory");
		await expect(state.flushRetainQueue()).resolves.toBeUndefined();
	});

	it("rejects all-whitespace content without queuing", async () => {
		const { options, client } = makeOptions();
		const state = new CogneeSessionState(options);
		state.enqueueRetain("   \n\t ");
		await state.flushRetainQueue();
		expect(client.rememberCalls).toHaveLength(0);
	});

	it("disposed queue rejects new enqueues with a closed error", async () => {
		const { options } = makeOptions();
		const state = new CogneeSessionState(options);
		setCogneeSessionState(asSession(options.session), state);
		await state.dispose();
		expect(() => state.enqueueRetain("after dispose")).toThrow("Cognee retain queue is closed.");
	});

	it("drops oldest item and emits a warning notice when exceeding 128 items", async () => {
		const { options, session, client } = makeOptions();
		const state = new CogneeSessionState(options);
		setCogneeSessionState(asSession(session), state);
		for (let i = 0; i < 145; i++) {
			state.enqueueRetain(`memory ${i}`);
		}
		// Enqueueing the 129th should trigger a drop notice and a batch flush at 16.
		expect(session.notices.some(n => n.message.includes("exceeded 128 items"))).toBe(true);
		await state.flushRetainQueue();
		// At least one flush occurred; the queue drained to a remember call.
		expect(client.rememberCalls.length).toBeGreaterThanOrEqual(1);
	});
});

describe("CogneeSessionState search and save", () => {
	it("search forwards options.signal, uses options.limit for topK, maps entries", async () => {
		const { options, client } = makeOptions();
		client.recallEntries = [recallEntry("result one"), recallEntry("result two")];
		const state = new CogneeSessionState(options);
		const ac = new AbortController();
		const result = await state.search("query", { limit: 5, signal: ac.signal });
		expect(result.backend).toBe("cognee");
		expect(result.count).toBe(2);
		expect(result.items).toHaveLength(2);
		expect(client.recallCalls[0].request.topK).toBe(5);
		expect(client.recallCalls[0].signal).toBe(ac.signal);
	});

	it("search returns Empty query without calling Cognee for whitespace queries", async () => {
		const { options, client } = makeOptions();
		const state = new CogneeSessionState(options);
		const result = await state.search("   ");
		expect(result.count).toBe(0);
		expect(result.message).toBe("Empty query.");
		expect(client.recallCalls).toHaveLength(0);
	});

	it("search returns zero items with a message on failure", async () => {
		const { options, client } = makeOptions();
		client.recallError = new Error("boom");
		const state = new CogneeSessionState(options);
		const result = await state.search("query");
		expect(result.count).toBe(0);
		expect(result.items).toEqual([]);
		expect(result.message).toContain("Cognee recall failed");
	});

	it("recovers recall prerequisites by improving once and retrying", async () => {
		const { options, client } = makeOptions({
			config: makeConfig({ buildGlobalContextIndex: true }),
		});
		client.recallEntries = [recallEntry("indexed result")];
		let recallAttempts = 0;
		client.recall = async function (request, signal) {
			this.recallCalls.push({ request, signal });
			recallAttempts += 1;
			if (recallAttempts === 1) throw recallPrerequisitesError();
			return this.recallEntries;
		};
		const state = new CogneeSessionState(options);

		const result = await state.search("query");

		expect(result.count).toBe(1);
		expect(result.items[0]?.content).toBe("indexed result");
		expect(client.recallCalls).toHaveLength(2);
		expect(client.improveCalls).toHaveLength(1);
		expect(client.improveCalls[0].request).toMatchObject({
			datasetName: "omp",
			sessionIds: ["session-1"],
			runInBackground: false,
			buildGlobalContextIndex: true,
		});
	});

	it("transcript retention invalidates recovered recall prerequisites", async () => {
		const session = makeSession([userMessage("turn 1"), assistantMessage("answer 1")]);
		const { options, client } = makeOptions({
			session,
			config: makeConfig({ retainEveryNTurns: 1 }),
		});
		client.recallEntries = [recallEntry("indexed result")];
		let recallAttempts = 0;
		client.recall = async function (request, signal) {
			this.recallCalls.push({ request, signal });
			recallAttempts += 1;
			if (recallAttempts === 1 || recallAttempts === 3) throw recallPrerequisitesError();
			return this.recallEntries;
		};
		const state = new CogneeSessionState(options);

		await state.search("before retain");
		expect(client.improveCalls).toHaveLength(1);

		await state.forceRetainCurrentSession();
		await state.search("after retain");

		expect(client.rememberCalls).toHaveLength(1);
		expect(client.improveCalls).toHaveLength(2);
		expect(client.recallCalls).toHaveLength(4);
	});

	it("save stores a single markdown memory with Source and Importance and returns ids", async () => {
		const { options, client } = makeOptions();
		const state = new CogneeSessionState(options);
		const result = await state.save({
			content: "important lesson",
			source: "tool",
			importance: 5,
		} as MemoryBackendSaveInput);
		expect(result.backend).toBe("cognee");
		expect(result.stored).toBe(1);
		expect(result.ids).toEqual(["entry-1", "hash-1", "run-1"]);
		expect(result.queued).toBe(true);
		expect(client.rememberCalls).toHaveLength(1);
		const data = rememberDataContent(client.rememberCalls[0].request.data);
		expect(data).toContain("important lesson");
		expect(data).toContain("Source: tool");
		expect(data).toContain("Importance: 5");
	});

	it("save returns stored 0 and message for empty content", async () => {
		const { options, client } = makeOptions();
		const state = new CogneeSessionState(options);
		const result = await state.save({ content: "   " } as MemoryBackendSaveInput);
		expect(result.stored).toBe(0);
		expect(result.message).toBe("Empty memory content.");
		expect(client.rememberCalls).toHaveLength(0);
	});

	it("save returns stored 0 and message for client failure", async () => {
		const { options, client } = makeOptions();
		client.rememberError = new Error("save boom");
		const state = new CogneeSessionState(options);
		const result = await state.save({ content: "lesson" } as MemoryBackendSaveInput);
		expect(result.stored).toBe(0);
		expect(result.message).toContain("Cognee save failed");
	});
});

describe("CogneeSessionState session-end improve and lifecycle", () => {
	it("dispose unsubscribes the listener", async () => {
		const { options, session } = makeOptions();
		const state = new CogneeSessionState(options);
		state.attachSessionListeners();
		expect(session.subscribeListeners).toHaveLength(1);
		await state.dispose();
		expect(session.subscribeListeners).toHaveLength(0);
	});

	it("dispose flushes pending queue items before closing when state is still installed", async () => {
		const { options, session, client } = makeOptions();
		const state = new CogneeSessionState(options);
		setCogneeSessionState(asSession(session), state);
		state.enqueueRetain("pending memory");
		await state.dispose();
		expect(client.rememberCalls.length).toBeGreaterThanOrEqual(1);
	});

	it("dispose calls improve once with sessionIds, dataset fields, nodeName, runInBackground, buildGlobalContextIndex", async () => {
		const { options, client } = makeOptions();
		const state = new CogneeSessionState(options);
		setCogneeSessionState(asSession(options.session), state);
		await state.dispose();
		expect(client.improveCalls).toHaveLength(1);
		const req = client.improveCalls[0].request;
		expect(req.sessionIds).toEqual(["session-1"]);
		expect(req.datasetName).toBe("omp");
		expect(req.runInBackground).toBe(true);
		expect(req.buildGlobalContextIndex).toBe(false);
		expect(req.data).toBeUndefined();
		expect(req.extractionTasks).toBeUndefined();
		expect(req.enrichmentTasks).toBeUndefined();
	});

	it("dispose does not call improve when improveOnEnqueue is false", async () => {
		const { options, client } = makeOptions({ config: makeConfig({ improveOnEnqueue: false }) });
		const state = new CogneeSessionState(options);
		setCogneeSessionState(asSession(options.session), state);
		await state.dispose();
		expect(client.improveCalls).toHaveLength(0);
	});

	it("dispose does not call improve when sessionMemoryEnabled is false", async () => {
		const { options, client } = makeOptions({ config: makeConfig({ sessionMemoryEnabled: false }) });
		const state = new CogneeSessionState(options);
		setCogneeSessionState(asSession(options.session), state);
		await state.dispose();
		expect(client.improveCalls).toHaveLength(0);
	});

	it("a thrown improve does not reject dispose", async () => {
		const { options, client } = makeOptions();
		client.improveError = new Error("improve boom");
		const state = new CogneeSessionState(options);
		setCogneeSessionState(asSession(options.session), state);
		await expect(state.dispose()).resolves.toBeUndefined();
	});

	it("calling dispose twice still only unsubscribes/improves once", async () => {
		const { options, session, client } = makeOptions();
		const state = new CogneeSessionState(options);
		setCogneeSessionState(asSession(session), state);
		state.attachSessionListeners();
		await state.dispose();
		await state.dispose();
		expect(session.subscribeListeners).toHaveLength(0);
		expect(client.improveCalls).toHaveLength(1);
	});
});

describe("CogneeSessionState alias behavior", () => {
	it("alias construction exposes parent client, config, scope and keeps alias session/sessionId", () => {
		const { options } = makeOptions();
		const parent = new CogneeSessionState(options);
		const aliasSession = makeSession();
		const alias = new CogneeSessionState({
			sessionId: "alias-session",
			client: parent.client,
			config: parent.config,
			scope: parent.scope,
			session: asSession(aliasSession),
			aliasOf: parent,
		});
		expect(alias.aliasOf).toBe(parent);
		expect(alias.client).toBe(parent.client);
		expect(alias.config).toBe(parent.config);
		expect(alias.scope).toBe(parent.scope);
		expect(alias.session).toBe(asSession(aliasSession));
		expect(alias.sessionId).toBe("alias-session");
		expect(alias.hasRecalledForFirstTurn).toBe(true);
	});

	it("alias attachSessionListeners does not subscribe", () => {
		const { options, session } = makeOptions();
		const parent = new CogneeSessionState(options);
		const alias = new CogneeSessionState({
			sessionId: "alias-session",
			client: parent.client,
			config: parent.config,
			scope: parent.scope,
			session: asSession(session),
			aliasOf: parent,
		});
		alias.attachSessionListeners();
		expect(session.subscribeListeners).toHaveLength(0);
	});

	it("alias beforeAgentStartPrompt returns undefined and does not recall", async () => {
		const { options, session, client } = makeOptions();
		const parent = new CogneeSessionState(options);
		const alias = new CogneeSessionState({
			sessionId: "alias-session",
			client: parent.client,
			config: parent.config,
			scope: parent.scope,
			session: asSession(session),
			aliasOf: parent,
		});
		const result = await alias.beforeAgentStartPrompt("latest task");
		expect(result).toBeUndefined();
		expect(client.recallCalls).toHaveLength(0);
	});

	it("alias maybeRetainOnAgentEnd and forceRetainCurrentSession do not call remember", async () => {
		const { options, session, client } = makeOptions();
		const parent = new CogneeSessionState(options);
		const alias = new CogneeSessionState({
			sessionId: "alias-session",
			client: parent.client,
			config: parent.config,
			scope: parent.scope,
			session: asSession(session),
			aliasOf: parent,
		});
		await alias.maybeRetainOnAgentEnd();
		await alias.forceRetainCurrentSession();
		expect(client.rememberCalls).toHaveLength(0);
	});

	it("alias enqueueRetain, flushRetainQueue, recallForContext, search, and save delegate to parent", async () => {
		const { options, session, client } = makeOptions();
		client.recallEntries = [recallEntry("note")];
		const parent = new CogneeSessionState(options);
		setCogneeSessionState(asSession(session), parent);
		const alias = new CogneeSessionState({
			sessionId: "alias-session",
			client: parent.client,
			config: parent.config,
			scope: parent.scope,
			session: asSession(session),
			aliasOf: parent,
		});
		alias.enqueueRetain("alias memory");
		await alias.flushRetainQueue();
		expect(client.rememberCalls).toHaveLength(1);
		const recallResult = await alias.recallForContext("alias query");
		expect(recallResult.ok).toBe(true);
		expect(client.recallCalls).toHaveLength(1);
		const searchResult = await alias.search("alias search");
		expect(searchResult.count).toBe(1);
		const saveResult = await alias.save({ content: "alias save" } as MemoryBackendSaveInput);
		expect(saveResult.stored).toBe(1);
	});

	it("alias recallForCompaction delegates to parent", async () => {
		const { options, session, client } = makeOptions();
		client.recallEntries = [recallEntry("note")];
		const parent = new CogneeSessionState(options);
		const alias = new CogneeSessionState({
			sessionId: "alias-session",
			client: parent.client,
			config: parent.config,
			scope: parent.scope,
			session: asSession(session),
			aliasOf: parent,
		});
		const result = await alias.recallForCompaction([userMessage("compaction query")]);
		expect(result).toContain("<cognee_memories>");
		expect(client.recallCalls).toHaveLength(1);
	});

	it("alias resetConversationTracking keeps the flag true and does not reset parent", () => {
		const { options } = makeOptions();
		const parent = new CogneeSessionState({ ...options, lastRetainedTurn: 4, hasRecalledForFirstTurn: true });
		parent.lastRecallSnippet = "parent snippet";
		const alias = new CogneeSessionState({
			sessionId: "alias-session",
			client: parent.client,
			config: parent.config,
			scope: parent.scope,
			session: options.session,
			aliasOf: parent,
		});
		alias.resetConversationTracking();
		expect(alias.hasRecalledForFirstTurn).toBe(true);
		// Parent untouched.
		expect(parent.lastRetainedTurn).toBe(4);
		expect(parent.lastRecallSnippet).toBe("parent snippet");
	});

	it("alias dispose does not unsubscribe, flush, or improve", async () => {
		const { options, session, client } = makeOptions();
		const parent = new CogneeSessionState(options);
		parent.attachSessionListeners();
		const alias = new CogneeSessionState({
			sessionId: "alias-session",
			client: parent.client,
			config: parent.config,
			scope: parent.scope,
			session: asSession(session),
			aliasOf: parent,
		});
		await alias.dispose();
		expect(session.subscribeListeners).toHaveLength(1);
		expect(client.improveCalls).toHaveLength(0);
	});
});

describe("CogneeSessionState forceRetainCurrentSession", () => {
	it("stores the current transcript regardless of threshold", async () => {
		const messages: AgentMessage[] = [userMessage("t1"), assistantMessage("a1")];
		const session = makeSession(messages);
		const { options, client } = makeOptions({ session });
		const state = new CogneeSessionState(options);
		await state.forceRetainCurrentSession();
		expect(client.rememberCalls).toHaveLength(1);
		expect(state.lastRetainedTurn).toBe(1);
		expect(state.lastRetainedAtIso).toBeDefined();
	});

	it("returns without calling remember when transcript is empty", async () => {
		const session = makeSession([]);
		const { options, client } = makeOptions({ session });
		const state = new CogneeSessionState(options);
		await state.forceRetainCurrentSession();
		expect(client.rememberCalls).toHaveLength(0);
	});

	it("warns and continues on failure without updating counters", async () => {
		const messages: AgentMessage[] = [userMessage("t1"), assistantMessage("a1")];
		const session = makeSession(messages);
		const { options, client } = makeOptions({ session });
		client.rememberError = new Error("force fail");
		const state = new CogneeSessionState(options);
		await state.forceRetainCurrentSession();
		expect(state.lastRetainedTurn).toBe(0);
		expect(state.lastRetainedAtIso).toBeUndefined();
	});
});

describe("CogneeSessionState recallForCompaction", () => {
	it("returns context without mutating first-turn flag or snippet", async () => {
		const { options, client } = makeOptions();
		client.recallEntries = [recallEntry("compaction note")];
		const state = new CogneeSessionState({ ...options, hasRecalledForFirstTurn: false });
		const result = await state.recallForCompaction([userMessage("compaction query")]);
		expect(result).toContain("<cognee_memories>");
		expect(state.hasRecalledForFirstTurn).toBe(false);
		expect(state.lastRecallSnippet).toBeUndefined();
	});

	it("recovers recall prerequisites for compaction context", async () => {
		const { options, client } = makeOptions();
		client.recallEntries = [recallEntry("compaction recovered note")];
		let recallAttempts = 0;
		client.recall = async function (request, signal) {
			this.recallCalls.push({ request, signal });
			recallAttempts += 1;
			if (recallAttempts === 1) throw recallPrerequisitesError();
			return this.recallEntries;
		};
		const state = new CogneeSessionState(options);

		const result = await state.recallForCompaction([userMessage("compaction query")]);

		expect(result).toContain("compaction recovered note");
		expect(client.improveCalls).toHaveLength(1);
		expect(client.recallCalls).toHaveLength(2);
	});

	it("returns undefined when no user message exists", async () => {
		const { options, client } = makeOptions();
		client.recallEntries = [recallEntry("note")];
		const state = new CogneeSessionState(options);
		const result = await state.recallForCompaction([assistantMessage("only assistant")]);
		expect(result).toBeUndefined();
		expect(client.recallCalls).toHaveLength(0);
	});
});
