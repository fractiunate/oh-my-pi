/**
 * Shared Cognee test fixtures.
 *
 * Test-only. Supplies deterministic fakes for the Cognee HTTP boundary,
 * the {@link CogneeClient} seam, and the Wave 2 {@link CogneeSessionStateLike}
 * seam so runtime/tool/propagation tests do not need a live Cognee server.
 *
 * Wave 2 sibling modules (`cognee/config`, `cognee/state`) are not present on
 * this branch yet. Per the CogneeTestHarness plan, their exported types are
 * kept structural here against the frozen contract sketches; the integration
 * owner can swap these local stand-ins for real `import type` lines once the
 * owning workpackages join. Present Wave 1 modules (`cognee/client`,
 * `cognee/scope`, `memory-backend`) are imported as types directly.
 */

import type {
	CogneeClient,
	CogneeCreateDatasetRequest,
	CogneeCreateDatasetResponse,
	CogneeDataset,
	CogneeDatasetStatusRequest,
	CogneeForgetRequest,
	CogneeImproveRequest,
	CogneeRecallEntry,
	CogneeRecallRequest,
	CogneeRememberEntryRequest,
	CogneeRememberRequest,
	CogneeRememberResult,
} from "@oh-my-pi/pi-coding-agent/cognee/client";
import type { CogneeScope } from "@oh-my-pi/pi-coding-agent/cognee/scope";
import type {
	MemoryBackendSaveInput,
	MemoryBackendSaveResult,
	MemoryBackendSearchOptions,
	MemoryBackendSearchResult,
} from "@oh-my-pi/pi-coding-agent/memory-backend";
import { asGlobalFetch } from "./fetch-mock";

// --- Structural stand-ins for absent Wave 2 sibling types -------------------

/** Structural mirror of `cognee/config.ts` `CogneeConfig` (contracts v1 §3.2 + v2 §A). */
interface CogneeConfig {
	apiUrl: string | null;
	apiKey: string | null;
	datasetName: string | null;
	datasetId: string | null;
	datasetNamePrefix: string;
	scoping: "global" | "per-project" | "per-project-tagged";
	autoRecall: boolean;
	autoRetain: boolean;
	retainMode: "full-session" | "last-turn";
	retainEveryNTurns: number;
	retainOverlapTurns: number;
	retainContext: string;
	runInBackground: boolean;
	chunkSize: number | null;
	chunksPerBatch: number | null;
	customPrompt: string | null;
	nodeSet: string[];
	ontologyKeys: string[];
	graphModel: string | null;
	recallSearchType: string;
	recallScope: string;
	recallTopK: number;
	recallContextTurns: number;
	recallMaxQueryChars: number;
	recallMaxRenderChars: number;
	recallPromptPreamble: string;
	onlyContext: boolean;
	verbose: boolean;
	improveOnEnqueue: boolean;
	buildGlobalContextIndex: boolean;
	sessionMemoryEnabled: boolean;
	debug: boolean;
}

/** Structural mirror of `cognee/state.ts` `CogneeSessionStateLike` (contracts v1 §3.4 + plans). */
interface CogneeSessionStateLike {
	sessionId: string;
	client: CogneeClient;
	config: CogneeConfig;
	scope: CogneeScope;
	session: unknown;
	aliasOf?: CogneeSessionStateLike | undefined;
	lastRecallSnippet?: string | undefined;
	lastRetainedAtIso?: string | undefined;
	lastRetainedTurn?: number | undefined;
	hasRecalledForFirstTurn?: boolean | undefined;
	setSessionId(sessionId: string): void;
	resetConversationTracking(): void;
	enqueueRetain(content: string, context?: unknown): void;
	flushRetainQueue(): Promise<void>;
	beforeAgentStartPrompt(promptText: string): Promise<string | undefined>;
	recallForContext(query: string, signal?: AbortSignal): Promise<{ context: string | null; ok: boolean }>;
	recallForCompaction(messages: unknown): Promise<string | undefined>;
	forceRetainCurrentSession(): Promise<void>;
	maybeRetainOnAgentEnd(): Promise<void>;
	attachSessionListeners(): void;
	dispose(): void;
	search(query: string, options?: MemoryBackendSearchOptions): Promise<MemoryBackendSearchResult>;
	save(input: string | MemoryBackendSaveInput): Promise<MemoryBackendSaveResult>;
}

// --- Recorded request types -------------------------------------------------

export interface RecordedCogneeRequest {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: RecordedCogneeBody;
	signal?: AbortSignal | null;
}

export type RecordedCogneeBody =
	| { kind: "json"; value: unknown }
	| { kind: "form"; fields: Record<string, RecordedCogneeFormValue[]> }
	| { kind: "text"; value: string }
	| { kind: "raw"; value: unknown }
	| null;

export type RecordedCogneeFormValue = string | { kind: "blob"; type: string; size: number; text?: string };

// --- Fake fetch -------------------------------------------------------------

export interface FakeCogneeFetchResponse {
	status?: number;
	body?: unknown;
	text?: string;
	headers?: ConstructorParameters<typeof Headers>[0];
}

export function createFakeCogneeFetch(responses: FakeCogneeFetchResponse[]): {
	fetch: typeof fetch;
	requests: RecordedCogneeRequest[];
} {
	const requests: RecordedCogneeRequest[] = [];
	const queue = [...responses];
	const fetchImpl = asGlobalFetch(async (input, init) => {
		const requestUrl = toUrl(input);
		const path = requestUrl.pathname + requestUrl.search;
		const method = (init?.method ?? (input instanceof Request ? input.method : undefined) ?? "GET").toUpperCase();
		const headers = normalizeHeaders(input, init?.headers);
		const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
		const body = await snapshotBody(input, init?.body);
		requests.push({ method, path, headers, body, signal });

		const response = queue.shift();
		if (!response) {
			throw new Error(`No fake Cognee response queued for ${method} ${path}`);
		}
		const status = response.status ?? 200;
		if (response.text !== undefined) {
			return new Response(response.text, { status, headers: new Headers(response.headers) });
		}
		const headersOut = new Headers(response.headers);
		if (!headersOut.has("content-type")) {
			headersOut.set("content-type", "application/json");
		}
		return new Response(JSON.stringify(response.body ?? {}), { status, headers: headersOut });
	});
	return { fetch: fetchImpl, requests };
}

function toUrl(input: string | URL | Request): URL {
	if (input instanceof URL) return input;
	if (input instanceof Request) return new URL(input.url);
	return new URL(input);
}

function normalizeHeaders(
	input: string | URL | Request,
	initHeaders: ConstructorParameters<typeof Headers>[0] | undefined,
): Record<string, string> {
	const merged = new Headers();
	if (input instanceof Request) {
		for (const [key, value] of input.headers) {
			merged.set(key, value);
		}
	}
	if (initHeaders !== undefined) {
		const incoming = new Headers(initHeaders);
		for (const [key, value] of incoming) {
			merged.set(key, value);
		}
	}
	const out: Record<string, string> = {};
	for (const [key, value] of merged) {
		out[key.toLowerCase()] = value;
	}
	return out;
}

async function snapshotBody(
	input: string | URL | Request,
	body: NonNullable<ConstructorParameters<typeof Request>[1]>["body"] | null | undefined,
): Promise<RecordedCogneeBody> {
	if (body === undefined && input instanceof Request) {
		const clone = input.clone();
		const contentType = (clone.headers.get("content-type") ?? "").toLowerCase();
		if (
			contentType.startsWith("multipart/form-data") ||
			contentType.startsWith("application/x-www-form-urlencoded")
		) {
			try {
				return { kind: "form", fields: await snapshotFormData(await clone.formData()) };
			} catch {
				// fall through to text/raw
			}
		}
		try {
			return parseTextBody(await clone.text());
		} catch {
			return { kind: "raw", value: input };
		}
	}
	if (body === null || body === undefined) return null;
	if (body instanceof FormData) return { kind: "form", fields: await snapshotFormData(body) };
	if (typeof body === "string") return parseTextBody(body);
	if (body instanceof URLSearchParams) return { kind: "text", value: body.toString() };
	if (body instanceof Blob) {
		let text: string | undefined;
		try {
			text = await body.text();
		} catch {
			text = undefined;
		}
		if (text !== undefined) return parseTextBody(text);
		return { kind: "raw", value: body };
	}
	return { kind: "raw", value: body };
}

function parseTextBody(text: string): RecordedCogneeBody {
	const parsed = safeJsonParse(text);
	return parsed.ok ? { kind: "json", value: parsed.value } : { kind: "text", value: text };
}

async function snapshotFormData(form: {
	entries(): IterableIterator<[string, string | Blob]>;
}): Promise<Record<string, RecordedCogneeFormValue[]>> {
	const fields: Record<string, RecordedCogneeFormValue[]> = {};
	for (const [key, value] of form.entries()) {
		const list = fields[key] ?? [];
		fields[key] = list;
		if (typeof value === "string") {
			list.push(value);
			continue;
		}
		const blob = value as Blob;
		const entry: { kind: "blob"; type: string; size: number; text?: string } = {
			kind: "blob",
			type: blob.type,
			size: blob.size,
		};
		try {
			entry.text = await blob.text();
		} catch {
			// Omit text; keep type and size.
		}
		list.push(entry);
	}
	return fields;
}

function safeJsonParse(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

// --- Fake CogneeClient ------------------------------------------------------

export interface FakeCogneeClientCall {
	method: keyof CogneeClient;
	args: unknown[];
}

export function createFakeCogneeClient(overrides?: Partial<CogneeClient>): CogneeClient & {
	calls: FakeCogneeClientCall[];
} {
	const calls: FakeCogneeClientCall[] = [];
	const record = (method: keyof CogneeClient, args: unknown[]): void => {
		calls.push({ method, args });
	};
	const base: CogneeClient = {
		remember: async (request: CogneeRememberRequest, signal?: AbortSignal): Promise<CogneeRememberResult> => {
			record("remember", [request, signal]);
			return overrides?.remember
				? overrides.remember(request, signal)
				: {
						status: "ok",
						datasetName: request.datasetName,
						datasetId: request.datasetId,
						raw: {},
					};
		},
		rememberEntry: async (
			request: CogneeRememberEntryRequest,
			signal?: AbortSignal,
		): Promise<CogneeRememberResult> => {
			record("rememberEntry", [request, signal]);
			return overrides?.rememberEntry
				? overrides.rememberEntry(request, signal)
				: {
						status: "ok",
						datasetName: request.datasetName,
						datasetId: request.datasetId,
						entryType: request.type,
						raw: {},
					};
		},
		recall: async (request: CogneeRecallRequest, signal?: AbortSignal) => {
			record("recall", [request, signal]);
			return overrides?.recall ? overrides.recall(request, signal) : ([] as CogneeRecallEntry[]);
		},
		improve: async (request: CogneeImproveRequest, signal?: AbortSignal) => {
			record("improve", [request, signal]);
			return overrides?.improve ? overrides.improve(request, signal) : ({} as Record<string, unknown>);
		},
		forget: async (request: CogneeForgetRequest, signal?: AbortSignal) => {
			record("forget", [request, signal]);
			return overrides?.forget ? overrides.forget(request, signal) : ({ ok: true } as unknown);
		},
		listDatasets: async (signal?: AbortSignal) => {
			record("listDatasets", [signal]);
			return overrides?.listDatasets ? overrides.listDatasets(signal) : ([] as CogneeDataset[]);
		},
		getDatasetStatus: async (request: CogneeDatasetStatusRequest, signal?: AbortSignal) => {
			record("getDatasetStatus", [request, signal]);
			return overrides?.getDatasetStatus ? overrides.getDatasetStatus(request, signal) : ({} as unknown);
		},
		listDatasetData: async (datasetId: string, signal?: AbortSignal) => {
			record("listDatasetData", [datasetId, signal]);
			return overrides?.listDatasetData ? overrides.listDatasetData(datasetId, signal) : ([] as unknown);
		},
		createDataset: async (request: CogneeCreateDatasetRequest, signal?: AbortSignal) => {
			record("createDataset", [request, signal]);
			return overrides?.createDataset
				? overrides.createDataset(request, signal)
				: ({
						name: request.name,
						status: "created",
						raw: {},
					} as CogneeCreateDatasetResponse);
		},
	};
	return Object.assign(base, { calls });
}

// --- Fake CogneeConfig ------------------------------------------------------

const DEFAULT_CONFIG: CogneeConfig = {
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
	chunkSize: 4096,
	chunksPerBatch: 36,
	customPrompt: null,
	nodeSet: [],
	ontologyKeys: [],
	graphModel: null,
	recallSearchType: "GRAPH_COMPLETION",
	recallScope: "auto",
	recallTopK: 10,
	recallContextTurns: 1,
	recallMaxQueryChars: 1200,
	recallMaxRenderChars: 12000,
	recallPromptPreamble:
		"Relevant Cognee memories from prior conversations and knowledge graph context. Use only when directly useful; verify against current repo state before acting.",
	onlyContext: false,
	verbose: false,
	improveOnEnqueue: true,
	buildGlobalContextIndex: false,
	sessionMemoryEnabled: false,
	debug: false,
};

export function createFakeCogneeConfig(overrides?: Partial<CogneeConfig>): CogneeConfig {
	const base: CogneeConfig = {
		...DEFAULT_CONFIG,
		nodeSet: [...DEFAULT_CONFIG.nodeSet],
		ontologyKeys: [...DEFAULT_CONFIG.ontologyKeys],
	};
	if (!overrides) return base;
	const merged: CogneeConfig = { ...base, ...overrides };
	if (overrides.nodeSet) merged.nodeSet = [...overrides.nodeSet];
	if (overrides.ontologyKeys) merged.ontologyKeys = [...overrides.ontologyKeys];
	return merged;
}

// --- Fake CogneeScope -------------------------------------------------------

const DEFAULT_SCOPE: CogneeScope = {
	label: "project:oh-my-pi",
	datasetName: "omp",
	retainDatasetLabel: "omp",
	recallDatasetLabels: ["omp"],
	recallDatasets: ["omp"],
	retainNodeSet: ["project:oh-my-pi"],
	projectLabel: "oh-my-pi",
	projectNode: "project:oh-my-pi",
	sessionId: "cognee-test-session",
};

export function createFakeCogneeScope(overrides?: Partial<CogneeScope>): CogneeScope {
	const base: CogneeScope = {
		...DEFAULT_SCOPE,
		recallDatasetLabels: [...(DEFAULT_SCOPE.recallDatasetLabels ?? [])],
		recallDatasets: [...(DEFAULT_SCOPE.recallDatasets ?? [])],
		retainNodeSet: [...(DEFAULT_SCOPE.retainNodeSet ?? [])],
	};
	if (!overrides) return base;
	const merged: CogneeScope = { ...base, ...overrides };
	if (overrides.recallDatasetLabels) merged.recallDatasetLabels = [...overrides.recallDatasetLabels];
	if (overrides.recallDatasets) merged.recallDatasets = [...overrides.recallDatasets];
	if (overrides.retainNodeSet) merged.retainNodeSet = [...overrides.retainNodeSet];
	if (overrides.recallDatasetIds) merged.recallDatasetIds = [...overrides.recallDatasetIds];
	if (overrides.recallNodeName) merged.recallNodeName = [...overrides.recallNodeName];
	return merged;
}

// --- Fake CogneeSessionState -----------------------------------------------

export interface FakeCogneeSessionStateCall {
	method: keyof CogneeSessionStateLike;
	args: unknown[];
}

export function createFakeCogneeSessionState(
	overrides?: Partial<CogneeSessionStateLike> & {
		client?: CogneeClient;
		config?: CogneeConfig;
		scope?: CogneeScope;
		calls?: FakeCogneeSessionStateCall[];
	},
): CogneeSessionStateLike & { calls: FakeCogneeSessionStateCall[] } {
	const sessionId = overrides?.sessionId ?? "cognee-test-session";
	const client = overrides?.client ?? createFakeCogneeClient();
	const config = overrides?.config ?? createFakeCogneeConfig();
	const scope = overrides?.scope ?? createFakeCogneeScope({ sessionId });
	const session = overrides?.session ?? ({ sessionId } as never);
	const calls: FakeCogneeSessionStateCall[] = overrides?.calls ?? [];
	const record = (method: keyof CogneeSessionStateLike, args: unknown[]): void => {
		calls.push({ method, args });
	};

	const state: CogneeSessionStateLike = {
		sessionId,
		client,
		config,
		scope,
		session,
		aliasOf: overrides?.aliasOf,
		lastRecallSnippet: overrides?.lastRecallSnippet,
		lastRetainedAtIso: overrides?.lastRetainedAtIso,
		lastRetainedTurn: overrides?.lastRetainedTurn ?? 0,
		hasRecalledForFirstTurn: overrides?.hasRecalledForFirstTurn ?? Boolean(overrides?.aliasOf),
		setSessionId(next: string) {
			record("setSessionId", [next]);
			if (overrides?.setSessionId) {
				overrides.setSessionId(next);
				return;
			}
			state.sessionId = next;
			if (state.scope && "sessionId" in state.scope && state.scope.sessionId !== undefined) {
				state.scope.sessionId = next;
			}
		},
		resetConversationTracking() {
			record("resetConversationTracking", []);
			if (overrides?.resetConversationTracking) {
				overrides.resetConversationTracking();
				return;
			}
			state.lastRecallSnippet = undefined;
			state.lastRetainedAtIso = undefined;
			state.lastRetainedTurn = undefined;
			state.hasRecalledForFirstTurn = false;
		},
		enqueueRetain(content: string, context?: unknown) {
			record("enqueueRetain", [content, context]);
			if (overrides?.enqueueRetain) overrides.enqueueRetain(content, context);
		},
		async flushRetainQueue() {
			record("flushRetainQueue", []);
			if (overrides?.flushRetainQueue) await overrides.flushRetainQueue();
		},
		async beforeAgentStartPrompt(promptText: string) {
			record("beforeAgentStartPrompt", [promptText]);
			if (overrides?.beforeAgentStartPrompt) return overrides.beforeAgentStartPrompt(promptText);
			return undefined;
		},
		async recallForContext(query: string, signal?: AbortSignal) {
			record("recallForContext", [query, signal]);
			if (overrides?.recallForContext) return overrides.recallForContext(query, signal);
			return { context: null, ok: true };
		},
		async recallForCompaction(messages: unknown) {
			record("recallForCompaction", [messages]);
			if (overrides?.recallForCompaction) return overrides.recallForCompaction(messages);
			return undefined;
		},
		async forceRetainCurrentSession() {
			record("forceRetainCurrentSession", []);
			if (overrides?.forceRetainCurrentSession) await overrides.forceRetainCurrentSession();
		},
		async maybeRetainOnAgentEnd() {
			record("maybeRetainOnAgentEnd", []);
			if (overrides?.maybeRetainOnAgentEnd) await overrides.maybeRetainOnAgentEnd();
		},
		attachSessionListeners() {
			record("attachSessionListeners", []);
			if (overrides?.attachSessionListeners) overrides.attachSessionListeners();
		},
		dispose() {
			record("dispose", []);
			if (overrides?.dispose) overrides.dispose();
		},
		async search(query: string, options?: MemoryBackendSearchOptions) {
			record("search", [query, options]);
			if (overrides?.search) return overrides.search(query, options);
			// `backend: "cognee"` is part of the frozen contract status shape but the
			// sibling `MemoryBackendId` widening has not joined this branch yet.
			return {
				backend: "cognee",
				query,
				count: 0,
				items: [],
			} as unknown as MemoryBackendSearchResult;
		},
		async save(input: string | MemoryBackendSaveInput) {
			record("save", [input]);
			if (overrides?.save) return overrides.save(input);
			return { backend: "cognee", stored: 1 } as unknown as MemoryBackendSaveResult;
		},
	};

	return Object.assign(state, { calls });
}
