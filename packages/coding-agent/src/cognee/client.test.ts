import { describe, expect, it } from "bun:test";
import { createCogneeClient } from "./client";

function makeResponse(body: unknown): Response {
	return Response.json(body);
}

describe("CogneeHttpClient remember", () => {
	it("sends named data items as multipart files", async () => {
		let capturedBody: unknown = null;
		const fetchImpl = (async (_url, init) => {
			capturedBody = init?.body ?? null;
			return makeResponse({ status: "completed" });
		}) as typeof fetch;

		const client = createCogneeClient({ baseUrl: "https://cognee.test", fetch: fetchImpl });
		await client.remember({
			datasetName: "omp",
			data: {
				content: "remember this",
				filename: "2026-07-01T07-55-21-123Z-oh-my-pi.txt",
				contentType: "text/plain",
			},
		});

		expect(capturedBody).toBeInstanceOf(FormData);
		const form = capturedBody as FormData;
		const file = form.get("data");
		expect(file).toBeInstanceOf(File);
		expect((file as File).name).toBe("2026-07-01T07-55-21-123Z-oh-my-pi.txt");
		expect((file as File).type).toContain("text/plain");
		expect(await (file as File).text()).toBe("remember this");
		expect(form.get("datasetName")).toBe("omp");
	});

	it("applies item contentType when named content is already a Blob", async () => {
		let capturedBody: unknown = null;
		const fetchImpl = (async (_url, init) => {
			capturedBody = init?.body ?? null;
			return makeResponse({ status: "completed" });
		}) as typeof fetch;

		const client = createCogneeClient({ baseUrl: "https://cognee.test", fetch: fetchImpl });
		await client.remember({
			data: {
				content: new Blob(["# note"]),
				filename: "note.md",
				contentType: "text/markdown",
			},
			contentType: "skills",
		});

		expect(capturedBody).toBeInstanceOf(FormData);
		const form = capturedBody as FormData;
		const file = form.get("data");
		expect(file).toBeInstanceOf(File);
		expect((file as File).name).toBe("note.md");
		expect((file as File).type).toContain("text/markdown");
		expect(await (file as File).text()).toBe("# note");
		expect(form.get("content_type")).toBe("skills");
	});
});
