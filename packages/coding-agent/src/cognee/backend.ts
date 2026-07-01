/**
 * Cognee memory backend.
 *
 * Wires the per-session lifecycle (recall on first turn, retain every Nth
 * agent_end, etc.) on top of the AgentSession event stream. Cognee runtime
 * state is owned by the AgentSession via the `./state` side channel so
 * lifetime follows the actual domain owner instead of a parallel session-id
 * registry. All HTTP access is behind `CogneeClient`; this module never
 * calls `fetch` directly.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { onCogneeScopeChanged, type Settings } from "../config/settings";
import type {
	MemoryBackend,
	MemoryBackendOperationContext,
	MemoryBackendSaveInput,
	MemoryBackendSaveResult,
	MemoryBackendSearchOptions,
	MemoryBackendSearchResult,
	MemoryBackendStartOptions,
	MemoryBackendStatus,
} from "../memory-backend/types";
import type { AgentSession } from "../session/agent-session";
import { type CogneeClient, createCogneeClient } from "./client";
import { type CogneeConfig, isCogneeConfigured, loadCogneeConfig } from "./config";
import { truncateApproxTokensOrChars } from "./content";
import { type CogneeScope, computeCogneeScope } from "./scope";
import { CogneeSessionState, type CogneeSessionStateLike, getCogneeSessionState, setCogneeSessionState } from "./state";

const STATIC_INSTRUCTIONS =
	"## Cognee Memory\n\n" +
	"A Cognee knowledge graph/session-memory backend may provide relevant memories. " +
	"Treat them as heuristic context, not authority. Prefer current user instructions " +
	"and current repository evidence when they conflict. When memory affects a plan, " +
	"verify with live repo/tool evidence before acting.";

const INERT_MESSAGE = "Cognee backend is not initialised for this session.";

interface PrimaryRebuildTask {
	pending: boolean;
}

const primaryRebuildTasks = new WeakMap<AgentSession, PrimaryRebuildTask>();
const primaryInstallTasks = new WeakMap<AgentSession, Promise<CogneeSessionStateLike | undefined>>();
const scopeUnsubscribes = new WeakMap<AgentSession, () => void>();

/** Dispose a state best-effort; log disposal errors at debug/warn level. */
async function disposeState(state: CogneeSessionStateLike | undefined): Promise<void> {
	if (!state) return;
	try {
		await state.dispose();
	} catch (err) {
		logger.debug("Cognee: state dispose failed", { error: String(err) });
	}
}

/** Flush a state's retain queue; let callers decide whether to catch. */
async function flushState(state: CogneeSessionStateLike | undefined): Promise<void> {
	if (!state) return;
	await state.flushRetainQueue();
}

/** Read, delete, and invoke the backend-local scope unsubscribe best-effort. */
function unsubscribeScope(session: AgentSession): void {
	const unsub = scopeUnsubscribes.get(session);
	if (unsub) {
		scopeUnsubscribes.delete(session);
		try {
			unsub();
		} catch (err) {
			logger.debug("Cognee: scope unsubscribe failed", { error: String(err) });
		}
	}
}

/** Clear installed state for a session: optional flush, unset, unsubscribe, dispose. */
async function clearInstalledState(session: AgentSession, options?: { flush?: boolean }): Promise<void> {
	const current = getCogneeSessionState(session);
	if (options?.flush) {
		try {
			await flushState(current);
		} catch (err) {
			logger.debug("Cognee: flush before clear failed", { error: String(err) });
		}
	}
	const previous = setCogneeSessionState(session, undefined);
	unsubscribeScope(session);
	if (previous && previous !== current) {
		await disposeState(previous);
	}
	await disposeState(current);
}

/** Order-sensitive string-array equality. */
function arraysEqual(a?: readonly string[], b?: readonly string[]): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/** Structural compare of two Cognee scopes for rebuild-skip decisions. */
function scopesEqual(a: CogneeScope, b: CogneeScope): boolean {
	return (
		a.datasetName === b.datasetName &&
		a.datasetId === b.datasetId &&
		a.retainDatasetLabel === b.retainDatasetLabel &&
		arraysEqual(a.recallDatasetLabels, b.recallDatasetLabels) &&
		arraysEqual(a.recallDatasets, b.recallDatasets) &&
		arraysEqual(a.recallDatasetIds, b.recallDatasetIds) &&
		arraysEqual(a.retainNodeSet, b.retainNodeSet) &&
		arraysEqual(a.recallNodeName, b.recallNodeName) &&
		a.sessionId === b.sessionId
	);
}

/** Structural compare of routing-relevant config fields for rebuild-skip. */
function configRoutingEqual(a: CogneeConfig, b: CogneeConfig): boolean {
	return (
		a.apiUrl === b.apiUrl &&
		a.apiKey === b.apiKey &&
		a.datasetName === b.datasetName &&
		a.datasetId === b.datasetId &&
		a.datasetNamePrefix === b.datasetNamePrefix &&
		a.scoping === b.scoping &&
		arraysEqual(a.nodeSet, b.nodeSet) &&
		a.sessionMemoryEnabled === b.sessionMemoryEnabled
	);
}

/** Resolve the primary state backing an alias (or the state itself if primary). */
function primaryState(session?: AgentSession): CogneeSessionStateLike | undefined {
	const state = getCogneeSessionState(session);
	return state?.aliasOf ?? state;
}

/** Resolve the best available session id for backend state creation. */
function resolveSessionId(session: AgentSession): string | undefined {
	const direct = session.sessionId;
	if (direct) return direct;
	const fallback = session.sessionManager.getSessionId();
	return fallback || undefined;
}

/**
 * Install state on demand when a memory tool runs before the async startup task
 * has finished (or startup ran before the session id was available).
 */
async function ensureInstalledState(session: AgentSession | undefined): Promise<CogneeSessionStateLike | undefined> {
	const current = getCogneeSessionState(session);
	if (current || !session) return current;
	if (session.settings.get("memory.backend") !== "cognee") return undefined;
	return await installPrimaryStateCoalesced(session, session.settings);
}

function installPrimaryStateCoalesced(
	session: AgentSession,
	settings: Settings,
): Promise<CogneeSessionStateLike | undefined> {
	const current = primaryInstallTasks.get(session);
	if (current) return current;
	const next = installPrimaryState(session, settings).finally(() => {
		if (primaryInstallTasks.get(session) === next) primaryInstallTasks.delete(session);
	});
	primaryInstallTasks.set(session, next);
	return next;
}

/**
 * Coalesce and serialize live scope rebuilds for one session. Cwd reloads fire
 * all settings hooks synchronously; running every callback immediately would
 * let multiple rebuilds capture the same old state and leak the fresh states
 * installed by earlier continuations.
 */
function schedulePrimaryStateRebuild(session: AgentSession): void {
	const task = primaryRebuildTasks.get(session);
	if (task) {
		task.pending = true;
		return;
	}

	const nextTask: PrimaryRebuildTask = { pending: true };
	primaryRebuildTasks.set(session, nextTask);
	void Promise.resolve()
		.then(async () => {
			while (nextTask.pending) {
				nextTask.pending = false;
				try {
					await rebuildPrimaryStateOnScopeChange(session);
				} catch (err) {
					logger.warn("Cognee: scope rebuild failed", { error: String(err) });
				}
			}
		})
		.finally(() => {
			if (primaryRebuildTasks.get(session) === nextTask) {
				primaryRebuildTasks.delete(session);
			}
		});
}

/**
 * `onCogneeScopeChanged` handler: re-evaluate the dataset scope from current
 * settings and rebuild the primary state when it has actually drifted. No-op
 * when the scope is unchanged or the session is no longer hosting a primary
 * state (e.g. it was wiped to `undefined`, or this is a subagent alias).
 */
async function rebuildPrimaryStateOnScopeChange(session: AgentSession): Promise<void> {
	const current = getCogneeSessionState(session);
	if (!current || current.aliasOf) return;

	const settings = session.settings;
	const config = loadCogneeConfig(settings);
	if (!isCogneeConfigured(config)) {
		await clearInstalledState(session, { flush: true });
		return;
	}

	const cwd = session.sessionManager.getCwd();
	const next = computeCogneeScope(config, cwd, config.sessionMemoryEnabled ? current.sessionId : undefined);
	if (configRoutingEqual(config, current.config) && scopesEqual(next, current.scope)) return;

	await installPrimaryState(session, settings);
}

/**
 * Build (or rebuild) the primary `CogneeSessionState` for `session` from
 * the current settings and install it. Disposes any previous primary state
 * after flushing its retain queue so in-flight tool-initiated retains land in
 * the dataset that was selected when they were enqueued, not in the new one.
 *
 * The created state takes ownership of the `onCogneeScopeChanged`
 * subscription so subsequent `cognee.datasetName` / `datasetId` /
 * `datasetNamePrefix` / `scoping` edits trigger another rebuild from the
 * same wiring. Never calls `client.createDataset` here.
 */
async function installPrimaryState(
	session: AgentSession,
	settings: Settings,
): Promise<CogneeSessionStateLike | undefined> {
	const sessionId = resolveSessionId(session);
	if (!sessionId) return undefined;

	const config = loadCogneeConfig(settings);
	if (!isCogneeConfigured(config)) {
		await clearInstalledState(session, { flush: true });
		return undefined;
	}

	const client = createCogneeClient({ baseUrl: config.apiUrl, apiKey: config.apiKey ?? undefined });
	const scope = computeCogneeScope(
		config,
		session.sessionManager.getCwd(),
		config.sessionMemoryEnabled ? sessionId : undefined,
	);

	// Flush the previous state's retain queue BEFORE clearing it so queued
	// retains don't get dropped by the state's flush guard. Re-read after the
	// await so a concurrent owner cannot leave the actual current state
	// undisposed.
	let previous = getCogneeSessionState(session);
	if (previous) {
		try {
			await previous.flushRetainQueue();
		} catch (err) {
			logger.debug("Cognee: flush before install failed", { error: String(err) });
		}
	}
	const latest = getCogneeSessionState(session);
	if (latest && latest !== previous) {
		await disposeState(previous);
		previous = latest;
		try {
			await previous.flushRetainQueue();
		} catch (err) {
			logger.debug("Cognee: flush before install failed", { error: String(err) });
		}
	}

	unsubscribeScope(session);

	const state = new CogneeSessionState({
		sessionId,
		client,
		config,
		scope,
		session,
		lastRetainedTurn: 0,
		hasRecalledForFirstTurn: false,
	});

	// Subscribe BEFORE installing: if the operator manages to flip another
	// setting between install and subscribe, we'd miss the edge.
	scopeUnsubscribes.set(
		session,
		onCogneeScopeChanged(() => schedulePrimaryStateRebuild(session)),
	);

	const displaced = setCogneeSessionState(session, state);
	if (displaced && displaced !== previous) {
		try {
			await displaced.flushRetainQueue();
		} catch (err) {
			logger.debug("Cognee: displaced flush failed", { error: String(err) });
		}
		await disposeState(displaced);
	}
	await disposeState(previous);
	state.attachSessionListeners();

	return state;
}

/** Render an unknown error as a single-line string for markdown/status. */
function safeErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/** Redact the API key for diagnostics: never surface the raw secret. */
function redactedApiKey(config: CogneeConfig): "<redacted>" | "<unset>" {
	return config.apiKey ? "<redacted>" : "<unset>";
}

/** Bounded JSON.stringify for stats/diagnose; redact by construction. */
function boundedJson(value: unknown, limit = 4000): string {
	try {
		const text = JSON.stringify(value, (_k, v) => (v === undefined ? null : v));
		if (text === undefined) return "";
		return text.length > limit ? `${text.slice(0, limit)}…` : text;
	} catch {
		return "<unserializable>";
	}
}

/** Short single-line preview for `lastRecallSnippet` in diagnose. */
function safePreview(text: string, limit = 200): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

export const cogneeBackend: MemoryBackend = {
	id: "cognee",

	async start(options: MemoryBackendStartOptions): Promise<void> {
		const { session, settings, taskDepth } = options;
		try {
			const sessionId = resolveSessionId(session);
			if (!sessionId) return;
			// Subagents alias the parent's state so recall/retain/reflect tool
			// calls persist to the same Cognee dataset. Auto-recall and
			// auto-retain stay with the parent — running them per subagent
			// would double-recall and pollute the dataset with internal
			// exploration transcripts.
			if (taskDepth > 0) {
				const parent = options.parentCogneeSessionState;
				if (!parent) return;
				const alias = new CogneeSessionState({
					sessionId,
					client: parent.client,
					config: parent.config,
					scope: parent.scope,
					session,
					lastRetainedTurn: 0,
					hasRecalledForFirstTurn: true,
					aliasOf: parent,
				});
				const previous = setCogneeSessionState(session, alias);
				// Aliases don't run auto-recall/auto-retain; best-effort flush
				// of the previous alias's empty queue, then dispose.
				try {
					await previous?.flushRetainQueue();
				} catch (err) {
					logger.debug("Cognee: alias previous flush failed", { error: String(err) });
				}
				await disposeState(previous);
				// Do not subscribe to onCogneeScopeChanged and do not attach
				// session listeners — the parent owns those.
				return;
			}

			const config = loadCogneeConfig(settings);
			if (!isCogneeConfigured(config)) {
				logger.warn("Cognee: memory.backend=cognee but cognee.apiUrl is unset; backend inert.");
				await clearInstalledState(session, { flush: true });
				return;
			}

			await installPrimaryStateCoalesced(session, settings);
		} catch (err) {
			logger.warn("Cognee: backend startup failed", { error: String(err) });
			await clearInstalledState(session, { flush: false }).catch(clearErr => {
				logger.debug("Cognee: startup cleanup failed", { error: String(clearErr) });
			});
		}
	},

	async buildDeveloperInstructions(_agentDir, settings, session): Promise<string | undefined> {
		const config = loadCogneeConfig(settings);
		if (!isCogneeConfigured(config)) return undefined;

		const state = session ? getCogneeSessionState(session) : undefined;
		const primary = state?.aliasOf ?? state;
		const recallSnippet = primary?.lastRecallSnippet;

		const parts = [STATIC_INSTRUCTIONS];
		if (recallSnippet) parts.push(recallSnippet);
		const joined = parts.join("\n\n");

		if (config.recallMaxRenderChars === 0) return STATIC_INSTRUCTIONS;
		return truncateApproxTokensOrChars(joined, config.recallMaxRenderChars);
	},

	async beforeAgentStartPrompt(session: AgentSession, promptText: string): Promise<string | undefined> {
		const state = getCogneeSessionState(session);
		if (!state) return undefined;
		// Do not catch; AgentSession already handles backend hook failures.
		return await state.beforeAgentStartPrompt(promptText);
	},

	async clear(_agentDir, _cwd, session): Promise<void> {
		if (!session) return;
		await clearInstalledState(session, { flush: true }).catch(err => {
			logger.debug("Cognee: clear flush failed", { error: String(err) });
		});
		logger.warn(
			"Cognee memory is server-side; only local recall cache/session state was cleared. " +
				"Delete Cognee data from the Cognee server to wipe upstream state.",
		);
	},

	async enqueue(_agentDir, _cwd, session): Promise<void> {
		const state = getCogneeSessionState(session);
		// Use only primary state; aliases delegate to the parent and must not
		// run their own retain/improve.
		const primary = state?.aliasOf ? undefined : state;
		if (!primary) return;
		await primary.flushRetainQueue();
		await primary.forceRetainCurrentSession();
		if (!primary.config.improveOnEnqueue) return;
		try {
			await primary.client.improve({
				datasetName: primary.scope.datasetName,
				datasetId: primary.scope.datasetId,
				sessionIds: primary.config.sessionMemoryEnabled ? [primary.sessionId] : undefined,
				nodeName: primary.scope.recallNodeName,
				runInBackground: primary.config.runInBackground,
				buildGlobalContextIndex: primary.config.buildGlobalContextIndex,
			});
		} catch (err) {
			// Improve failure must not undo the retained transcript.
			logger.warn("Cognee: improve on enqueue failed", { error: String(err) });
		}
	},

	async status(context: MemoryBackendOperationContext): Promise<MemoryBackendStatus> {
		const state = await ensureInstalledState(context.session);
		const primary = state?.aliasOf ?? state;
		if (!primary) {
			return {
				backend: "cognee",
				active: false,
				writable: false,
				searchable: false,
				message: INERT_MESSAGE,
			};
		}
		return {
			backend: "cognee",
			active: true,
			writable: true,
			searchable: true,
			scope: primary.scope.label,
			retainBank: primary.scope.retainDatasetLabel,
			recallBanks: primary.scope.recallDatasetLabels,
			lastRecall: Boolean(primary.lastRecallSnippet),
			lastMemory: primary.lastRetainedAtIso,
			message: undefined,
			error: undefined,
		};
	},

	async search(
		context: MemoryBackendOperationContext,
		query: string,
		options?: MemoryBackendSearchOptions,
	): Promise<MemoryBackendSearchResult> {
		const state = await ensureInstalledState(context.session);
		if (!state) {
			return { backend: "cognee", query, count: 0, items: [], message: INERT_MESSAGE };
		}
		if (query.trim() === "") {
			return { backend: "cognee", query, count: 0, items: [], message: "Search query is empty." };
		}
		if (options?.signal?.aborted) {
			return { backend: "cognee", query, count: 0, items: [], message: "Search aborted." };
		}
		const result = await state.search(query, options);
		if (options?.signal?.aborted) {
			return { backend: "cognee", query, count: 0, items: [], message: "Search aborted." };
		}
		return { ...result, backend: "cognee", query };
	},

	async save(context: MemoryBackendOperationContext, input: MemoryBackendSaveInput): Promise<MemoryBackendSaveResult> {
		const state = await ensureInstalledState(context.session);
		if (!state) {
			return { backend: "cognee", stored: 0, message: INERT_MESSAGE };
		}
		const content = input.content.trim();
		if (content === "") {
			return { backend: "cognee", stored: 0, message: "Memory content is empty." };
		}
		const result = await state.save({ ...input, content });
		return { ...result, backend: "cognee" };
	},

	async stats(_agentDir, cwd, session): Promise<string | undefined> {
		const lines: string[] = ["## Cognee Memory Stats", ""];

		let config: CogneeConfig | undefined;
		let scope: CogneeScope | undefined;
		let client: CogneeClient | undefined;

		const primary = primaryState(session);
		if (primary) {
			config = primary.config;
			scope = primary.scope;
			client = primary.client;
		} else if (session?.settings) {
			config = loadCogneeConfig(session.settings);
			if (!isCogneeConfigured(config)) {
				lines.push("Configured: no");
				lines.push("");
				lines.push("Cognee is not configured (`cognee.apiUrl` is unset). No server contact attempted.");
				return lines.join("\n");
			}
			scope = computeCogneeScope(config, cwd, config.sessionMemoryEnabled ? session.sessionId : undefined);
			client = createCogneeClient({ baseUrl: config.apiUrl, apiKey: config.apiKey ?? undefined });
		} else {
			lines.push("Configured: no");
			lines.push("");
			lines.push("No session available; Cognee config could not be loaded.");
			return lines.join("\n");
		}

		lines.push(`Configured: yes`);
		lines.push(`API URL: ${config.apiUrl}`);
		lines.push(`Dataset name: ${scope.datasetName ?? "<unset>"}`);
		lines.push(`Dataset id: ${scope.datasetId ?? "<unset>"}`);
		lines.push(`Scoping: ${config.scoping}`);
		lines.push(`Session memory: ${config.sessionMemoryEnabled ? "enabled" : "disabled"}`);
		lines.push("");

		if (client && scope) {
			lines.push("### Dataset status");
			try {
				const status = await client.getDatasetStatus({ dataset: scope.datasetName, datasetId: scope.datasetId });
				lines.push("```json");
				lines.push(boundedJson(status));
				lines.push("```");
			} catch (err) {
				lines.push(`Status lookup failed: ${safeErrorMessage(err)}`);
			}
			lines.push("");

			lines.push("### Datasets");
			try {
				const datasets = await client.listDatasets();
				lines.push(`Dataset count: ${datasets.length}`);
				const match = scope.datasetName ? datasets.find(d => d.name === scope!.datasetName) : undefined;
				lines.push(`Retain dataset present: ${match ? "yes" : "no"}`);
			} catch (err) {
				lines.push(`Dataset list failed: ${safeErrorMessage(err)}`);
			}
		}

		return lines.join("\n");
	},

	async diagnose(_agentDir, cwd, session): Promise<string | undefined> {
		const lines: string[] = ["## Cognee Memory Diagnostics", ""];

		let config: CogneeConfig | undefined;
		let scope: CogneeScope | undefined;
		let client: CogneeClient | undefined;

		const primary = primaryState(session);
		if (primary) {
			config = primary.config;
			scope = primary.scope;
			client = primary.client;
		} else if (session?.settings) {
			config = loadCogneeConfig(session.settings);
			scope = computeCogneeScope(
				config,
				cwd,
				isCogneeConfigured(config) && config.sessionMemoryEnabled ? session.sessionId : undefined,
			);
			if (isCogneeConfigured(config)) {
				client = createCogneeClient({ baseUrl: config.apiUrl, apiKey: config.apiKey ?? undefined });
			}
		} else {
			scope = undefined;
		}

		lines.push(`Backend: cognee`);
		lines.push(`State: ${primary ? "active" : "inert"}`);
		lines.push(`API URL: ${config?.apiUrl ?? "<unset>"}`);
		lines.push(`API key: ${config ? redactedApiKey(config) : "<unset>"}`);
		lines.push(`Dataset name: ${scope?.datasetName ?? "<unset>"}`);
		lines.push(`Dataset id: ${scope?.datasetId ?? "<unset>"}`);
		lines.push(`Dataset name prefix: ${config?.datasetNamePrefix ?? "<unset>"}`);
		lines.push(`Scoping: ${config?.scoping ?? "<unset>"}`);
		lines.push(`Scope label: ${scope?.label ?? "<unset>"}`);
		lines.push(`Retain dataset label: ${scope?.retainDatasetLabel ?? "<unset>"}`);
		lines.push(`Recall dataset labels: ${(scope?.recallDatasetLabels ?? []).join(", ") || "<none>"}`);
		lines.push(`Project label: ${scope?.projectLabel ?? "<unset>"}`);
		lines.push("");

		if (config) {
			lines.push("### Auto flags");
			lines.push(`autoRecall: ${config.autoRecall}`);
			lines.push(`autoRetain: ${config.autoRetain}`);
			lines.push(`improveOnEnqueue: ${config.improveOnEnqueue}`);
			lines.push(`buildGlobalContextIndex: ${config.buildGlobalContextIndex}`);
			lines.push(`runInBackground: ${config.runInBackground}`);
			lines.push("");

			lines.push("### Recall settings");
			lines.push(`recallSearchType: ${config.recallSearchType}`);
			lines.push(`recallScope: ${config.recallScope}`);
			lines.push(`recallTopK: ${config.recallTopK}`);
			lines.push(`recallContextTurns: ${config.recallContextTurns}`);
			lines.push(`recallMaxQueryChars: ${config.recallMaxQueryChars}`);
			lines.push(`recallMaxRenderChars: ${config.recallMaxRenderChars}`);
			lines.push(`onlyContext: ${config.onlyContext}`);
			lines.push(`verbose: ${config.verbose}`);
			lines.push("");

			lines.push("### Retain settings");
			lines.push(`retainMode: ${config.retainMode}`);
			lines.push(`retainEveryNTurns: ${config.retainEveryNTurns}`);
			lines.push(`retainOverlapTurns: ${config.retainOverlapTurns}`);
			lines.push(`retainContext: ${config.retainContext}`);
			lines.push(`chunkSize: ${config.chunkSize ?? "<server default>"}`);
			lines.push(`chunksPerBatch: ${config.chunksPerBatch ?? "<server default>"}`);
			lines.push(`nodeSet: ${config.nodeSet.join(", ") || "<none>"}`);
			lines.push(`ontologyKeys: ${config.ontologyKeys.join(", ") || "<none>"}`);
			lines.push("");
		}

		if (primary) {
			lines.push("### Active state");
			lines.push(`sessionId: ${primary.sessionId}`);
			lines.push(`lastRetainedTurn: ${primary.lastRetainedTurn}`);
			lines.push(`hasRecalledForFirstTurn: ${primary.hasRecalledForFirstTurn}`);
			lines.push(`lastRetainedAtIso: ${primary.lastRetainedAtIso ?? "<never>"}`);
			const snippet = primary.lastRecallSnippet;
			lines.push(`lastRecallSnippet: ${snippet ? `present (${snippet.length} chars)` : "absent"}`);
			if (snippet) {
				lines.push(`lastRecallSnippet preview: ${safePreview(snippet)}`);
			}
			lines.push("");
		}

		if (client && scope) {
			lines.push("### Dataset status");
			try {
				const status = await client.getDatasetStatus({ dataset: scope.datasetName, datasetId: scope.datasetId });
				lines.push("```json");
				lines.push(boundedJson(status));
				lines.push("```");
			} catch (err) {
				lines.push(`Status lookup failed: ${safeErrorMessage(err)}`);
			}
			lines.push("");

			lines.push("### Datasets");
			try {
				const datasets = await client.listDatasets();
				lines.push(`Dataset count: ${datasets.length}`);
			} catch (err) {
				lines.push(`Dataset list failed: ${safeErrorMessage(err)}`);
			}
		}

		return lines.join("\n");
	},

	async preCompactionContext(
		messages: AgentMessage[],
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined> {
		const config = loadCogneeConfig(settings);
		if (!isCogneeConfigured(config)) return undefined;
		const state = session ? getCogneeSessionState(session) : undefined;
		if (!state) return undefined;
		// Let errors propagate; backend must not flatten/format messages.
		return await state.recallForCompaction(messages);
	},
};
