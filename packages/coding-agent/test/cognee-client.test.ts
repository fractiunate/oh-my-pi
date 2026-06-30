import { describe, expect, it } from "bun:test";
import { CogneeError, createCogneeClient } from "@oh-my-pi/pi-coding-agent/cognee/client";

type CapturedCall = {
	url: string;
	method?: string;
	headers: Headers;
	body?: BodyInit | null;
	signal?: AbortSignal | null;
};

type FetchOutcome = Response | Error;

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function fakeFetch(...outcomes: FetchOutcome[]): { fetch: typeof fetch; calls: CapturedCall[] } {
	const calls: CapturedCall[] = [];
	const queue = [...outcomes];
	const fetchImpl = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			calls.push({
				url: String(input),
				method: init?.method,
				headers: new Headers(init?.headers),
				body: init?.body ?? null,
				signal: init?.signal ?? null,
			});
			const next = queue.shift() ?? jsonResponse({});
			if (next instanceof Error) throw next;
			return next;
		},
		{ preconnect: globalThis.fetch.preconnect },
	) as typeof fetch;
	return { fetch: fetchImpl, calls };
}

function jsonBody(call: CapturedCall): Record<string, unknown> {
	return JSON.parse(String(call.body)) as Record<string, unknown>;
}

function formBody(call: CapturedCall): FormData {
	expect(call.body).toBeInstanceOf(FormData);
	return call.body as FormData;
}

describe("Cognee HTTP client", () => {
	it("remember posts FormData with exact fields, base URL trimming, and AbortSignal forwarding", async () => {
		const abort = new AbortController();
		const { fetch, calls } = fakeFetch(jsonResponse({ status: "ok" }));
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

		const call = calls[0];
		expect(call?.url).toBe("http://cognee.local/api/v1/remember");
		expect(call?.method).toBe("POST");
		expect(call?.signal).toBe(abort.signal);
		expect(call?.headers.get("Accept")).toBe("application/json");
		expect(call?.headers.get("User-Agent")).toBe("oh-my-pi-coding-agent");
		expect(call?.headers.has("Content-Type")).toBe(false);
		const form = formBody(call);
		expect(form.getAll("data").length).toBe(3);
		expect(form.getAll("data")[0]).toBe("first");
		expect(form.getAll("data")[1]).toBe("second");
		expect(form.getAll("data")[2]).toBeInstanceOf(Blob);
		expect((form.getAll("data")[2] as Blob).type).toBe("text/plain");
		expect(form.get("datasetName")).toBe("main");
		expect(form.get("datasetId")).toBe("dataset-id");
		expect(form.get("session_id")).toBe("session-id");
		expect(form.getAll("node_set")).toEqual(["project:a", "user:b"]);
		expect(form.get("run_in_background")).toBe("false");
		expect(form.get("custom_prompt")).toBe("custom");
		expect(form.get("chunk_size")).toBe("0");
		expect(form.get("chunks_per_batch")).toBe("12");
		expect(form.getAll("ontology_key")).toEqual(["key-a", "key-b"]);
		expect(form.get("graph_model")).toBe("graph-model");
		expect(form.get("content_type")).toBe("text/plain");
	});

	it("sends X-Api-Key when apiKey exists", async () => {
		const { fetch, calls } = fakeFetch();
		const client = createCogneeClient({ baseUrl: "http://cognee.local", apiKey: "secret", fetch });

		await client.remember({ data: "memory" });

		expect(calls[0]?.headers.get("X-Api-Key")).toBe("secret");
		expect(calls[0]?.headers.has("Authorization")).toBe(false);
	});

	it("sends Authorization only when apiKey is absent", async () => {
		const { fetch, calls } = fakeFetch();
		const client = createCogneeClient({ baseUrl: "http://cognee.local", bearerToken: "bearer", fetch });

		await client.remember({ data: "memory" });

		expect(calls[0]?.headers.get("Authorization")).toBe("Bearer bearer");
		expect(calls[0]?.headers.has("X-Api-Key")).toBe(false);
	});

	it("prefers X-Api-Key over bearer auth when both are configured", async () => {
		const { fetch, calls } = fakeFetch();
		const client = createCogneeClient({
			baseUrl: "http://cognee.local",
			apiKey: "secret",
			bearerToken: "bearer",
			fetch,
		});

		await client.remember({ data: "memory" });

		expect(calls[0]?.headers.get("X-Api-Key")).toBe("secret");
		expect(calls[0]?.headers.has("Authorization")).toBe(false);
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
		const { fetch } = fakeFetch(jsonResponse(raw));
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
		const { fetch, calls } = fakeFetch(jsonResponse({ status: "ok", entry_id: "entry" }));
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

		expect(calls[0]?.url).toBe("http://cognee.local/api/v1/remember/entry");
		expect(calls[0]?.headers.get("Content-Type")).toBe("application/json");
		expect(calls[0]?.signal).toBe(abort.signal);
		expect(jsonBody(calls[0])).toEqual({
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
		const { fetch, calls } = fakeFetch(jsonResponse([]));
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

		expect(calls[0]?.url).toBe("http://cognee.local/api/v1/recall");
		expect(jsonBody(calls[0])).toEqual({
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
		const { fetch } = fakeFetch(jsonResponse({ results: raw }));
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		const entries = await client.recall({ query: "q" });

		expect(entries.map((entry) => entry.source)).toEqual([
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
			expect(entries[index]?.raw).toBe(raw[index]);
		}
	});

	it("recall returns [] for normal 200 []", async () => {
		const { fetch } = fakeFetch(jsonResponse([]));
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await expect(client.recall({ query: "q" })).resolves.toEqual([]);
	});

	it("recall returns [] for 403 [] only", async () => {
		const { fetch } = fakeFetch(jsonResponse([], 403));
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await expect(client.recall({ query: "q" })).resolves.toEqual([]);
	});

	it("recall throws CogneeError for 403 JSON object and preserves details", async () => {
		const details = { error: "denied" };
		const { fetch } = fakeFetch(jsonResponse(details, 403));
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
		const { fetch, calls } = fakeFetch(jsonResponse("queued"));
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

		expect(calls[0]?.url).toBe("http://cognee.local/api/v1/improve");
		expect(jsonBody(calls[0])).toEqual({
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
		const { fetch, calls } = fakeFetch(jsonResponse({ ok: true }));
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await client.forget({ everything: false, dataset: "main", datasetId: "id", dataId: "data", memoryOnly: true });

		expect(calls[0]?.url).toBe("http://cognee.local/api/v1/forget");
		expect(jsonBody(calls[0])).toEqual({
			everything: false,
			dataset: "main",
			datasetId: "id",
			dataId: "data",
			memoryOnly: true,
		});
	});

	it("listDatasets calls GET and normalizes bare arrays and envelopes", async () => {
		const { fetch, calls } = fakeFetch(
			jsonResponse([{ uuid: "id-1", dataset_name: "main", status: "ready" }]),
			jsonResponse({ data: [{ id: "id-2", name: "other" }] }),
		);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await expect(client.listDatasets()).resolves.toMatchObject([
			{ id: "id-1", name: "main", status: "ready" },
		]);
		await expect(client.listDatasets()).resolves.toMatchObject([{ id: "id-2", name: "other" }]);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url).toBe("http://cognee.local/api/v1/datasets");
		expect(calls[1]?.url).toBe("http://cognee.local/api/v1/datasets");
	});

	it("getDatasetStatus sends dataset and pipeline query and returns parsed body unchanged", async () => {
		const raw = { pipeline_status: "ready" };
		const { fetch, calls } = fakeFetch(jsonResponse(raw));
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await expect(
			client.getDatasetStatus({ dataset: "ignored", datasetId: "dataset/id", pipeline: "cognify_pipeline" }),
		).resolves.toEqual(raw);

		const url = new URL(calls[0]?.url ?? "");
		expect(calls[0]?.method).toBe("GET");
		expect(`${url.origin}${url.pathname}`).toBe("http://cognee.local/api/v1/datasets/status");
		expect(url.searchParams.get("dataset")).toBe("dataset/id");
		expect(url.searchParams.get("pipeline")).toBe("cognify_pipeline");
	});

	it("listDatasetData URL-encodes datasetId and returns parsed body unchanged", async () => {
		const raw = [{ id: "data" }];
		const { fetch, calls } = fakeFetch(jsonResponse(raw));
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await expect(client.listDatasetData("dataset/id with space")).resolves.toEqual(raw);

		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url).toBe("http://cognee.local/api/v1/datasets/dataset%2Fid%20with%20space/data");
	});

	it("createDataset posts name, forwards AbortSignal, and normalizes the response", async () => {
		const abort = new AbortController();
		const raw = { dataset_id: "id", name: "main_dataset", status: "ready" };
		const { fetch, calls } = fakeFetch(jsonResponse(raw));
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		const result = await client.createDataset({ name: "main_dataset" }, abort.signal);

		expect(calls[0]?.url).toBe("http://cognee.local/api/v1/datasets");
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.signal).toBe(abort.signal);
		expect(jsonBody(calls[0])).toEqual({ name: "main_dataset" });
		expect(result).toEqual({ id: "id", name: "main_dataset", status: "ready", raw });
	});

	it("non-OK JSON errors throw CogneeError with status and parsed details", async () => {
		const details = { detail: "bad input" };
		const { fetch } = fakeFetch(jsonResponse(details, 422));
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
		const { fetch } = fakeFetch(new Response("server down", { status: 500 }));
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
		const { fetch } = fakeFetch(failure);
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
		const { fetch } = fakeFetch(abortError);
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await expect(client.listDatasets()).rejects.toBe(abortError);
	});

	it("validation failures happen before fetch", async () => {
		const { fetch, calls } = fakeFetch();
		const client = createCogneeClient({ baseUrl: "http://cognee.local", fetch });

		await expect(client.listDatasetData("")).rejects.toBeInstanceOf(CogneeError);
		await expect(client.recall({ query: "" })).rejects.toBeInstanceOf(CogneeError);
		await expect(client.rememberEntry({ type: "" })).rejects.toBeInstanceOf(CogneeError);
		await expect(client.createDataset({ name: "" })).rejects.toBeInstanceOf(CogneeError);
		expect(calls).toEqual([]);
	});
});
