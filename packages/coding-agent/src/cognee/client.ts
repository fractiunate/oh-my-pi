const DEFAULT_USER_AGENT = "oh-my-pi-coding-agent";
const MAX_SUMMARY_LENGTH = 500;

export interface CogneeApiOptions {
	baseUrl: string;
	apiKey?: string;
	bearerToken?: string;
	userAgent?: string;
	fetch?: typeof fetch;
}

export class CogneeError extends Error {
	readonly status?: number;
	readonly details?: unknown;
	readonly cause?: unknown;

	constructor(message: string, status?: number, details?: unknown, cause?: unknown) {
		super(message);
		this.name = "CogneeError";
		this.status = status;
		this.details = details;
		this.cause = cause;
	}
}

export interface CogneeRememberRequest {
	data: string | Blob | Uint8Array | Array<string | Blob | Uint8Array>;
	datasetName?: string;
	datasetId?: string;
	sessionId?: string;
	nodeSet?: string[];
	runInBackground?: boolean;
	customPrompt?: string;
	chunkSize?: number;
	chunksPerBatch?: number;
	ontologyKeys?: string[];
	graphModel?: string;
	contentType?: string;
}

export interface CogneeRememberResult {
	status?: string;
	datasetName?: string;
	datasetId?: string;
	pipelineRunId?: string;
	itemsProcessed?: number;
	elapsedSeconds?: number;
	sessionIds?: string[];
	items?: unknown[];
	contentHash?: string;
	entryType?: string;
	entryId?: string;
	error?: string;
	raw: unknown;
}

export type CogneeStructuredEntryType = "qa" | "trace" | "feedback" | "skill_run" | string;

export interface CogneeRememberEntryRequest {
	type: CogneeStructuredEntryType;
	datasetName?: string;
	datasetId?: string;
	sessionId?: string;
	question?: string;
	answer?: string;
	trace?: unknown;
	feedback?: unknown;
	skillImprovement?: unknown;
	metadata?: Record<string, unknown>;
}

export interface CogneeRecallRequest {
	query: string;
	searchType?: string;
	datasets?: string[];
	datasetIds?: string[];
	systemPrompt?: string;
	nodeName?: string[];
	topK?: number;
	onlyContext?: boolean;
	verbose?: boolean;
	includeReferences?: boolean;
	sessionId?: string;
	scope?: string | string[];
	contextProfile?: string;
}

export type CogneeRecallSource = "session" | "trace" | "graph_context" | "session_context" | "graph" | string;

export interface CogneeRecallEntryBase {
	source: CogneeRecallSource;
	text: string;
	id?: string;
	score?: number;
	time?: string;
	raw: unknown;
}

export interface CogneeRecallQaEntry extends CogneeRecallEntryBase {
	source: "session";
	question?: string;
	answer?: string;
	context?: string;
	qaId?: string;
}

export interface CogneeRecallTraceEntry extends CogneeRecallEntryBase {
	source: "trace";
	traceId?: string;
}

export interface CogneeRecallGraphContextEntry extends CogneeRecallEntryBase {
	source: "graph_context" | "session_context";
	context?: string;
}

export interface CogneeRecallGraphEntry extends CogneeRecallEntryBase {
	source: "graph";
	nodeName?: string;
}

export type CogneeRecallEntry =
	| CogneeRecallQaEntry
	| CogneeRecallTraceEntry
	| CogneeRecallGraphContextEntry
	| CogneeRecallGraphEntry
	| CogneeRecallEntryBase;

export interface CogneeImproveRequest {
	datasetName?: string;
	datasetId?: string;
	sessionIds?: string[];
	nodeName?: string[];
	runInBackground?: boolean;
	buildGlobalContextIndex?: boolean;
	data?: string;
	extractionTasks?: string[];
	enrichmentTasks?: string[];
}

export interface CogneeForgetRequest {
	everything?: boolean;
	dataset?: string;
	datasetId?: string;
	dataId?: string;
	memoryOnly?: boolean;
}

export interface CogneeDataset {
	id?: string;
	name?: string;
	status?: string;
	raw: unknown;
}

export interface CogneeDatasetStatusRequest {
	dataset?: string;
	datasetId?: string;
	pipeline?: "add_pipeline" | "cognify_pipeline" | string;
}

export interface CogneeCreateDatasetRequest {
	name: string;
}

export interface CogneeCreateDatasetResponse {
	id?: string;
	name?: string;
	status?: string;
	raw: unknown;
}

export interface CogneeClient {
	remember(request: CogneeRememberRequest, signal?: AbortSignal): Promise<CogneeRememberResult>;
	rememberEntry(request: CogneeRememberEntryRequest, signal?: AbortSignal): Promise<CogneeRememberResult>;
	recall(request: CogneeRecallRequest, signal?: AbortSignal): Promise<CogneeRecallEntry[]>;
	improve(request: CogneeImproveRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
	forget(request: CogneeForgetRequest, signal?: AbortSignal): Promise<unknown>;
	listDatasets(signal?: AbortSignal): Promise<CogneeDataset[]>;
	getDatasetStatus(request: CogneeDatasetStatusRequest, signal?: AbortSignal): Promise<unknown>;
	listDatasetData(datasetId: string, signal?: AbortSignal): Promise<unknown>;
	createDataset(request: CogneeCreateDatasetRequest, signal?: AbortSignal): Promise<CogneeCreateDatasetResponse>;
}

interface RequestParsedArgs {
	method: string;
	path: string;
	operation: string;
	query?: Record<string, string | undefined>;
	body?: BodyInit;
	json?: Record<string, unknown>;
	signal?: AbortSignal;
	allowRecallForbiddenEmptyList?: boolean;
}

class CogneeHttpClient implements CogneeClient {
	readonly #baseUrl: string;
	readonly #fetchImpl: typeof fetch;
	readonly #baseHeaders: Headers;

	constructor(options: CogneeApiOptions) {
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#fetchImpl = options.fetch ?? globalThis.fetch;
		this.#baseHeaders = new Headers({
			Accept: "application/json",
			"User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
		});
		if (options.apiKey) {
			this.#baseHeaders.set("X-Api-Key", options.apiKey);
		} else if (options.bearerToken) {
			this.#baseHeaders.set("Authorization", `Bearer ${options.bearerToken}`);
		}
	}

	async remember(request: CogneeRememberRequest, signal?: AbortSignal): Promise<CogneeRememberResult> {
		const form = new FormData();
		for (const value of Array.isArray(request.data) ? request.data : [request.data]) {
			if (typeof value === "string") {
				form.append("data", value);
			} else if (value instanceof Blob) {
				form.append("data", value);
			} else {
				form.append(
					"data",
					new Blob([value], { type: request.contentType ?? "application/octet-stream" }),
				);
			}
		}

		appendIfDefined(form, "datasetName", request.datasetName);
		appendIfDefined(form, "datasetId", request.datasetId);
		appendIfDefined(form, "session_id", request.sessionId);
		appendIfDefined(form, "run_in_background", request.runInBackground);
		appendIfDefined(form, "custom_prompt", request.customPrompt);
		appendIfDefined(form, "chunk_size", request.chunkSize);
		appendIfDefined(form, "chunks_per_batch", request.chunksPerBatch);
		appendIfDefined(form, "graph_model", request.graphModel);
		appendIfDefined(form, "content_type", request.contentType);
		appendRepeatedStrings(form, "node_set", request.nodeSet);
		appendRepeatedStrings(form, "ontology_key", request.ontologyKeys);

		const parsed = await this.#requestParsed({
			method: "POST",
			path: "/api/v1/remember",
			operation: "remember",
			body: form,
			signal,
		});
		return normalizeRememberResult(parsed);
	}

	async rememberEntry(
		request: CogneeRememberEntryRequest,
		signal?: AbortSignal,
	): Promise<CogneeRememberResult> {
		if (typeof request.type !== "string" || request.type.trim() === "") {
			throw new CogneeError("rememberEntry type is required");
		}
		const parsed = await this.#requestParsed({
			method: "POST",
			path: "/api/v1/remember/entry",
			operation: "rememberEntry",
			json: {
				type: request.type,
				datasetName: request.datasetName,
				datasetId: request.datasetId,
				sessionId: request.sessionId,
				question: request.question,
				answer: request.answer,
				trace: request.trace,
				feedback: request.feedback,
				skillImprovement: request.skillImprovement,
				metadata: request.metadata,
			},
			signal,
		});
		return normalizeRememberResult(parsed);
	}

	async recall(request: CogneeRecallRequest, signal?: AbortSignal): Promise<CogneeRecallEntry[]> {
		if (typeof request.query !== "string" || request.query.trim() === "") {
			throw new CogneeError("recall query is required");
		}
		const parsed = await this.#requestParsed({
			method: "POST",
			path: "/api/v1/recall",
			operation: "recall",
			json: {
				query: request.query,
				searchType: request.searchType,
				datasets: request.datasets,
				datasetIds: request.datasetIds,
				systemPrompt: request.systemPrompt,
				nodeName: request.nodeName,
				topK: request.topK,
				onlyContext: request.onlyContext,
				verbose: request.verbose,
				includeReferences: request.includeReferences,
				sessionId: request.sessionId,
				scope: request.scope,
				contextProfile: request.contextProfile,
			},
			signal,
			allowRecallForbiddenEmptyList: true,
		});
		return normalizeRecallEntries(parsed);
	}

	async improve(request: CogneeImproveRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const parsed = await this.#requestParsed({
			method: "POST",
			path: "/api/v1/improve",
			operation: "improve",
			json: {
				datasetName: request.datasetName,
				datasetId: request.datasetId,
				sessionIds: request.sessionIds,
				nodeName: request.nodeName,
				runInBackground: request.runInBackground,
				buildGlobalContextIndex: request.buildGlobalContextIndex,
				data: request.data,
				extractionTasks: request.extractionTasks,
				enrichmentTasks: request.enrichmentTasks,
			},
			signal,
		});
		return isRecord(parsed) && !Array.isArray(parsed) ? parsed : { raw: parsed };
	}

	async forget(request: CogneeForgetRequest, signal?: AbortSignal): Promise<unknown> {
		return this.#requestParsed({
			method: "POST",
			path: "/api/v1/forget",
			operation: "forget",
			json: {
				everything: request.everything,
				dataset: request.dataset,
				datasetId: request.datasetId,
				dataId: request.dataId,
				memoryOnly: request.memoryOnly,
			},
			signal,
		});
	}

	async listDatasets(signal?: AbortSignal): Promise<CogneeDataset[]> {
		const parsed = await this.#requestParsed({
			method: "GET",
			path: "/api/v1/datasets",
			operation: "listDatasets",
			signal,
		});
		return normalizeDatasets(parsed);
	}

	async getDatasetStatus(request: CogneeDatasetStatusRequest, signal?: AbortSignal): Promise<unknown> {
		return this.#requestParsed({
			method: "GET",
			path: "/api/v1/datasets/status",
			operation: "getDatasetStatus",
			query: {
				dataset: request.datasetId ?? request.dataset,
				pipeline: request.pipeline,
			},
			signal,
		});
	}

	async listDatasetData(datasetId: string, signal?: AbortSignal): Promise<unknown> {
		if (typeof datasetId !== "string" || datasetId.trim() === "") {
			throw new CogneeError("datasetId is required");
		}
		return this.#requestParsed({
			method: "GET",
			path: `/api/v1/datasets/${encodeURIComponent(datasetId)}/data`,
			operation: "listDatasetData",
			signal,
		});
	}

	async createDataset(
		request: CogneeCreateDatasetRequest,
		signal?: AbortSignal,
	): Promise<CogneeCreateDatasetResponse> {
		if (typeof request.name !== "string" || request.name.trim() === "") {
			throw new CogneeError("dataset name is required");
		}
		const parsed = await this.#requestParsed({
			method: "POST",
			path: "/api/v1/datasets",
			operation: "createDataset",
			json: { name: request.name },
			signal,
		});
		return normalizeDataset(parsed);
	}

	async #requestParsed(args: RequestParsedArgs): Promise<unknown> {
		const url = new URL(`${this.#baseUrl}${args.path}`);
		if (args.query) {
			for (const [key, value] of Object.entries(args.query)) {
				if (value !== undefined) url.searchParams.append(key, value);
			}
		}

		const headers = new Headers(this.#baseHeaders);
		let body = args.body;
		if (args.json !== undefined) {
			headers.set("Content-Type", "application/json");
			body = JSON.stringify(pruneUndefined(args.json));
		}

		let response: Response;
		try {
			response = await this.#fetchImpl(url.toString(), {
				method: args.method,
				headers,
				body,
				signal: args.signal,
			});
		} catch (err) {
			if (isAbortError(err)) throw err;
			throw new CogneeError(
				`${args.operation} request failed: ${boundedJson(err instanceof Error ? err.message : String(err))}`,
				undefined,
				undefined,
				err,
			);
		}

		const { parsed, rawText, hasBody } = await parseResponseBody(response);
		if (
			args.allowRecallForbiddenEmptyList &&
			response.status === 403 &&
			(rawText.trim() === "[]" || (Array.isArray(parsed) && parsed.length === 0))
		) {
			return [];
		}

		if (!response.ok) {
			const details = hasBody ? parsed : undefined;
			throw new CogneeError(
				`${args.operation} failed with HTTP ${response.status}: ${summarizeErrorDetails(details)}`,
				response.status,
				details,
			);
		}

		return hasBody ? parsed : {};
	}
}

export function createCogneeClient(options: CogneeApiOptions): CogneeClient {
	return new CogneeHttpClient(options);
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}

function safeJsonParse(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

async function parseResponseBody(response: Response): Promise<{ parsed: unknown; rawText: string; hasBody: boolean }> {
	const rawText = await response.text();
	if (rawText.trim() === "") return { parsed: {}, rawText, hasBody: false };
	const json = safeJsonParse(rawText);
	return { parsed: json.ok ? json.value : rawText, rawText, hasBody: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = record[name];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function usableStringField(record: Record<string, unknown>, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = record[name];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return undefined;
}

function numberField(record: Record<string, unknown>, ...names: string[]): number | undefined {
	for (const name of names) {
		const value = record[name];
		if (typeof value === "number") return value;
	}
	return undefined;
}

function arrayField(record: Record<string, unknown>, ...names: string[]): unknown[] | undefined {
	for (const name of names) {
		const value = record[name];
		if (Array.isArray(value)) return value;
	}
	return undefined;
}

function boundedJson(value: unknown): string {
	const text = stringifyBounded(value);
	return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH)}…` : text;
}

function stringifyBounded(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		const text = JSON.stringify(value, (_key, nested) => {
			if (typeof nested === "bigint") return nested.toString();
			if (typeof nested === "string" && nested.length > MAX_SUMMARY_LENGTH) {
				return `${nested.slice(0, MAX_SUMMARY_LENGTH)}…`;
			}
			return nested;
		});
		return text ?? String(value);
	} catch {
		return String(value);
	}
}

function summarizeErrorDetails(details: unknown): string {
	if (details === undefined) return "empty response";
	if (isRecord(details)) {
		for (const name of ["detail", "message", "error"]) {
			const value = details[name];
			if (typeof value === "string" && value.trim() !== "") return boundedJson(value);
		}
	}
	return boundedJson(details);
}

function appendIfDefined(form: FormData, field: string, value: unknown): void {
	if (value === undefined) return;
	form.append(field, value instanceof Blob ? value : String(value));
}

function appendRepeatedStrings(form: FormData, field: string, values?: string[]): void {
	if (values === undefined) return;
	for (const value of values) form.append(field, value);
}


function normalizeRememberResult(raw: unknown): CogneeRememberResult {
	if (!isRecord(raw)) return { raw };
	const result: CogneeRememberResult = { raw };
	const status = stringField(raw, "status");
	if (status !== undefined) result.status = status;
	const datasetName = stringField(raw, "datasetName", "dataset_name");
	if (datasetName !== undefined) result.datasetName = datasetName;
	const datasetId = stringField(raw, "datasetId", "dataset_id");
	if (datasetId !== undefined) result.datasetId = datasetId;
	const pipelineRunId = stringField(raw, "pipelineRunId", "pipeline_run_id", "operationId", "operation_id");
	if (pipelineRunId !== undefined) result.pipelineRunId = pipelineRunId;
	const itemsProcessed = numberField(raw, "itemsProcessed", "items_processed");
	if (itemsProcessed !== undefined) result.itemsProcessed = itemsProcessed;
	const elapsedSeconds = numberField(raw, "elapsedSeconds", "elapsed_seconds");
	if (elapsedSeconds !== undefined) result.elapsedSeconds = elapsedSeconds;
	const sessionIds = arrayField(raw, "sessionIds", "session_ids");
	if (sessionIds !== undefined) result.sessionIds = sessionIds.filter((item): item is string => typeof item === "string");
	const items = arrayField(raw, "items");
	if (items !== undefined) result.items = items;
	const contentHash = stringField(raw, "contentHash", "content_hash");
	if (contentHash !== undefined) result.contentHash = contentHash;
	const entryType = stringField(raw, "entryType", "entry_type");
	if (entryType !== undefined) result.entryType = entryType;
	const entryId = stringField(raw, "entryId", "entry_id");
	if (entryId !== undefined) result.entryId = entryId;
	const error = stringField(raw, "error") ?? stringField(raw, "message");
	if (error !== undefined) result.error = error;
	return result;
}

function normalizeRecallEntries(raw: unknown): CogneeRecallEntry[] {
	if (Array.isArray(raw)) return raw.map(normalizeRecallEntry);
	if (isRecord(raw)) {
		if (Object.keys(raw).length === 0) return [];
		const contained = arrayField(raw, "results", "items", "data");
		if (contained !== undefined) return contained.map(normalizeRecallEntry);
		return [normalizeRecallEntry(raw)];
	}
	if (typeof raw === "string") return [{ source: "unknown", text: raw, raw }];
	return [{ source: "unknown", text: boundedJson(raw), raw }];
}

function normalizeRecallEntry(item: unknown): CogneeRecallEntry {
	if (!isRecord(item)) return { source: "unknown", text: typeof item === "string" ? item : boundedJson(item), raw: item };

	const source = inferRecallSource(item);
	const base: CogneeRecallEntryBase = {
		source,
		text: recallText(item),
		raw: item,
	};
	const id = stringField(item, "id", "uuid", "dataId", "data_id", "qaId", "qa_id", "traceId", "trace_id", "nodeId", "node_id");
	if (id !== undefined) base.id = id;
	const score = numberField(item, "score");
	if (score !== undefined) base.score = score;
	const time = stringField(item, "time", "timestamp", "createdAt", "created_at", "updated_at");
	if (time !== undefined) base.time = time;

	if (source === "session") {
		const entry: CogneeRecallQaEntry = { ...base, source: "session" };
		const question = stringField(item, "question");
		if (question !== undefined) entry.question = question;
		const answer = stringField(item, "answer");
		if (answer !== undefined) entry.answer = answer;
		const context = stringField(item, "context");
		if (context !== undefined) entry.context = context;
		const qaId = stringField(item, "qaId", "qa_id");
		if (qaId !== undefined) entry.qaId = qaId;
		return entry;
	}
	if (source === "trace") {
		const entry: CogneeRecallTraceEntry = { ...base, source: "trace" };
		const traceId = stringField(item, "traceId", "trace_id");
		if (traceId !== undefined) entry.traceId = traceId;
		return entry;
	}
	if (source === "graph_context" || source === "session_context") {
		const entry: CogneeRecallGraphContextEntry = { ...base, source };
		const context = stringField(item, "context");
		if (context !== undefined) entry.context = context;
		return entry;
	}
	if (source === "graph") {
		const entry: CogneeRecallGraphEntry = { ...base, source: "graph" };
		const nodeName = stringField(item, "nodeName", "node_name", "name", "label");
		if (nodeName !== undefined) entry.nodeName = nodeName;
		return entry;
	}
	return base;
}

function inferRecallSource(item: Record<string, unknown>): CogneeRecallSource {
	const source = stringField(item, "source");
	if (source !== undefined) return source;
	if (
		"question" in item ||
		"answer" in item ||
		"qaId" in item ||
		"qa_id" in item
	) {
		return "session";
	}
	if ("traceId" in item || "trace_id" in item) return "trace";
	if (
		"nodeName" in item ||
		"node_name" in item ||
		"node" in item ||
		"nodeId" in item ||
		"node_id" in item ||
		"name" in item ||
		"label" in item
	) {
		return "graph";
	}
	return "unknown";
}

function recallText(item: Record<string, unknown>): string {
	const early = usableStringField(item, "text", "content", "context");
	if (early !== undefined) return early;
	const question = usableStringField(item, "question");
	const answer = usableStringField(item, "answer");
	if (question !== undefined && answer !== undefined) return `Q: ${question}\nA: ${answer}`;
	return usableStringField(item, "answer", "question", "message", "summary", "nodeName", "node_name", "name", "label") ?? boundedJson(item);
}

function normalizeDataset(raw: unknown): CogneeDataset {
	if (!isRecord(raw)) return { raw };
	const dataset: CogneeDataset = { raw };
	const id = stringField(raw, "id", "uuid", "dataset_id");
	if (id !== undefined) dataset.id = id;
	const name = stringField(raw, "name", "dataset_name");
	if (name !== undefined) dataset.name = name;
	const status = stringField(raw, "status");
	if (status !== undefined) dataset.status = status;
	return dataset;
}

function normalizeDatasets(raw: unknown): CogneeDataset[] {
	if (Array.isArray(raw)) return raw.map(normalizeDataset);
	if (isRecord(raw)) {
		const contained = arrayField(raw, "datasets", "items", "data");
		return contained === undefined ? [] : contained.map(normalizeDataset);
	}
	return [];
}


function isAbortError(err: unknown): boolean {
	return isRecord(err) && err.name === "AbortError";
}

