import { describe, expect, it } from "bun:test";
import { CogneeError, createCogneeClient } from "../src/cognee/client";
import { createFakeCogneeFetch, type RecordedCogneeFormValue, type RecordedCogneeRequest } from "./helpers/cognee";

function rejectingFetch(error: Error): typeof fetch {
	return Object.assign(
		async (_input: string | URL | Request, _init?: RequestInit) => {
			throw error;
		},
		{ preconnect: globalThis.fetch.preconnect },
	) as typeof fetch;
}

function jsonBody(call: RecordedCogneeRequest): Record<string, unknown> {
	const body = call.body;
	expect(body?.kind).toBe("json");
	if (body?.kind !== "json") throw new Error("Expected JSON body");
	return body.value as Record<string, unknown>;
}

function formBody(call: RecordedCogneeRequest): Record<string, RecordedCogneeFormValue[]> {
	const body = call.body;
	expect(body?.kind).toBe("form");
	if (body?.kind !== "form") throw new Error("Expected form body");
	return body.fields;
}

describe("Cognee HTTP client", () => {
	it("remember posts FormData with exact fields, base URL trimming, and AbortSignal forwarding", async () => {
		const abort = new AbortController();
		const { fetch, requests } = createFakeCogneeFetch([{ body: { status: "ok" } }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local/", fetch });

		await client.remember(
			{
				data: ["first", "second", new Uint8Array([1, 2])],
				datasetName: "main",
				datasetId: "dataset-id",
				sessionId: "session-id",
				nodeSet: ["project:a", "user:b"],
				runInBackground: false,
				customPrompt: "custom",
				chunkSize: 0,
				chunksPerBatch: 12,
				ontologyKeys: ["key-a", "key-b"],
				graphModel: "graph-model",
				contentType: "text/plain",
			},
			abort.signal,
		);

		const call = requests[0];
		expect(call?.path).toBe("/api/v1/remember");
		expect(call?.method).toBe("POST");
		expect(call?.signal).toBe(abort.signal);
		expect(call?.headers.accept).toBe("application/json");
		expect(call?.headers["user-agent"]).toBe("oh-my-pi-coding-agent");
		expect(call?.headers["content-type"]).toBeUndefined();
		const form = formBody(call as RecordedCogneeRequest);
		expect(form.data.length).toBe(3);
		const firstBlob = form.data[0] as { kind: string; type: string; size: number; text?: string };
		const secondBlob = form.data[1] as { kind: string; type: string; size: number; text?: string };
		expect(firstBlob).toMatchObject({ kind: "blob", type: "text/plain;charset=utf-8", text: "first" });
		expect(secondBlob).toMatchObject({ kind: "blob", type: "text/plain;charset=utf-8", text: "second" });
		const dataBlob = form.data[2] as { kind: string; type: string; size: number };
		expect(dataBlob.kind).toBe("blob");
		expect(dataBlob.type.startsWith("application/octet-stream")).toBe(true);
		expect(dataBlob.size).toBe(2);
		expect(form.datasetName[0]).toBe("main");
		expect(form.datasetId[0]).toBe("dataset-id");
		expect(form.session_id[0]).toBe("session-id");
		expect(form.node_set).toEqual(["project:a", "user:b"]);
		expect(form.run_in_background[0]).toBe("false");
		expect(form.custom_prompt[0]).toBe("custom");
		expect(form.chunk_size[0]).toBe("0");
		expect(form.chunks_per_batch[0]).toBe("12");
		expect(form.ontology_key).toEqual(["key-a", "key-b"]);
		expect(form.graph_model[0]).toBe("graph-model");
		expect(form.content_type[0]).toBe("text/plain");
	});

	it("sends X-Api-Key when apiKey exists", async () => {
		const { fetch, requests } = createFakeCogneeFetch([{ body: {} }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", apiKey: "secret", fetch });

		await client.remember({ data: "memory" });

		expect(requests[0]?.headers["x-api-key"]).toBe("secret");
		expect(requests[0]?.headers.authorization).toBeUndefined();
	});

	it("sends Authorization only when apiKey is absent", async () => {
		const { fetch, requests } = createFakeCogneeFetch([{ body: {} }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", bearerToken: "bearer", fetch });

		await client.remember({ data: "memory" });

		expect(requests[0]?.headers.authorization).toBe("Bearer bearer");
		expect(requests[0]?.headers["x-api-key"]).toBeUndefined();
	});

	it("prefers X-Api-Key over bearer auth when both are configured", async () => {
		const { fetch, requests } = createFakeCogneeFetch([{ body: {} }]);
		const client = createCogneeClient({
			baseUrl: "http://cognee.local",
			apiKey: "secret",
			bearerToken: "bearer",
			fetch,
		});

		await client.remember({ data: "memory" });

		expect(requests[0]?.headers["x-api-key"]).toBe("secret");
		expect(requests[0]?.headers.authorization).toBeUndefined();
	});

	it("remember normalizes snake_case fields and preserves raw", async () => {
		const raw = {
			status: "completed",
			dataset_name: "main",
			dataset_id: "dataset-id",
			pipeline_run_id: "run-id",
			items_processed: 2,
			elapsed_seconds: 1.5,
			session_ids: ["s1", "s2"],
			items: [{ id: "item" }],
			content_hash: "hash",
			entry_type: "qa",
			entry_id: "entry-id",
			message: "fallback error",
		};
		const { fetch } = createFakeCogneeFetch([{ body: raw }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		const result = await client.remember({ data: "memory" });

		expect(result).toMatchObject({
			status: "completed",
			datasetName: "main",
			datasetId: "dataset-id",
			pipelineRunId: "run-id",
			itemsProcessed: 2,
			elapsedSeconds: 1.5,
			sessionIds: ["s1", "s2"],
			items: [{ id: "item" }],
			contentHash: "hash",
			entryType: "qa",
			entryId: "entry-id",
			error: "fallback error",
			raw,
		});
	});

	it("rememberEntry posts JSON, prunes top-level undefined, preserves metadata, forwards signal, and normalizes", async () => {
		const abort = new AbortController();
		const { fetch, requests } = createFakeCogneeFetch([{ body: { status: "ok", entry_id: "entry" } }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		const result = await client.rememberEntry(
			{
				type: "qa",
				datasetName: "main",
				datasetId: undefined,
				sessionId: "session",
				question: "Q?",
				answer: "A",
				trace: undefined,
				feedback: { rating: 1 },
				skillImprovement: { skill: "debug" },
				metadata: { nested: { value: 1 }, empty: [], enabled: false },
			},
			abort.signal,
		);

		expect(requests[0]?.path).toBe("/api/v1/remember/entry");
		expect(requests[0]?.headers["content-type"]).toBe("application/json");
		expect(requests[0]?.signal).toBe(abort.signal);
		expect(jsonBody(requests[0] as RecordedCogneeRequest)).toEqual({
			type: "qa",
			datasetName: "main",
			sessionId: "session",
			question: "Q?",
			answer: "A",
			feedback: { rating: 1 },
			skillImprovement: { skill: "debug" },
			metadata: { nested: { value: 1 }, empty: [], enabled: false },
		});
		expect(result.entryId).toBe("entry");
	});

	it("recall posts exact camelCase JSON keys", async () => {
		const { fetch, requests } = createFakeCogneeFetch([{ body: [] }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await client.recall({
			query: "how to debug",
			searchType: "GRAPH_COMPLETION",
			datasets: ["main"],
			datasetIds: ["id"],
			systemPrompt: "system",
			nodeName: ["project:a"],
			topK: 3,
			onlyContext: false,
			verbose: true,
			includeReferences: true,
			sessionId: "session",
			scope: ["graph", "trace"],
			contextProfile: "profile",
		});

		expect(requests[0]?.path).toBe("/api/v1/recall");
		expect(jsonBody(requests[0] as RecordedCogneeRequest)).toEqual({
			query: "how to debug",
			searchType: "GRAPH_COMPLETION",
			datasets: ["main"],
			datasetIds: ["id"],
			systemPrompt: "system",
			nodeName: ["project:a"],
			topK: 3,
			onlyContext: false,
			verbose: true,
			includeReferences: true,
			sessionId: "session",
			scope: ["graph", "trace"],
			contextProfile: "profile",
		});
	});

	it("recall normalizes known and unknown entry shapes", async () => {
		const raw = [
			{ source: "session", question: "Q?", answer: "A", qa_id: "qa", score: 0.9, timestamp: "now" },
			{ source: "trace", trace_id: "trace", text: "trace text" },
			{ source: "graph_context", content: "graph context", context: "ctx" },
			{ source: "session_context", context: "session context" },
			{ node_name: "node" },
			{ strange: { nested: true } },
		];
		const { fetch } = createFakeCogneeFetch([{ body: { results: raw } }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		const entries = await client.recall({ query: "q" });

		expect(entries.map(entry => entry.source)).toEqual([
			"session",
			"trace",
			"graph_context",
			"session_context",
			"graph",
			"unknown",
		]);
		expect(entries[0]).toMatchObject({ text: "Q: Q?\nA: A", qaId: "qa", id: "qa", score: 0.9, time: "now" });
		expect(entries[1]).toMatchObject({ text: "trace text", traceId: "trace" });
		expect(entries[2]).toMatchObject({ text: "graph context", context: "ctx" });
		expect(entries[3]).toMatchObject({ text: "session context", context: "session context" });
		expect(entries[4]).toMatchObject({ text: "node", nodeName: "node" });
		for (let index = 0; index < entries.length; index += 1) {
			expect(entries[index]?.text.length).toBeGreaterThan(0);
			expect(entries[index]?.raw).toEqual(raw[index]);
		}
	});

	it("recall returns [] for normal 200 []", async () => {
		const { fetch } = createFakeCogneeFetch([{ body: [] }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await expect(client.recall({ query: "q" })).resolves.toEqual([]);
	});

	it("recall returns [] for 403 [] only", async () => {
		const { fetch } = createFakeCogneeFetch([{ body: [], status: 403 }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await expect(client.recall({ query: "q" })).resolves.toEqual([]);
	});

	it("recall throws CogneeError for 403 JSON object and preserves details", async () => {
		const details = { error: "denied" };
		const { fetch } = createFakeCogneeFetch([{ body: details, status: 403 }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		try {
			await client.recall({ query: "q" });
			throw new Error("Expected recall to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CogneeError);
			expect((err as CogneeError).status).toBe(403);
			expect((err as CogneeError).details).toEqual(details);
		}
	});

	it("improve posts exact camelCase JSON keys and wraps non-object success", async () => {
		const { fetch, requests } = createFakeCogneeFetch([{ body: "queued" }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		const result = await client.improve({
			datasetName: "main",
			datasetId: "id",
			sessionIds: ["s"],
			nodeName: ["node"],
			runInBackground: false,
			buildGlobalContextIndex: true,
			data: "text",
			extractionTasks: ["extract"],
			enrichmentTasks: ["enrich"],
		});

		expect(requests[0]?.path).toBe("/api/v1/improve");
		expect(jsonBody(requests[0] as RecordedCogneeRequest)).toEqual({
			datasetName: "main",
			datasetId: "id",
			sessionIds: ["s"],
			nodeName: ["node"],
			runInBackground: false,
			buildGlobalContextIndex: true,
			data: "text",
			extractionTasks: ["extract"],
			enrichmentTasks: ["enrich"],
		});
		expect(result).toEqual({ raw: "queued" });
	});

	it("forget posts exact camelCase JSON keys", async () => {
		const { fetch, requests } = createFakeCogneeFetch([{ body: { ok: true } }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await client.forget({ everything: false, dataset: "main", datasetId: "id", dataId: "data", memoryOnly: true });

		expect(requests[0]?.path).toBe("/api/v1/forget");
		expect(jsonBody(requests[0] as RecordedCogneeRequest)).toEqual({
			everything: false,
			dataset: "main",
			datasetId: "id",
			dataId: "data",
			memoryOnly: true,
		});
	});

	it("listDatasets calls GET and normalizes bare arrays and envelopes", async () => {
		const { fetch, requests } = createFakeCogneeFetch([
			{ body: [{ uuid: "id-1", dataset_name: "main", status: "ready" }] },
			{ body: { data: [{ id: "id-2", name: "other" }] } },
		]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await expect(client.listDatasets()).resolves.toMatchObject([{ id: "id-1", name: "main", status: "ready" }]);
		await expect(client.listDatasets()).resolves.toMatchObject([{ id: "id-2", name: "other" }]);
		expect(requests[0]?.method).toBe("GET");
		expect(requests[0]?.path).toBe("/api/v1/datasets");
		expect(requests[1]?.path).toBe("/api/v1/datasets");
	});

	it("getDatasetStatus sends dataset and pipeline query and returns parsed body unchanged", async () => {
		const raw = { pipeline_status: "ready" };
		const { fetch, requests } = createFakeCogneeFetch([{ body: raw }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await expect(
			client.getDatasetStatus({ dataset: "ignored", datasetId: "dataset/id", pipeline: "cognify_pipeline" }),
		).resolves.toEqual(raw);

		const path = requests[0]?.path ?? "";
		expect(requests[0]?.method).toBe("GET");
		expect(path.startsWith("/api/v1/datasets/status")).toBe(true);
		const query = new URLSearchParams(path.slice(path.indexOf("?")));
		expect(query.get("dataset")).toBe("dataset/id");
		expect(query.get("pipeline")).toBe("cognify_pipeline");
	});

	it("listDatasetData URL-encodes datasetId and returns parsed body unchanged", async () => {
		const raw = [{ id: "data" }];
		const { fetch, requests } = createFakeCogneeFetch([{ body: raw }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await expect(client.listDatasetData("dataset/id with space")).resolves.toEqual(raw);

		expect(requests[0]?.method).toBe("GET");
		expect(requests[0]?.path).toBe("/api/v1/datasets/dataset%2Fid%20with%20space/data");
	});

	it("createDataset posts name, forwards AbortSignal, and normalizes the response", async () => {
		const abort = new AbortController();
		const raw = { dataset_id: "id", name: "main_dataset", status: "ready" };
		const { fetch, requests } = createFakeCogneeFetch([{ body: raw }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		const result = await client.createDataset({ name: "main_dataset" }, abort.signal);

		expect(requests[0]?.path).toBe("/api/v1/datasets");
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.signal).toBe(abort.signal);
		expect(jsonBody(requests[0] as RecordedCogneeRequest)).toEqual({ name: "main_dataset" });
		expect(result).toEqual({ id: "id", name: "main_dataset", status: "ready", raw });
	});

	it("non-OK JSON errors throw CogneeError with status and parsed details", async () => {
		const details = { detail: "bad input" };
		const { fetch } = createFakeCogneeFetch([{ body: details, status: 422 }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		try {
			await client.createDataset({ name: "main" });
			throw new Error("Expected createDataset to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CogneeError);
			expect((err as CogneeError).status).toBe(422);
			expect((err as CogneeError).details).toEqual(details);
			expect((err as Error).message).toContain("createDataset failed with HTTP 422: bad input");
		}
	});

	it("non-OK text errors throw CogneeError with status and text details", async () => {
		const { fetch } = createFakeCogneeFetch([{ text: "server down", status: 500 }]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		try {
			await client.listDatasets();
			throw new Error("Expected listDatasets to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CogneeError);
			expect((err as CogneeError).status).toBe(500);
			expect((err as CogneeError).details).toBe("server down");
		}
	});

	it("network failures throw CogneeError with cause", async () => {
		const failure = new Error("connect ECONNREFUSED");
		const fetch = rejectingFetch(failure);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		try {
			await client.listDatasets();
			throw new Error("Expected listDatasets to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CogneeError);
			expect((err as CogneeError).status).toBeUndefined();
			expect((err as CogneeError).details).toBeUndefined();
			expect((err as CogneeError).cause).toBe(failure);
		}
	});

	it("abort-shaped fetch rejection is rethrown unchanged", async () => {
		const abortError = new Error("aborted");
		abortError.name = "AbortError";
		const fetch = rejectingFetch(abortError);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await expect(client.listDatasets()).rejects.toBe(abortError);
	});

	it("validation failures happen before fetch", async () => {
		const { fetch, requests } = createFakeCogneeFetch([]);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await expect(client.listDatasetData("")).rejects.toBeInstanceOf(CogneeError);
		await expect(client.recall({ query: "" })).rejects.toBeInstanceOf(CogneeError);
		await expect(client.rememberEntry({ type: "" })).rejects.toBeInstanceOf(CogneeError);
		await expect(client.createDataset({ name: "" })).rejects.toBeInstanceOf(CogneeError);
		expect(requests).toEqual([]);
	});
});
