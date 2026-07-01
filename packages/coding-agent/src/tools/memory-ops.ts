import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { ensureBankExists } from "../hindsight/bank";
import { formatCurrentTime, formatMemories } from "../hindsight/content";
import type { HindsightSessionState } from "../hindsight/state";
import type {
	MemoryBackendId,
	MemoryBackendSaveInput,
	MemoryBackendSaveResult,
	MemoryBackendSearchItem,
	MemoryBackendSearchOptions,
	MemoryBackendSearchResult,
} from "../memory-backend";
import type { MnemopiSessionState } from "../mnemopi/state";
import type { ToolSession } from ".";
import type { MemoryEditParams } from "./memory-edit";

export interface RetainToolItem {
	content: string;
	context?: string;
}

export interface MemoryToolOps {
	readonly backend: Extract<MemoryBackendId | "cognee", "hindsight" | "mnemopi" | "cognee">;
	readonly supportsReflect: boolean;
	readonly supportsEdit: boolean;

	retain(items: RetainToolItem[]): Promise<AgentToolResult>;
	recall(query: string, options?: MemoryBackendSearchOptions): Promise<AgentToolResult>;
	reflect(query: string, context?: string, signal?: AbortSignal): Promise<AgentToolResult>;
	save?(input: MemoryBackendSaveInput): Promise<AgentToolResult>;
	edit?(params: MemoryEditParams): Promise<AgentToolResult>;
}

interface CogneeToolStateLike {
	readonly sessionId: string;
	enqueueRetain(content: string, context?: string): void;
	search(query: string, options?: MemoryBackendSearchOptions): Promise<MemoryBackendSearchResult>;
	save(input: MemoryBackendSaveInput): Promise<MemoryBackendSaveResult>;
}

type ToolSessionWithCognee = ToolSession & {
	getCogneeSessionState?: () => CogneeToolStateLike | undefined;
	ensureCogneeSessionState?: () => Promise<CogneeToolStateLike | undefined>;
};

export function isMemoryToolsBackend(backend: unknown): backend is "hindsight" | "mnemopi" | "cognee" {
	return backend === "hindsight" || backend === "mnemopi" || backend === "cognee";
}

export function resolveMemoryToolOps(session: ToolSession): MemoryToolOps | null {
	const backend = session.settings.get("memory.backend") as MemoryBackendId | "cognee";
	if (!isMemoryToolsBackend(backend)) return null;

	switch (backend) {
		case "hindsight":
			return createHindsightOps(session);
		case "mnemopi":
			return createMnemopiOps(session);
		case "cognee":
			return createCogneeOps(session);
	}

	return null;
}

function getHindsightState(session: ToolSession): HindsightSessionState {
	const state = session.getHindsightSessionState?.();
	if (!state) throw new Error("Hindsight backend is not initialised for this session.");
	return state;
}

function getMnemopiState(session: ToolSession): MnemopiSessionState {
	const state = session.getMnemopiSessionState?.();
	if (!state) throw new Error("Mnemopi backend is not initialised for this session.");
	return state;
}

async function getCogneeState(session: ToolSession): Promise<CogneeToolStateLike> {
	const sessionWithCognee = session as ToolSessionWithCognee;
	const state = sessionWithCognee.getCogneeSessionState?.() ?? (await sessionWithCognee.ensureCogneeSessionState?.());
	if (!state) throw new Error("Cognee backend is not initialised for this session.");
	return state;
}

function createHindsightOps(session: ToolSession): MemoryToolOps {
	return {
		backend: "hindsight",
		supportsReflect: true,
		supportsEdit: false,
		async retain(items) {
			const state = getHindsightState(session);
			for (const item of items) {
				state.enqueueRetain(item.content, item.context);
			}
			return countResult("memory", items.length, "queued");
		},
		async recall(query) {
			const state = getHindsightState(session);
			try {
				const response = await state.client.recall(state.bankId, query, {
					budget: state.config.recallBudget,
					maxTokens: state.config.recallMaxTokens,
					types: state.config.recallTypes.length > 0 ? state.config.recallTypes : undefined,
					tags: state.recallTags,
					tagsMatch: state.recallTagsMatch,
				});
				const results = response.results ?? [];
				if (results.length === 0) return noRelevantMemories();
				return foundMemories(results.length, formatMemories(results));
			} catch (err) {
				logger.warn("recall failed", { bankId: state.bankId, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		},
		async reflect(query, context) {
			const state = getHindsightState(session);
			try {
				await ensureBankExists(state.client, state.bankId, state.config, state.banksSet);
				const response = await state.client.reflect(state.bankId, query, {
					context,
					budget: state.config.recallBudget,
					tags: state.recallTags,
					tagsMatch: state.recallTagsMatch,
				});
				const text = response.text?.trim() || "No relevant information found to reflect on.";
				return { content: [{ type: "text", text }], details: {} };
			} catch (err) {
				logger.warn("reflect failed", { bankId: state.bankId, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		},
		async save(input) {
			const state = getHindsightState(session);
			state.enqueueRetain(input.content, input.context);
			return { content: [{ type: "text", text: "Lesson queued for retention" }], details: {} };
		},
	};
}

function createMnemopiOps(session: ToolSession): MemoryToolOps {
	return {
		backend: "mnemopi",
		supportsReflect: true,
		supportsEdit: true,
		async retain(items) {
			const state = getMnemopiState(session);
			for (const item of items) {
				state.rememberScoped(item.content, {
					source: "coding-agent-retain",
					importance: 0.75,
					metadata: {
						session_id: state.sessionId,
						cwd: state.session.sessionManager.getCwd(),
						context: item.context ?? null,
						tool: "retain",
					},
					scope: "bank",
					extract: true,
					extractEntities: true,
					veracity: "tool",
					memoryType: "fact",
				});
			}
			return countResult("memory", items.length, "stored");
		},
		async recall(query) {
			const state = getMnemopiState(session);
			try {
				const results = await state.recallResultsScoped(query);
				if (results.length === 0) return noRelevantMemories();
				return foundMemories(results.length, state.formatScopedRecallWithIds(results));
			} catch (err) {
				logger.warn("recall failed", { backend: "mnemopi", bank: state.config.bank, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		},
		async reflect(query, context) {
			const state = getMnemopiState(session);
			try {
				const searchQuery = context?.trim() ? `${query.trim()}\n\nAdditional context:\n${context.trim()}` : query;
				const results = await state.recallResultsScoped(searchQuery);
				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No relevant information found to reflect on." }],
						details: {},
					};
				}
				return {
					content: [
						{ type: "text", text: `Based on recalled memories:\n\n${state.formatContextScoped(results)}` },
					],
					details: {},
				};
			} catch (err) {
				logger.warn("reflect failed", { backend: "mnemopi", bank: state.config.bank, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		},
		async save(input) {
			const state = getMnemopiState(session);
			const id = state.rememberScoped(input.content, {
				source: input.source || "coding-agent-learn",
				importance: input.importance ?? 0.8,
				metadata: {
					session_id: state.sessionId,
					cwd: state.session.sessionManager.getCwd(),
					context: input.context ?? null,
					tool: "learn",
				},
				scope: "bank",
				extract: true,
				extractEntities: true,
				veracity: "tool",
				memoryType: "fact",
			});
			if (!id) throw new Error("Mnemopi did not store the lesson (no memory id returned).");
			return { content: [{ type: "text", text: "Lesson stored" }], details: {} };
		},
	};
}

function createCogneeOps(session: ToolSession): MemoryToolOps {
	return {
		backend: "cognee",
		supportsReflect: true,
		supportsEdit: false,
		async retain(items) {
			const state = await getCogneeState(session);
			for (const item of items) {
				state.enqueueRetain(item.content, item.context);
			}
			return countResult("memory", items.length, "queued");
		},
		async recall(query, options) {
			const state = await getCogneeState(session);
			const result = await state.search(query, options);
			const items = result.items ?? [];
			const failureMessage = cogneeSearchFailureMessage(result, items.length);
			if (failureMessage) throw new Error(failureMessage);
			if (items.length === 0 || result.count === 0) return noRelevantMemories();
			return foundMemories(items.length, formatGenericSearchItems(items));
		},
		async reflect(query, context, signal) {
			const state = await getCogneeState(session);
			const searchQuery = context?.trim() ? `${query.trim()}\n\nAdditional context:\n${context.trim()}` : query;
			const result = await state.search(searchQuery, { signal });
			const items = result.items ?? [];
			const failureMessage = cogneeSearchFailureMessage(result, items.length);
			if (failureMessage) throw new Error(failureMessage);
			if (items.length === 0 || result.count === 0) {
				return { content: [{ type: "text", text: "No relevant information found to reflect on." }], details: {} };
			}
			return {
				content: [{ type: "text", text: `Based on recalled memories:\n\n${formatGenericSearchItems(items)}` }],
				details: {},
			};
		},
		async save(input) {
			const state = await getCogneeState(session);
			const result = await state.save(input);
			if (result.stored > 0) return { content: [{ type: "text", text: "Lesson stored" }], details: {} };
			if (result.queued === true) {
				return { content: [{ type: "text", text: "Lesson queued for retention" }], details: {} };
			}
			throw new Error(result.message || "Cognee did not store the lesson.");
		},
	};
}

function cogneeSearchFailureMessage(result: MemoryBackendSearchResult, itemCount: number): string | null {
	const message = result.message?.trim();
	if (!message) return null;
	return itemCount === 0 || result.count === 0 ? message : null;
}

function countResult(nounBase: "memory", count: number, mode: "queued" | "stored"): AgentToolResult {
	const noun = count === 1 ? nounBase : "memories";
	return {
		content: [{ type: "text", text: `${count} ${noun} ${mode}.` }],
		details: { count },
	};
}

function noRelevantMemories(): AgentToolResult {
	return {
		content: [{ type: "text", text: "No relevant memories found." }],
		details: {},
		useless: true,
	};
}

function foundMemories(count: number, formatted: string): AgentToolResult {
	return {
		content: [
			{
				type: "text",
				text: `Found ${count} relevant ${count === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
			},
		],
		details: {},
	};
}

function formatGenericSearchItems(items: MemoryBackendSearchItem[]): string {
	return items
		.map(item => {
			const parts = [`- ${item.content}`];
			if (item.id) parts.push(`(id: ${item.id})`);
			if (item.source) parts.push(`[${item.source}]`);
			const date = formatTimestampDate(item.timestamp);
			if (date) parts.push(`(${date})`);
			if (typeof item.score === "number" && Number.isFinite(item.score)) parts.push(`c:${item.score.toFixed(1)}`);
			return parts.join(" ");
		})
		.join("\n\n");
}

function formatTimestampDate(timestamp: string | undefined): string | null {
	if (!timestamp) return null;
	const datePrefix = timestamp.slice(0, 10);
	return /^\d{4}-\d{2}-\d{2}$/.test(datePrefix) ? datePrefix : null;
}
