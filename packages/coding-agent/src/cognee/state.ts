import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { MemoryBackendSaveInput, MemoryBackendSaveResult, MemoryBackendSearchResult } from "../memory-backend";
import type { AgentSession } from "../session/agent-session";
import {
	type CogneeClient,
	CogneeError,
	type CogneeRecallEntry,
	type CogneeRecallRequest,
	type CogneeRememberDataItem,
	type CogneeRememberRequest,
	type CogneeRememberResult,
} from "./client";
import type { CogneeConfig } from "./config";
import {
	type CogneeMessage,
	type CogneeRetentionDocument,
	composeCogneeRecallQuery,
	flattenMessagesForCognee,
	formatCogneeDocumentFilename,
	formatCogneeRecallBlock,
	formatCogneeSearchItem,
	prepareCogneeRetentionDocument,
	truncateCogneeRecallQuery,
} from "./content";
import type { CogneeScope } from "./scope";

const COGNEE_RETAIN_FLUSH_BATCH_SIZE = 16;
const COGNEE_RETAIN_FLUSH_INTERVAL_MS = 5_000;
const COGNEE_RETAIN_QUEUE_MAX_ITEMS = 128;
const COGNEE_NOTICE_SOURCE = "Cognee";

// `MemoryBackendId` does not yet include `"cognee"` in this integrated base;
// `CogneeBackendAdapter` will widen the shared type. Until then, cast the
// literal locally so `search`/`save` results carry the truthful backend name
// without editing `memory-backend/types.ts` from this workpackage.
const COGNEE_BACKEND = "cognee" as MemoryBackendSearchResult["backend"];

const kCogneeSessionState = Symbol("cognee.sessionState");

interface AgentSessionWithCogneeState extends AgentSession {
	[kCogneeSessionState]?: CogneeSessionStateLike;
}

interface PendingCogneeRetainItem {
	content: string;
	context?: string;
	timestamp: Date;
}

interface RecallOutcome {
	context: string | null;
	ok: boolean;
}

export interface CogneeSessionStateOptions {
	sessionId: string;
	client: CogneeClient;
	config: CogneeConfig;
	scope: CogneeScope;
	session: AgentSession;
	lastRetainedTurn?: number;
	hasRecalledForFirstTurn?: boolean;
	aliasOf?: CogneeSessionStateLike;
}

export interface CogneeSessionStateLike {
	readonly sessionId: string;
	readonly client: CogneeClient;
	readonly config: CogneeConfig;
	readonly scope: CogneeScope;
	readonly session: AgentSession;
	readonly aliasOf?: CogneeSessionStateLike;
	readonly lastRecallSnippet?: string;
	readonly lastRetainedAtIso?: string;
	readonly lastRetainedTurn: number;
	readonly hasRecalledForFirstTurn: boolean;

	setSessionId(sessionId: string): void;
	resetConversationTracking(): void;
	enqueueRetain(content: string, context?: string): void;
	flushRetainQueue(): Promise<void>;
	beforeAgentStartPrompt(promptText: string): Promise<string | undefined>;
	recallForContext(query: string, signal?: AbortSignal): Promise<{ context: string | null; ok: boolean }>;
	recallForCompaction(messages: AgentMessage[]): Promise<string | undefined>;
	forceRetainCurrentSession(): Promise<void>;
	maybeRetainOnAgentEnd(): Promise<void>;
	attachSessionListeners(): void;
	dispose(): void | Promise<void>;

	search(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<MemoryBackendSearchResult>;
	save(input: MemoryBackendSaveInput): Promise<MemoryBackendSaveResult>;
}

export function getCogneeSessionState(session: AgentSession | undefined): CogneeSessionStateLike | undefined {
	return session ? (session as AgentSessionWithCogneeState)[kCogneeSessionState] : undefined;
}

export function setCogneeSessionState(
	session: AgentSession,
	state: CogneeSessionStateLike | undefined,
): CogneeSessionStateLike | undefined {
	const typed = session as AgentSessionWithCogneeState;
	const previous = typed[kCogneeSessionState];
	if (state) typed[kCogneeSessionState] = state;
	else delete typed[kCogneeSessionState];
	return previous;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function cogneeErrorDetailsText(details: unknown): string {
	if (!details || typeof details !== "object") return "";
	const record = details as Record<string, unknown>;
	return [record.detail, record.message, record.error].filter(value => typeof value === "string").join("\n");
}

function isRecallPrerequisitesError(err: unknown): boolean {
	if (!(err instanceof CogneeError) || err.status !== 404) return false;
	return cogneeErrorDetailsText(err.details).toLowerCase().includes("recall prerequisites");
}

function buildRecallRequest(state: CogneeSessionState, query: string, topK: number): CogneeRecallRequest {
	const { config, scope } = state;
	return {
		query,
		searchType: config.recallSearchType,
		datasets: scope.recallDatasets,
		datasetIds: scope.recallDatasetIds,
		nodeName: scope.recallNodeName,
		topK,
		onlyContext: config.onlyContext,
		verbose: config.verbose,
		sessionId: config.sessionMemoryEnabled ? state.sessionId : undefined,
		scope: config.recallScope === "auto" ? undefined : config.recallScope,
	};
}

function buildRememberBaseRequest(state: CogneeSessionState): Omit<CogneeRememberRequest, "data"> {
	const { config, scope } = state;
	return {
		datasetName: scope.datasetName,
		datasetId: scope.datasetId,
		sessionId: state.config.sessionMemoryEnabled ? state.sessionId : undefined,
		nodeSet: scope.retainNodeSet,
		runInBackground: config.runInBackground,
		customPrompt: config.customPrompt ?? undefined,
		chunkSize: config.chunkSize ?? undefined,
		chunksPerBatch: config.chunksPerBatch ?? undefined,
		ontologyKeys: config.ontologyKeys,
		graphModel: config.graphModel ?? undefined,
	};
}

function collectSessionMessages(session: AgentSession, eventMessages?: AgentMessage[]): AgentMessage[] {
	if (eventMessages) return eventMessages;
	const entries = session.sessionManager.getEntries();
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "message") messages.push(entry.message);
	}
	return messages;
}

function latestUserMessage(messages: CogneeMessage[]): CogneeMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return messages[i];
	}
	return undefined;
}

function formatScopeHeader(state: CogneeSessionState): string[] {
	const lines = [`Session: ${state.sessionId}`];
	if (state.scope.label) lines.push(`Scope: ${state.scope.label}`);
	if (state.scope.projectLabel) lines.push(`Project: ${state.scope.projectLabel}`);
	return lines;
}

function cogneeDocumentLabel(state: CogneeSessionState): string {
	return path.basename(state.session.sessionManager.getCwd()) || "unknown";
}

function cogneeDocumentFilename(state: CogneeSessionState, retainedAt: Date, suffix?: string): string {
	return formatCogneeDocumentFilename(retainedAt, cogneeDocumentLabel(state), suffix);
}

function formatExplicitRetainDocument(
	state: CogneeSessionState,
	item: PendingCogneeRetainItem,
	suffix?: string,
): CogneeRememberDataItem {
	const header = formatScopeHeader(state);
	header.push(`Retained at: ${item.timestamp.toISOString()}`);
	header.push(`Context: ${item.context ?? state.config.retainContext}`);
	header.push(`Source: explicit-retain`);
	return {
		content: `${header.join("\n")}\n\n${item.content}`,
		filename: cogneeDocumentFilename(state, item.timestamp, suffix),
	};
}

function formatSaveDocument(
	state: CogneeSessionState,
	input: MemoryBackendSaveInput,
	retainedAt: Date,
): CogneeRememberDataItem {
	const header = formatScopeHeader(state);
	header.push(`Retained at: ${retainedAt.toISOString()}`);
	header.push(`Context: ${input.context ?? state.config.retainContext}`);
	if (input.source) header.push(`Source: ${input.source}`);
	if (typeof input.importance === "number") header.push(`Importance: ${input.importance}`);
	return {
		content: `${header.join("\n")}\n\n${input.content}`,
		filename: cogneeDocumentFilename(state, retainedAt),
	};
}

function rememberIds(result: CogneeRememberResult): string[] | undefined {
	const ids: string[] = [];
	if (result.entryId) ids.push(result.entryId);
	if (result.contentHash) ids.push(result.contentHash);
	if (result.pipelineRunId) ids.push(result.pipelineRunId);
	return ids.length > 0 ? ids : undefined;
}

function isQueuedRemember(result: CogneeRememberResult, config: CogneeConfig): boolean {
	if (config.runInBackground) return true;
	const status = (result.status ?? "").toLowerCase();
	if (!status) return false;
	return /background|queued|running|in-progress|in_progress|pending|accepted/.test(status);
}

/**
 * Primary-only debounced batch queue for explicit tool-initiated retains.
 *
 * Mirrors the Hindsight retain-queue pattern with a Cognee-specific bounded
 * depth (`COGNEE_RETAIN_QUEUE_MAX_ITEMS`), batch flush threshold, and a
 * coalesced in-flight flush. Client failures are swallowed and surfaced as a
 * `Cognee` warning notice; the queue never requeues a failed batch.
 */
class CogneeRetainQueue {
	readonly #state: CogneeSessionState;
	#items: PendingCogneeRetainItem[] = [];
	#timer?: NodeJS.Timeout;
	#flushing?: Promise<void>;
	#closed = false;

	constructor(state: CogneeSessionState) {
		this.#state = state;
	}

	get depth(): number {
		return this.#items.length;
	}

	enqueue(content: string, context?: string): void {
		if (this.#closed) {
			throw new Error("Cognee retain queue is closed.");
		}
		// Reject all-whitespace content without trimming stored text. Tool
		// validation should catch empty input upstream; this is a defensive
		// no-op so we never send an empty document to Cognee.
		if (content.trim().length === 0) return;

		this.#items.push({ content, context, timestamp: new Date() });

		if (this.#items.length > COGNEE_RETAIN_QUEUE_MAX_ITEMS) {
			const dropped = this.#items.shift();
			logger.warn("Cognee retain queue exceeded max items; dropped oldest pending memory", {
				sessionId: this.#state.sessionId,
				droppedTimestamp: dropped?.timestamp.toISOString(),
			});
			this.#state.session.emitNotice(
				"warning",
				"Cognee retain queue exceeded 128 items; dropped oldest pending memory.",
				COGNEE_NOTICE_SOURCE,
			);
		}

		if (this.#items.length >= COGNEE_RETAIN_FLUSH_BATCH_SIZE) {
			void this.flush();
			return;
		}
		if (!this.#timer) {
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				void this.flush();
			}, COGNEE_RETAIN_FLUSH_INTERVAL_MS);
			// Don't pin the event loop alive just for a pending retain flush.
			this.#timer.unref?.();
		}
	}

	async flush(): Promise<void> {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}

		if (this.#flushing) {
			// Coalesce: wait for the in-flight flush, then drain anything that
			// landed after it started so we don't strand items.
			await this.#flushing;
			if (this.#items.length > 0) await this.flush();
			return;
		}

		if (this.#items.length === 0) return;

		const items = this.#items.splice(0);
		const flushPromise = this.#doFlush(items);
		this.#flushing = flushPromise;
		try {
			await flushPromise;
		} finally {
			this.#flushing = undefined;
		}
	}

	/** Stop accepting new items and clear timers without dropping in-flight items. */
	close(): void {
		this.#closed = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	/** Drop all leftover items after a final flush has been attempted. */
	drop(): void {
		this.#closed = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#items = [];
	}

	async #doFlush(items: PendingCogneeRetainItem[]): Promise<void> {
		const state = this.#state;
		// Identity guard: if the session no longer points at this state, the
		// state was cleared before flush completed. We can't notify anyone, so
		// log and drop — these are best-effort facts, not transactional writes.
		if (getCogneeSessionState(state.session) !== state) {
			logger.warn("Cognee retain queue: session state vanished, dropping batch", {
				sessionId: state.sessionId,
				items: items.length,
			});
			return;
		}

		try {
			const documents = items.map((item, index) =>
				formatExplicitRetainDocument(
					state,
					item,
					items.length > 1 ? String(index + 1).padStart(2, "0") : undefined,
				),
			);
			const base = buildRememberBaseRequest(state);
			await state.client.remember({ ...base, data: documents });
			if (state.config.debug) {
				logger.debug("Cognee retain queue: batch flushed", {
					sessionId: state.sessionId,
					items: items.length,
				});
			}
		} catch (err) {
			const text = errorText(err);
			logger.warn("Cognee retain queue: batch flush failed", {
				sessionId: state.sessionId,
				items: items.length,
				error: text,
			});
			const noun = items.length === 1 ? "memory" : "memories";
			state.session.emitNotice(
				"warning",
				`Memory retention failed for ${items.length} ${noun}: ${text}`,
				COGNEE_NOTICE_SOURCE,
			);
			// Do not requeue the failed batch.
		}
	}
}

/**
 * Per-session Cognee runtime state owned by its `AgentSession`.
 *
 * Primary state owns the retain queue and session listeners. Alias state
 * (subagents) reuses the parent's `client`/`config`/`scope`, forces
 * `hasRecalledForFirstTurn` to `true`, attaches no listeners, and delegates
 * explicit tool-facing operations to the parent primary state.
 */
export class CogneeSessionState implements CogneeSessionStateLike {
	sessionId: string;
	readonly client: CogneeClient;
	readonly config: CogneeConfig;
	readonly scope: CogneeScope;
	readonly session: AgentSession;
	readonly aliasOf?: CogneeSessionStateLike;
	lastRecallSnippet?: string;
	lastRetainedAtIso?: string;
	lastRetainedTurn: number;
	hasRecalledForFirstTurn: boolean;

	#retainQueue?: CogneeRetainQueue;
	#unsubscribe?: () => void;
	#improveAttempted = false;
	#disposePromise?: Promise<void>;
	#recallPrereqRecovery?: Promise<void>;
	#recallPrereqRecovered = false;

	constructor(options: CogneeSessionStateOptions) {
		this.session = options.session;
		this.sessionId = options.sessionId;

		if (options.aliasOf) {
			const parent = options.aliasOf;
			this.aliasOf = parent;
			this.client = parent.client;
			this.config = parent.config;
			this.scope = parent.scope;
			this.hasRecalledForFirstTurn = true;
			this.lastRetainedTurn = options.lastRetainedTurn ?? 0;
			// Aliases carry no queue and no listeners.
			return;
		}

		this.client = options.client;
		this.config = options.config;
		this.scope = options.scope;
		this.lastRetainedTurn = options.lastRetainedTurn ?? 0;
		this.hasRecalledForFirstTurn = options.hasRecalledForFirstTurn ?? false;
		this.#retainQueue = new CogneeRetainQueue(this);
	}

	setSessionId(sessionId: string): void {
		this.sessionId = sessionId;
	}

	resetConversationTracking(): void {
		if (this.aliasOf) {
			// Aliases keep the first-turn flag effectively true; never reset parent.
			this.hasRecalledForFirstTurn = true;
			return;
		}
		this.lastRetainedTurn = 0;
		this.hasRecalledForFirstTurn = false;
		this.lastRecallSnippet = undefined;
		this.lastRetainedAtIso = undefined;
	}

	enqueueRetain(content: string, context?: string): void {
		if (this.aliasOf) {
			this.aliasOf.enqueueRetain(content, context);
			return;
		}
		this.#resetRecallPrereqRecovery();
		this.#retainQueue?.enqueue(content, context);
	}
	#resetRecallPrereqRecovery(): void {
		this.#recallPrereqRecovery = undefined;
		this.#recallPrereqRecovered = false;
	}

	#abortError(signal: AbortSignal): Error {
		const reason = signal.reason;
		return reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
	}

	async #recoverRecallPrerequisites(signal?: AbortSignal): Promise<void> {
		if (this.#recallPrereqRecovered) return;
		if (signal?.aborted) throw this.#abortError(signal);
		this.#recallPrereqRecovery ??= this.client
			.improve(
				{
					datasetName: this.scope.datasetName,
					datasetId: this.scope.datasetId,
					sessionIds: this.config.sessionMemoryEnabled ? [this.sessionId] : undefined,
					nodeName: this.scope.recallNodeName,
					runInBackground: false,
					buildGlobalContextIndex: this.config.buildGlobalContextIndex,
				},
				signal,
			)
			.then(() => {
				this.#recallPrereqRecovered = true;
			})
			.finally(() => {
				this.#recallPrereqRecovery = undefined;
			});
		await this.#recallPrereqRecovery;
	}

	async #recallWithPrerequisiteRecovery(
		request: CogneeRecallRequest,
		signal?: AbortSignal,
	): Promise<CogneeRecallEntry[]> {
		try {
			return await this.client.recall(request, signal);
		} catch (err) {
			if (!isRecallPrerequisitesError(err)) throw err;
			await this.#recoverRecallPrerequisites(signal);
			if (signal?.aborted) throw this.#abortError(signal);
			return await this.client.recall(request, signal);
		}
	}

	flushRetainQueue(): Promise<void> {
		if (this.aliasOf) {
			return this.aliasOf.flushRetainQueue();
		}
		return this.#retainQueue?.flush() ?? Promise.resolve();
	}

	async recallForContext(query: string, signal?: AbortSignal): Promise<RecallOutcome> {
		if (this.aliasOf) {
			return this.aliasOf.recallForContext(query, signal);
		}
		try {
			const request = buildRecallRequest(this, query, this.config.recallTopK);
			const entries: CogneeRecallEntry[] = await this.#recallWithPrerequisiteRecovery(request, signal);
			if (signal?.aborted) return { context: null, ok: false };
			const block = formatCogneeRecallBlock(entries, this.config, this.scope);
			return { context: block ?? null, ok: true };
		} catch (err) {
			if (this.config.debug) {
				logger.debug("Cognee: recall failed", { sessionId: this.sessionId, error: errorText(err) });
			}
			return { context: null, ok: false };
		}
	}

	async beforeAgentStartPrompt(promptText: string): Promise<string | undefined> {
		if (this.aliasOf) return undefined;
		if (!this.config.autoRecall || this.hasRecalledForFirstTurn) return undefined;

		const latestPrompt = promptText.trim();
		if (!latestPrompt) return undefined;

		const history = flattenMessagesForCognee(collectSessionMessages(this.session));
		const queryMessages: CogneeMessage[] = [...history, { role: "user", content: latestPrompt }];
		const query = composeCogneeRecallQuery(latestPrompt, queryMessages, this.config.recallContextTurns, this.scope);
		const truncated = truncateCogneeRecallQuery(query, latestPrompt, this.config.recallMaxQueryChars);

		const { context, ok } = await this.recallForContext(truncated);
		if (!ok) return undefined;

		this.hasRecalledForFirstTurn = true;
		if (!context) return undefined;

		this.lastRecallSnippet = context;
		return context;
	}

	async #maybeRecallOnAgentStart(): Promise<void> {
		if (this.aliasOf) return;
		if (!this.config.autoRecall || this.hasRecalledForFirstTurn) return;

		const flattened = flattenMessagesForCognee(collectSessionMessages(this.session));
		const lastUser = latestUserMessage(flattened);
		if (!lastUser) return;

		const query = composeCogneeRecallQuery(lastUser.content, flattened, this.config.recallContextTurns, this.scope);
		const truncated = truncateCogneeRecallQuery(query, lastUser.content, this.config.recallMaxQueryChars);

		const { context, ok } = await this.recallForContext(truncated);
		if (!ok) return;

		this.hasRecalledForFirstTurn = true;
		if (!context) return;

		this.lastRecallSnippet = context;
		try {
			await this.session.refreshBaseSystemPrompt();
		} catch (err) {
			logger.debug("Cognee: refreshBaseSystemPrompt after agent_start recall failed", {
				error: errorText(err),
			});
		}
	}

	async recallForCompaction(messages: AgentMessage[]): Promise<string | undefined> {
		if (this.aliasOf) {
			return this.aliasOf.recallForCompaction(messages);
		}
		const flattened = flattenMessagesForCognee(messages);
		const lastUser = latestUserMessage(flattened);
		if (!lastUser) return undefined;

		const query = composeCogneeRecallQuery(lastUser.content, flattened, this.config.recallContextTurns, this.scope);
		const truncated = truncateCogneeRecallQuery(query, lastUser.content, this.config.recallMaxQueryChars);
		const { context } = await this.recallForContext(truncated);
		return context ?? undefined;
	}

	async #retainCurrentTranscript(
		messages: CogneeMessage[],
		retainedAt = new Date(),
	): Promise<{ retained: boolean; userTurns: number }> {
		if (this.aliasOf) return { retained: false, userTurns: 0 };
		const userTurns = messages.filter(m => m.role === "user").length;
		const retainEveryNTurns = Math.max(1, this.config.retainEveryNTurns);
		const retainOverlapTurns = Math.max(0, this.config.retainOverlapTurns);

		const document: CogneeRetentionDocument | null = prepareCogneeRetentionDocument({
			messages,
			sessionId: this.sessionId,
			retainedAt,
			mode: this.config.retainMode,
			retainEveryNTurns,
			retainOverlapTurns,
			scope: this.scope,
			documentLabel: cogneeDocumentLabel(this),
		});
		if (!document) return { retained: false, userTurns };

		const base = buildRememberBaseRequest(this);
		await this.client.remember({ ...base, data: { content: document.content, filename: document.filename } });
		this.#resetRecallPrereqRecovery();
		return { retained: true, userTurns };
	}

	async #maybeRetainOnAgentEnd(eventMessages?: AgentMessage[]): Promise<void> {
		if (this.aliasOf) return;
		if (!this.config.autoRetain) return;

		const flattened = flattenMessagesForCognee(collectSessionMessages(this.session, eventMessages));
		if (flattened.length === 0) return;

		const retainEveryNTurns = Math.max(1, this.config.retainEveryNTurns);
		const userTurns = flattened.filter(m => m.role === "user").length;
		if (userTurns - this.lastRetainedTurn < retainEveryNTurns) return;

		const retainedAt = new Date();
		try {
			const result = await this.#retainCurrentTranscript(flattened, retainedAt);
			if (!result.retained) return;
			this.lastRetainedTurn = result.userTurns;
			this.lastRetainedAtIso = retainedAt.toISOString();
			if (this.config.debug) {
				logger.debug("Cognee: auto-retain succeeded", {
					sessionId: this.sessionId,
					userTurns: result.userTurns,
					messages: flattened.length,
				});
			}
		} catch (err) {
			logger.warn("Cognee: auto-retain failed", {
				sessionId: this.sessionId,
				error: errorText(err),
			});
		}
	}

	async maybeRetainOnAgentEnd(): Promise<void> {
		await this.#maybeRetainOnAgentEnd();
	}

	async forceRetainCurrentSession(): Promise<void> {
		if (this.aliasOf) return;
		const flattened = flattenMessagesForCognee(collectSessionMessages(this.session));
		if (flattened.length === 0) return;

		const retainedAt = new Date();
		try {
			const result = await this.#retainCurrentTranscript(flattened, retainedAt);
			if (!result.retained) return;
			this.lastRetainedTurn = result.userTurns;
			this.lastRetainedAtIso = retainedAt.toISOString();
		} catch (err) {
			logger.warn("Cognee: forced retain failed", {
				sessionId: this.sessionId,
				error: errorText(err),
			});
		}
	}

	async #handleAgentEnd(eventMessages?: AgentMessage[]): Promise<void> {
		await this.#maybeRetainOnAgentEnd(eventMessages);
		await this.flushRetainQueue();
	}

	attachSessionListeners(): void {
		if (this.aliasOf) return;
		// Reattach cleanly: unsubscribe any prior listener before subscribing.
		this.#unsubscribe?.();
		this.#unsubscribe = this.session.subscribe(event => {
			if (event.type === "agent_start") {
				void this.#maybeRecallOnAgentStart();
			} else if (event.type === "agent_end") {
				void this.#handleAgentEnd(event.messages);
			}
		});
	}

	async search(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<MemoryBackendSearchResult> {
		if (this.aliasOf) {
			return this.aliasOf.search(query, options);
		}
		const trimmed = query.trim();
		if (!trimmed) {
			return {
				backend: COGNEE_BACKEND,
				query,
				count: 0,
				items: [],
				message: "Empty query.",
			};
		}

		const request = buildRecallRequest(this, trimmed, options?.limit ?? this.config.recallTopK);
		try {
			const entries = await this.#recallWithPrerequisiteRecovery(request, options?.signal);
			const items = entries.map(formatCogneeSearchItem);
			return { backend: COGNEE_BACKEND, query: trimmed, count: items.length, items };
		} catch (err) {
			const text = errorText(err);
			if (this.config.debug) {
				logger.debug("Cognee: search failed", { sessionId: this.sessionId, error: text });
			}
			return {
				backend: COGNEE_BACKEND,
				query: trimmed,
				count: 0,
				items: [],
				message: `Cognee recall failed: ${text}`,
			};
		}
	}

	async save(input: MemoryBackendSaveInput): Promise<MemoryBackendSaveResult> {
		if (this.aliasOf) {
			return this.aliasOf.save(input);
		}
		const trimmed = input.content.trim();
		if (!trimmed) {
			return {
				backend: COGNEE_BACKEND,
				stored: 0,
				message: "Empty memory content.",
			};
		}

		const retainedAt = new Date();
		try {
			const document = formatSaveDocument(this, input, retainedAt);
			const base = buildRememberBaseRequest(this);
			const result = await this.client.remember({ ...base, data: document });
			this.#resetRecallPrereqRecovery();
			return {
				backend: COGNEE_BACKEND,
				stored: 1,
				ids: rememberIds(result),
				queued: isQueuedRemember(result, this.config),
			};
		} catch (err) {
			const text = errorText(err);
			if (this.config.debug) {
				logger.debug("Cognee: save failed", { sessionId: this.sessionId, error: text });
			}
			return {
				backend: COGNEE_BACKEND,
				stored: 0,
				message: `Cognee save failed: ${text}`,
			};
		}
	}

	async #maybeImproveOnDispose(): Promise<void> {
		if (this.aliasOf) return;
		if (this.#improveAttempted) return;
		this.#improveAttempted = true;

		if (!this.config.improveOnEnqueue || !this.config.sessionMemoryEnabled) return;

		try {
			await this.client.improve({
				datasetName: this.scope.datasetName,
				datasetId: this.scope.datasetId,
				sessionIds: [this.sessionId],
				nodeName: this.scope.recallNodeName,
				runInBackground: this.config.runInBackground,
				buildGlobalContextIndex: this.config.buildGlobalContextIndex,
			});
		} catch (err) {
			const text = errorText(err);
			logger.warn("Cognee: session-end improve failed", { sessionId: this.sessionId, error: text });
			// Only surface when the message is actionable for the user.
			if (text) {
				this.session.emitNotice("warning", `Cognee session-end improve failed: ${text}`, COGNEE_NOTICE_SOURCE);
			}
		}
	}
	dispose(): void | Promise<void> {
		if (this.aliasOf) return;
		if (this.#disposePromise) return this.#disposePromise;

		this.#disposePromise = (async () => {
			this.#unsubscribe?.();
			this.#unsubscribe = undefined;
			this.#retainQueue?.close();
			if (getCogneeSessionState(this.session) === this) {
				try {
					await this.flushRetainQueue();
				} catch (err) {
					logger.warn("Cognee: dispose flush failed", { sessionId: this.sessionId, error: errorText(err) });
				}
			}
			await this.#maybeImproveOnDispose();
			this.#retainQueue?.drop();
		})();
		return this.#disposePromise;
	}
}
