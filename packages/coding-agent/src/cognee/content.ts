import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { MemoryBackendSearchItem } from "../memory-backend/types";
import type { CogneeRecallEntry } from "./client";
import type { CogneeConfig, CogneeRetainMode } from "./config";
import type { CogneeScope } from "./scope";

export interface CogneeMessage {
	role: "user" | "assistant";
	content: string;
}

export interface CogneeRetentionDocument {
	content: string;
	documentId: string;
	contentType: "text/markdown";
}

const COGNEE_MEMORIES_REGEX = /<cognee_memories>[\s\S]*?<\/cognee_memories>/g;
const MEMORIES_REGEX = /<memories>[\s\S]*?<\/memories>/g;
const MENTAL_MODELS_REGEX = /<mental_models>[\s\S]*?<\/mental_models>/g;
const HINDSIGHT_MEMORIES_REGEX = /<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g;
const RELEVANT_MEMORIES_REGEX = /<relevant_memories>[\s\S]*?<\/relevant_memories>/g;
const SUBSTANTIVE_CHAR_RE = /[\p{L}\p{N}]/u;
const DEFAULT_RECALL_PREAMBLE =
	"Relevant Cognee memories from prior conversations and knowledge graph context. Use only when directly useful; verify against current repo state before acting.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function stripCogneeMemoryTags(content: string): string {
	return content
		.replace(COGNEE_MEMORIES_REGEX, "")
		.replace(MEMORIES_REGEX, "")
		.replace(MENTAL_MODELS_REGEX, "")
		.replace(HINDSIGHT_MEMORIES_REGEX, "")
		.replace(RELEVANT_MEMORIES_REGEX, "");
}

function hasCogneeSubstantiveContent(content: string): boolean {
	return SUBSTANTIVE_CHAR_RE.test(content);
}

function normalizeCogneeMessageContent(text: string): string | null {
	const content = stripCogneeMemoryTags(text).trim();
	return hasCogneeSubstantiveContent(content) ? content : null;
}

function safePrefix(text: string, limit: number): string {
	if (limit <= 0) return "";
	if (text.length <= limit) return text;
	return Array.from(text).slice(0, limit).join("");
}

function sliceLastCogneeTurnsByUserBoundary(messages: CogneeMessage[], turns: number): CogneeMessage[] {
	if (messages.length === 0 || turns <= 0) return [];

	let userTurnsSeen = 0;
	let startIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== "user") continue;
		userTurnsSeen += 1;
		if (userTurnsSeen >= turns) {
			startIndex = i;
			break;
		}
	}

	return startIndex === -1 ? messages.slice() : messages.slice(startIndex);
}

function defangCogneeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function scoreToDisplay(score: number): string {
	return Number(score.toFixed(4)).toString();
}

function sourceFallbackId(entry: CogneeRecallEntry): string | undefined {
	if (entry.id) return entry.id;
	if (entry.source === "session" && entry.qaId) return entry.qaId;
	if (entry.source === "trace" && entry.traceId) return entry.traceId;
	if (entry.source === "graph" && entry.nodeName) return entry.nodeName;
	return undefined;
}

function compactQuestionAnswer(question: unknown, answer: unknown): string {
	const lines: string[] = [];
	if (typeof question === "string" && question.trim()) lines.push(`Q: ${question.trim()}`);
	if (typeof answer === "string" && answer.trim()) lines.push(`A: ${answer.trim()}`);
	return lines.join("\n");
}

function entryDisplayText(entry: CogneeRecallEntry): string {
	const text = typeof entry.text === "string" ? entry.text.trim() : "";
	if (text) return text;

	if (entry.source === "session") {
		return compactQuestionAnswer(entry.question, entry.answer);
	}

	if (entry.source === "graph_context" || entry.source === "session_context") {
		return typeof entry.context === "string" ? entry.context.trim() : "";
	}

	return "";
}

function buildCogneeScopeLines(scope: CogneeScope): string[] {
	const lines: string[] = [];
	if (scope.projectLabel) lines.push(`Project: ${scope.projectLabel}`);
	if (scope.label && scope.label !== scope.projectLabel && scope.label !== `project:${scope.projectLabel}`) {
		lines.push(`Scope: ${scope.label}`);
	}
	return lines;
}

function formatScopePlusLatest(scopeLines: string[], latest: string): string {
	if (scopeLines.length === 0) return latest;
	return `${scopeLines.join("\n")}\n\nLatest prompt:\n${latest}`;
}

function buildRecallQueryCandidate(scopeLines: string[], contextLines: string[], latest: string, useLatestSection: boolean): string {
	if (contextLines.length > 0) {
		const prefix = scopeLines.length > 0 ? `${scopeLines.join("\n")}\n\n` : "";
		return `${prefix}Prior context:\n${contextLines.join("\n")}\n\nLatest prompt:\n${latest}`;
	}
	if (useLatestSection || scopeLines.length > 0) return formatScopePlusLatest(scopeLines, latest);
	return latest;
}

function parseCogneeRecallQuery(query: string): { scopeLines: string[]; contextLines: string[]; useLatestSection: boolean } {
	const priorMarker = "Prior context:\n";
	const latestMarker = "Latest prompt:\n";
	const priorIndex = query.indexOf(priorMarker);
	if (priorIndex !== -1) {
		const beforePrior = query.slice(0, priorIndex).trim();
		const latestIndex = query.indexOf(`\n\n${latestMarker}`, priorIndex + priorMarker.length);
		const contextEnd = latestIndex === -1 ? query.length : latestIndex;
		const contextBody = query.slice(priorIndex + priorMarker.length, contextEnd).trim();
		return {
			scopeLines: beforePrior ? beforePrior.split("\n") : [],
			contextLines: contextBody ? contextBody.split("\n").filter(line => line.length > 0) : [],
			useLatestSection: true,
		};
	}

	const latestIndex = query.indexOf(latestMarker);
	if (latestIndex !== -1) {
		const beforeLatest = query.slice(0, latestIndex).trim();
		return {
			scopeLines: beforeLatest ? beforeLatest.split("\n") : [],
			contextLines: [],
			useLatestSection: true,
		};
	}

	return { scopeLines: [], contextLines: [], useLatestSection: false };
}

function coerceUserContent(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;

	const textBlocks: string[] = [];
	let sawNonTextContent = false;
	for (const block of content) {
		if (!isRecord(block) || typeof block.type !== "string") continue;
		if (block.type === "text" && typeof block.text === "string") {
			textBlocks.push(block.text);
			continue;
		}
		if (
			block.type === "image" ||
			block.type === "input_image" ||
			block.type === "image_url" ||
			block.type === "file" ||
			block.type === "input_file" ||
			block.type === "audio" ||
			block.type === "input_audio" ||
			block.type === "binary"
		) {
			sawNonTextContent = true;
		}
	}

	if (textBlocks.length > 0) return textBlocks.join("\n");
	return sawNonTextContent ? "[image omitted]" : null;
}

function coerceAssistantContent(content: unknown): string | null {
	if (!Array.isArray(content)) return null;

	const textBlocks: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		if (!block.text) continue;
		textBlocks.push(block.text);
	}

	return textBlocks.length > 0 ? textBlocks.join("\n") : null;
}

export function flattenMessagesForCognee(messages: AgentMessage[]): CogneeMessage[] {
	const flattened: CogneeMessage[] = [];
	for (const message of messages) {
		if (!isRecord(message)) continue;

		if (message.role === "user") {
			const content = coerceUserContent(message.content);
			if (content === null) continue;
			const normalized = normalizeCogneeMessageContent(content);
			if (normalized) flattened.push({ role: "user", content: normalized });
			continue;
		}

		if (message.role === "assistant") {
			const content = coerceAssistantContent(message.content);
			if (content === null) continue;
			const normalized = normalizeCogneeMessageContent(content);
			if (normalized) flattened.push({ role: "assistant", content: normalized });
		}
	}
	return flattened;
}

export function composeCogneeRecallQuery(
	latestPrompt: string,
	messages: CogneeMessage[],
	contextTurns: number,
	scope: CogneeScope,
): string {
	const latest = stripCogneeMemoryTags(latestPrompt).trim();
	const scopeLines = buildCogneeScopeLines(scope);
	if (contextTurns <= 1 || messages.length === 0) return formatScopePlusLatest(scopeLines, latest);

	const contextLines: string[] = [];
	for (const message of sliceLastCogneeTurnsByUserBoundary(messages, contextTurns)) {
		const content = normalizeCogneeMessageContent(message.content);
		if (!content) continue;
		if (message.role === "user" && content === latest) continue;
		contextLines.push(`${message.role}: ${content}`);
	}

	if (contextLines.length === 0) return formatScopePlusLatest(scopeLines, latest);
	return buildRecallQueryCandidate(scopeLines, contextLines, latest, true);
}

export function truncateCogneeRecallQuery(query: string, latestPrompt: string, maxChars: number): string {
	const latest = stripCogneeMemoryTags(latestPrompt).trim();
	if (maxChars <= 0) return latest;
	if (query.length <= maxChars) return query;
	if (latest.length > maxChars) return truncateApproxTokensOrChars(latest, maxChars);

	const parsed = parseCogneeRecallQuery(query);
	const latestOnly = latest;
	const base = buildRecallQueryCandidate([], [], latest, parsed.useLatestSection);
	if (base.length > maxChars) return latestOnly;

	const scopeLines: string[] = [];
	for (const line of parsed.scopeLines) {
		const candidate = buildRecallQueryCandidate([...scopeLines, line], [], latest, true);
		if (candidate.length <= maxChars) scopeLines.push(line);
	}
	const keptContextLines: string[] = [];
	for (let i = parsed.contextLines.length - 1; i >= 0; i--) {
		const nextContextLines = [parsed.contextLines[i], ...keptContextLines];
		const candidate = buildRecallQueryCandidate(scopeLines, nextContextLines, latest, true);
		if (candidate.length <= maxChars) keptContextLines.unshift(parsed.contextLines[i]);
	}

	const candidate = buildRecallQueryCandidate(scopeLines, keptContextLines, latest, scopeLines.length > 0 || parsed.useLatestSection);
	return candidate.length <= maxChars ? candidate : latestOnly;
}

export function prepareCogneeRetentionDocument(args: {
	messages: CogneeMessage[];
	sessionId: string;
	retainedAt: Date;
	mode: CogneeRetainMode;
	retainEveryNTurns: number;
	retainOverlapTurns: number;
	scope: CogneeScope;
}): CogneeRetentionDocument | null {
	if (args.messages.length === 0) return null;

	let targetMessages: CogneeMessage[];
	let documentId: string;
	if (args.mode === "full-session") {
		targetMessages = args.messages;
		documentId = args.sessionId;
	} else {
		const windowTurns = Math.max(1, args.retainEveryNTurns + args.retainOverlapTurns);
		targetMessages = sliceLastCogneeTurnsByUserBoundary(args.messages, windowTurns);
		documentId = `${args.sessionId}-${args.retainedAt.getTime()}`;
	}

	const sections: string[] = [];
	for (const message of targetMessages) {
		const content = normalizeCogneeMessageContent(message.content);
		if (!content) continue;
		sections.push(`[role: ${message.role}]\n${content}\n[${message.role}:end]`);
	}
	if (sections.length === 0) return null;

	const headerLines = [`Session: ${args.sessionId}`, `Retained at: ${args.retainedAt.toISOString()}`];
	if (args.scope.label) headerLines.push(`Scope: ${args.scope.label}`);
	if (args.scope.projectLabel) headerLines.push(`Project: ${args.scope.projectLabel}`);

	return {
		content: `${headerLines.join("\n")}\n\n${sections.join("\n\n")}`,
		documentId,
		contentType: "text/markdown",
	};
}

export function formatCogneeRecallBlock(
	entries: CogneeRecallEntry[],
	config: CogneeConfig,
	scope: CogneeScope,
	now?: Date,
): string | undefined {
	if (entries.length === 0) return undefined;

	const preamble = config.recallPromptPreamble.trim() || DEFAULT_RECALL_PREAMBLE;
	const renderedNow = now ?? new Date(0);
	const header = [
		"<cognee_memories>",
		preamble,
		`Current time: ${renderedNow.toISOString()}`,
		`Scope: ${defangCogneeXml(scope.label)}`,
		"",
	].join("\n");
	const closing = "</cognee_memories>";
	const maxChars = config.recallMaxRenderChars;
	if (maxChars <= 0 || `${header}${closing}`.length > maxChars) return undefined;

	const bulletLines: string[] = [];
	for (const entry of entries) {
		const normalizedText = entryDisplayText(entry);
		if (!hasCogneeSubstantiveContent(normalizedText)) continue;

		const source = typeof entry.source === "string" && entry.source ? entry.source : "unknown";
		const metadata = [`source=${defangCogneeXml(source)}`];
		const id = sourceFallbackId(entry);
		if (id) metadata.push(`id=${defangCogneeXml(id)}`);
		if (typeof entry.score === "number") metadata.push(`score=${scoreToDisplay(entry.score)}`);

		const prefix = `- [${metadata.join(" ")}] `;
		const text = defangCogneeXml(normalizedText);
		const fullLine = `${prefix}${text}`;
		const fullCandidate = `${header}${[...bulletLines, fullLine].join("\n")}\n${closing}`;
		if (fullCandidate.length <= maxChars) {
			bulletLines.push(fullLine);
			continue;
		}

		const beforeText = `${header}${bulletLines.length > 0 ? `${bulletLines.join("\n")}\n` : ""}${prefix}`;
		const afterText = `\n${closing}`;
		const remainingTextChars = maxChars - beforeText.length - afterText.length;
		let truncatedText = truncateApproxTokensOrChars(text, remainingTextChars);
		while (truncatedText.length > remainingTextChars && truncatedText.length > 0) {
			const chars = Array.from(truncatedText);
			chars.pop();
			truncatedText = chars.join("");
		}
		if (hasCogneeSubstantiveContent(truncatedText)) bulletLines.push(`${prefix}${truncatedText}`);
		break;
	}

	if (bulletLines.length === 0) return undefined;
	return `${header}${bulletLines.join("\n")}\n${closing}`;
}

export function formatCogneeSearchItem(entry: CogneeRecallEntry): MemoryBackendSearchItem {
	const content = entryDisplayText(entry);
	const item: MemoryBackendSearchItem = {
		content: hasCogneeSubstantiveContent(content) ? content : "[empty Cognee recall entry]",
		source: entry.source,
	};
	const id = sourceFallbackId(entry);
	if (id) item.id = id;
	if (entry.time) item.timestamp = entry.time;
	if (typeof entry.score === "number") item.score = entry.score;
	return item;
}

export function truncateApproxTokensOrChars(text: string, limit: number): string {
	return safePrefix(text, limit);
}
