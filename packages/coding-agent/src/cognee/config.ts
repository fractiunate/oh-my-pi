/**
 * Resolved Cognee runtime configuration.
 *
 * Pure (no I/O) aside from reading from `process.env` and the supplied
 * `Settings` instance. Tests can pass `Settings.isolated({...})` and a stub
 * env per case. All HTTP spelling lives in `./client`; this module never
 * touches the network, filesystem, session, or client.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

export type CogneeScoping = "global" | "per-project" | "per-project-tagged";
export type CogneeRetainMode = "full-session" | "last-turn";
export type CogneeSearchType = "GRAPH_COMPLETION" | "RAG_COMPLETION" | "CHUNKS" | "INSIGHTS" | "CODE" | string;
export type CogneeRecallScope =
	| "auto"
	| "graph"
	| "session"
	| "trace"
	| "graph_context"
	| "session_context"
	| "all"
	| string;

export interface CogneeConfig {
	apiUrl: string | null;
	apiKey: string | null;

	/** Base dataset name used when datasetId is unset. */
	datasetName: string | null;
	/** UUID of an existing dataset. When set, it wins over datasetName. */
	datasetId: string | null;
	/** Optional prefix applied before datasetName-derived names. */
	datasetNamePrefix: string;
	scoping: CogneeScoping;

	autoRecall: boolean;
	autoRetain: boolean;
	retainMode: CogneeRetainMode;
	retainEveryNTurns: number;
	retainOverlapTurns: number;
	retainContext: string;
	runInBackground: boolean;
	chunkSize: number | null;
	chunksPerBatch: number | null;
	customPrompt: string | null;
	ontologyKeys: string[];
	graphModel: string | null;

	/** Static Cognee node-set tags sent on remember in every scoping mode. */
	nodeSet: string[];

	recallSearchType: CogneeSearchType;
	recallScope: CogneeRecallScope;
	recallTopK: number;
	recallContextTurns: number;
	recallMaxQueryChars: number;
	recallMaxRenderChars: number;
	recallPromptPreamble: string;
	onlyContext: boolean;
	verbose: boolean;

	/** `/memory enqueue` calls improve on this dataset/session when true. */
	improveOnEnqueue: boolean;
	buildGlobalContextIndex: boolean;

	/** Session-cache mode requires Cognee server CACHING=true/CACHE_BACKEND configured. */
	sessionMemoryEnabled: boolean;
	debug: boolean;
}

const DEFAULT_RECALL_PREAMBLE =
	"Relevant Cognee memories from prior conversations and knowledge graph context. " +
	"Use only when directly useful; verify against current repo state before acting.";

const VALID_SCOPINGS: CogneeScoping[] = ["global", "per-project", "per-project-tagged"];
const VALID_RETAIN_MODES: CogneeRetainMode[] = ["full-session", "last-turn"];

/** Trim a string value; return null for non-strings or empty/whitespace-only. */
function trimNullableString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

/** Trim a string value; return "" for non-strings or empty/whitespace-only. */
function trimPrefix(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim();
}

/**
 * Override a resolved setting string with a non-blank env value. Blank env
 * values do not override; the existing setting value is preserved.
 */
function envOverride(settingValue: string | null, envValue: string | undefined): string | null {
	if (typeof envValue === "string") {
		const trimmed = envValue.trim();
		if (trimmed !== "") return trimmed;
	}
	return settingValue;
}

/** Normalize an array setting: trim, drop empty/non-string entries, dedupe. */
function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (trimmed === "") continue;
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

/** Coerce a numeric setting to a clamped integer, falling back when invalid. */
function integerSetting(value: unknown, fallback: number, min: number): number {
	let n: number | undefined;
	if (typeof value === "number") {
		n = value;
	} else if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed !== "") n = Number(trimmed);
	}
	if (n === undefined || !Number.isFinite(n)) return fallback;
	return Math.max(min, Math.trunc(n));
}

/** Coerce chunkSize/chunksPerBatch: null unless a finite integer > 0. */
function positiveNullableInteger(value: unknown): number | null {
	let n: number | undefined;
	if (typeof value === "number") {
		n = value;
	} else if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed !== "") n = Number(trimmed);
	}
	if (n === undefined || !Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
	return n;
}

function pickScoping(value: unknown): CogneeScoping | undefined {
	return typeof value === "string" && (VALID_SCOPINGS as string[]).includes(value)
		? (value as CogneeScoping)
		: undefined;
}

function pickRetainMode(value: unknown): CogneeRetainMode | undefined {
	return typeof value === "string" && (VALID_RETAIN_MODES as string[]).includes(value)
		? (value as CogneeRetainMode)
		: undefined;
}

/**
 * Load the resolved Cognee config.
 *
 * Pure (no I/O) aside from reading from `process.env` and the supplied
 * `Settings` instance. Tests can pass `Settings.isolated({...})` and stub
 * `process.env` per case.
 */
export function loadCogneeConfig(settings: Settings, env: NodeJS.ProcessEnv = process.env): CogneeConfig {
	const rawScoping = settings.get("cognee.scoping");
	const scoping = pickScoping(rawScoping);
	if (rawScoping && !scoping) {
		logger.warn("Cognee: invalid scoping setting, falling back to per-project-tagged", {
			value: rawScoping,
		});
	}

	const rawRetainMode = settings.get("cognee.retainMode");
	const retainMode = pickRetainMode(rawRetainMode);
	if (rawRetainMode && !retainMode) {
		logger.warn("Cognee: invalid retainMode setting, falling back to full-session", {
			value: rawRetainMode,
		});
	}

	const recallSearchType = trimNullableString(settings.get("cognee.recallSearchType")) ?? "GRAPH_COMPLETION";
	const recallScope = trimNullableString(settings.get("cognee.recallScope")) ?? "auto";

	return {
		apiUrl: envOverride(trimNullableString(settings.get("cognee.apiUrl")), env.COGNEE_API_URL),
		apiKey: envOverride(trimNullableString(settings.get("cognee.apiKey")), env.COGNEE_API_KEY),

		datasetName: trimNullableString(settings.get("cognee.datasetName")),
		datasetId: trimNullableString(settings.get("cognee.datasetId")),
		datasetNamePrefix: trimPrefix(settings.get("cognee.datasetNamePrefix")),
		scoping: scoping ?? "per-project-tagged",

		autoRecall: settings.get("cognee.autoRecall") === true,
		autoRetain: settings.get("cognee.autoRetain") === true,
		retainMode: retainMode ?? "full-session",
		retainEveryNTurns: integerSetting(settings.get("cognee.retainEveryNTurns"), 3, 1),
		retainOverlapTurns: integerSetting(settings.get("cognee.retainOverlapTurns"), 2, 0),
		retainContext: trimPrefix(settings.get("cognee.retainContext")) || "omp",
		runInBackground: settings.get("cognee.runInBackground") === true,
		chunkSize: positiveNullableInteger(settings.get("cognee.chunkSize")),
		chunksPerBatch: positiveNullableInteger(settings.get("cognee.chunksPerBatch")),
		customPrompt: trimNullableString(settings.get("cognee.customPrompt")),
		ontologyKeys: stringArray(settings.get("cognee.ontologyKeys")),
		graphModel: trimNullableString(settings.get("cognee.graphModel")),

		nodeSet: stringArray(settings.get("cognee.nodeSet")),

		recallSearchType,
		recallScope,
		recallTopK: integerSetting(settings.get("cognee.recallTopK"), 10, 1),
		recallContextTurns: integerSetting(settings.get("cognee.recallContextTurns"), 1, 1),
		recallMaxQueryChars: integerSetting(settings.get("cognee.recallMaxQueryChars"), 1200, 0),
		recallMaxRenderChars: integerSetting(settings.get("cognee.recallMaxRenderChars"), 12000, 0),
		recallPromptPreamble: DEFAULT_RECALL_PREAMBLE,
		onlyContext: settings.get("cognee.onlyContext") === true,
		verbose: settings.get("cognee.verbose") === true,

		improveOnEnqueue: settings.get("cognee.improveOnEnqueue") === true,
		buildGlobalContextIndex: settings.get("cognee.buildGlobalContextIndex") === true,

		sessionMemoryEnabled: settings.get("cognee.sessionMemoryEnabled") === true,
		debug: settings.get("cognee.debug") === true,
	};
}

/** Whether the caller has enough config to talk to a Cognee server. */
export function isCogneeConfigured(config: CogneeConfig): config is CogneeConfig & { apiUrl: string } {
	return typeof config.apiUrl === "string" && config.apiUrl.length > 0;
}
