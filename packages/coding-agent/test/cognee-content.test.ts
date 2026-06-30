import { describe, expect, it } from "bun:test";
import {
	composeCogneeRecallQuery,
	flattenMessagesForCognee,
	formatCogneeRecallBlock,
	formatCogneeSearchItem,
	prepareCogneeRetentionDocument,
	truncateApproxTokensOrChars,
	truncateCogneeRecallQuery,
} from "../src/cognee/content";

type AgentMessageForCognee = Parameters<typeof flattenMessagesForCognee>[0][number];
type TestConfig = Parameters<typeof formatCogneeRecallBlock>[1];
type TestScope = Parameters<typeof formatCogneeRecallBlock>[2];
type TestEntry = Parameters<typeof formatCogneeRecallBlock>[0][number];

const asAgentMessage = (message: unknown): AgentMessageForCognee => message as AgentMessageForCognee;
const asEntry = (entry: unknown): TestEntry => entry as TestEntry;

const scope: TestScope = {
	label: "project:oh-my-pi",
	projectLabel: "oh-my-pi",
	retainDatasetLabel: "omp",
	recallDatasetLabels: ["omp"],
} as TestScope;

const globalScope: TestScope = {
	label: "global:omp",
	retainDatasetLabel: "omp",
	recallDatasetLabels: ["omp"],
} as TestScope;

const config: TestConfig = {
	apiUrl: null,
	apiKey: null,
	datasetName: null,
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
	chunkSize: null,
	chunksPerBatch: null,
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
	recallPromptPreamble: "",
	onlyContext: false,
	verbose: false,
	improveOnEnqueue: true,
	buildGlobalContextIndex: false,
	sessionMemoryEnabled: false,
	debug: false,
} as TestConfig;

describe("flattenMessagesForCognee", () => {
	it("retains user string content", () => {
		const messages = [asAgentMessage({ role: "user", content: "Remember this" })];

		expect(flattenMessagesForCognee(messages)).toEqual([{ role: "user", content: "Remember this" }]);
	});

	it("joins user text blocks with newlines", () => {
		const messages = [
			asAgentMessage({
				role: "user",
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
					{ type: "input_image", data: "data:image/png;base64,secret" },
				],
			}),
		];

		expect(flattenMessagesForCognee(messages)).toEqual([{ role: "user", content: "first\nsecond" }]);
	});

	it("retains assistant visible text blocks", () => {
		const messages = [
			asAgentMessage({
				role: "assistant",
				content: [
					{ type: "text", text: "visible" },
					{ type: "text", text: "answer" },
				],
			}),
		];

		expect(flattenMessagesForCognee(messages)).toEqual([{ role: "assistant", content: "visible\nanswer" }]);
	});

	it("drops assistant thinking, redacted thinking, and tool-call-only blocks", () => {
		const messages = [
			asAgentMessage({
				role: "assistant",
				content: [
					{ type: "thinking", text: "private" },
					{ type: "redactedThinking", data: "private" },
					{ type: "toolCall", name: "bash" },
				],
			}),
			asAgentMessage({
				role: "assistant",
				content: [
					{ type: "thinking", text: "private" },
					{ type: "text", text: "public" },
				],
			}),
		];

		expect(flattenMessagesForCognee(messages)).toEqual([{ role: "assistant", content: "public" }]);
	});

	it("skips non-primary roles", () => {
		const messages = [
			asAgentMessage({ role: "tool", content: "tool output" }),
			asAgentMessage({ role: "toolResult", content: "tool output" }),
			asAgentMessage({ role: "bashExecution", content: "shell" }),
			asAgentMessage({ role: "developer", content: "instruction" }),
			asAgentMessage({ role: "system", content: "instruction" }),
			asAgentMessage({ role: "custom", content: "custom" }),
			asAgentMessage({ role: "user", content: "kept" }),
		];

		expect(flattenMessagesForCognee(messages)).toEqual([{ role: "user", content: "kept" }]);
	});

	it("summarizes image-only user content without retaining bytes", () => {
		const messages = [
			asAgentMessage({
				role: "user",
				content: [{ type: "input_image", data: "data:image/png;base64,secret", mimeType: "image/png" }],
			}),
		];

		const flattened = flattenMessagesForCognee(messages);
		expect(flattened).toEqual([{ role: "user", content: "[image omitted]" }]);
		expect(flattened[0].content).not.toContain("data:image");
		expect(flattened[0].content).not.toContain("secret");
	});

	it("skips punctuation-only assistant turns", () => {
		const messages = [asAgentMessage({ role: "assistant", content: [{ type: "text", text: "... — ! ?" }] })];

		expect(flattenMessagesForCognee(messages)).toEqual([]);
	});
});

describe("Cognee memory-tag stripping", () => {
	it("strips Cognee and legacy memory blocks from retention documents", () => {
		const document = prepareCogneeRetentionDocument({
			messages: [
				{
					role: "user",
					content:
						"keep <cognee_memories>drop</cognee_memories><memories>drop</memories><mental_models>drop</mental_models><hindsight_memories>drop</hindsight_memories><relevant_memories>drop</relevant_memories> tail",
				},
			],
			sessionId: "session-1",
			retainedAt: new Date("2026-06-30T00:00:00.000Z"),
			mode: "full-session",
			retainEveryNTurns: 1,
			retainOverlapTurns: 0,
			scope,
		});

		expect(document?.content).toContain("keep  tail");
		expect(document?.content).not.toContain("<cognee_memories>");
		expect(document?.content).not.toContain("<memories>");
		expect(document?.content).not.toContain("<mental_models>");
		expect(document?.content).not.toContain("<hindsight_memories>");
		expect(document?.content).not.toContain("<relevant_memories>");
	});

	it("strips memory blocks from recall query context", () => {
		const query = composeCogneeRecallQuery(
			"latest",
			[
				{ role: "user", content: "before <cognee_memories>secret</cognee_memories> after" },
				{ role: "assistant", content: "reply <memories>old</memories> visible" },
				{ role: "user", content: "latest" },
			],
			2,
			globalScope,
		);

		expect(query).toContain("user: before  after");
		expect(query).toContain("assistant: reply  visible");
		expect(query).not.toContain("secret");
		expect(query).not.toContain("<memories>");
	});

	it("removes multiple sequential complete blocks while keeping surrounding text", () => {
		const document = prepareCogneeRetentionDocument({
			messages: [{ role: "user", content: "alpha <memories>a</memories><memories>b</memories> omega" }],
			sessionId: "session-1",
			retainedAt: new Date("2026-06-30T00:00:00.000Z"),
			mode: "full-session",
			retainEveryNTurns: 1,
			retainOverlapTurns: 0,
			scope,
		});

		expect(document?.content).toContain("alpha  omega");
	});

	it("keeps malformed unmatched tags as ordinary substantive text", () => {
		const document = prepareCogneeRetentionDocument({
			messages: [{ role: "user", content: "keep <memories>unclosed text" }],
			sessionId: "session-1",
			retainedAt: new Date("2026-06-30T00:00:00.000Z"),
			mode: "full-session",
			retainEveryNTurns: 1,
			retainOverlapTurns: 0,
			scope,
		});

		expect(document?.content).toContain("keep <memories>unclosed text");
	});
});

describe("composeCogneeRecallQuery", () => {
	it("returns latest prompt with no prior context when contextTurns is one", () => {
		const query = composeCogneeRecallQuery(
			"latest prompt",
			[{ role: "user", content: "older" }],
			1,
			globalScope,
		);

		expect(query).toBe("Scope: global:omp\n\nLatest prompt:\nlatest prompt");
		expect(query).not.toContain("Prior context:");
	});

	it("includes only recent user-bounded turns", () => {
		const query = composeCogneeRecallQuery(
			"latest",
			[
				{ role: "user", content: "old user" },
				{ role: "assistant", content: "old assistant" },
				{ role: "user", content: "recent user" },
				{ role: "assistant", content: "recent assistant" },
				{ role: "user", content: "latest" },
			],
			2,
			globalScope,
		);

		expect(query).toContain("user: recent user");
		expect(query).toContain("assistant: recent assistant");
		expect(query).not.toContain("old user");
		expect(query).not.toContain("old assistant");
	});

	it("does not duplicate the latest prompt inside prior context", () => {
		const query = composeCogneeRecallQuery(
			"latest",
			[
				{ role: "user", content: "earlier" },
				{ role: "assistant", content: "answer" },
				{ role: "user", content: "latest" },
			],
			2,
			globalScope,
		);

		expect(query.match(/user: latest/g)).toBeNull();
		expect(query.endsWith("Latest prompt:\nlatest")).toBe(true);
	});

	it("includes the project label and avoids duplicate project scope", () => {
		const query = composeCogneeRecallQuery("latest", [], 1, scope);

		expect(query).toBe("Project: oh-my-pi\n\nLatest prompt:\nlatest");
		expect(query).not.toContain("Scope: project:oh-my-pi");
	});
});

describe("truncateCogneeRecallQuery", () => {
	it("leaves under-budget queries unchanged", () => {
		const query = "short latest";

		expect(truncateCogneeRecallQuery(query, "short latest", 100)).toBe(query);
	});

	it("returns bounded latest prompt for no-context over-budget queries", () => {
		expect(truncateCogneeRecallQuery("abcdef", "abcdef", 3)).toBe("abc");
	});

	it("drops oldest context before newer context", () => {
		const latest = "latest";
		const query = composeCogneeRecallQuery(
			latest,
			[
				{ role: "user", content: "old" },
				{ role: "assistant", content: "middle" },
				{ role: "user", content: "new" },
				{ role: "assistant", content: "newer" },
				{ role: "user", content: latest },
			],
			3,
			globalScope,
		);
		const max = "Scope: global:omp\n\nPrior context:\nuser: new\nassistant: newer\n\nLatest prompt:\nlatest".length;
		const truncated = truncateCogneeRecallQuery(query, latest, max);

		expect(truncated).not.toContain("user: old");
		expect(truncated).not.toContain("assistant: middle");
		expect(truncated).toContain("user: new");
		expect(truncated).toContain("assistant: newer");
	});

	it("keeps fitting project scope lines when full scope does not fit", () => {
		const scoped = { ...scope, label: "project-tagged:oh-my-pi" } as TestScope;
		const query = composeCogneeRecallQuery("latest", [{ role: "user", content: "older" }], 2, scoped);
		const max = "Project: oh-my-pi\n\nLatest prompt:\nlatest".length;
		const truncated = truncateCogneeRecallQuery(query, "latest", max);

		expect(truncated).toBe("Project: oh-my-pi\n\nLatest prompt:\nlatest");
		expect(truncated).not.toContain("Scope: project-tagged:oh-my-pi");
		expect(truncated).not.toContain("older");
	});

	it("keeps latest prompt when scope and context cannot fit", () => {
		const query = composeCogneeRecallQuery(
			"must survive",
			[{ role: "user", content: "lots of prior context" }],
			2,
			globalScope,
		);

		expect(truncateCogneeRecallQuery(query, "must survive", "must survive".length)).toBe("must survive");
	});

	it("returns stripped latest prompt for non-positive budgets", () => {
		expect(truncateCogneeRecallQuery("ignored", "<memories>drop</memories>latest", 0)).toBe("latest");
		expect(truncateCogneeRecallQuery("ignored", "<memories>drop</memories>", -1)).toBe("");
	});

	it("does not split surrogate pairs", () => {
		expect(truncateCogneeRecallQuery("😀😀😀", "😀😀😀", 2)).toBe("😀😀");
	});
});

describe("prepareCogneeRetentionDocument", () => {
	it("uses all messages and session ID for full-session retention", () => {
		const document = prepareCogneeRetentionDocument({
			messages: [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "world" },
			],
			sessionId: "session-1",
			retainedAt: new Date("2026-06-30T12:00:00.000Z"),
			mode: "full-session",
			retainEveryNTurns: 1,
			retainOverlapTurns: 0,
			scope,
		});

		expect(document).toEqual({
			content:
				"Session: session-1\nRetained at: 2026-06-30T12:00:00.000Z\nScope: project:oh-my-pi\nProject: oh-my-pi\n\n[role: user]\nhello\n[user:end]\n\n[role: assistant]\nworld\n[assistant:end]",
			documentId: "session-1",
			contentType: "text/markdown",
		});
	});

	it("uses retain window turns and timestamped document ID for last-turn retention", () => {
		const retainedAt = new Date("2026-06-30T12:00:00.000Z");
		const document = prepareCogneeRetentionDocument({
			messages: [
				{ role: "user", content: "old user" },
				{ role: "assistant", content: "old assistant" },
				{ role: "user", content: "middle user" },
				{ role: "assistant", content: "middle assistant" },
				{ role: "user", content: "new user" },
				{ role: "assistant", content: "new assistant" },
			],
			sessionId: "session-1",
			retainedAt,
			mode: "last-turn",
			retainEveryNTurns: 1,
			retainOverlapTurns: 1,
			scope,
		});

		expect(document?.documentId).toBe(`session-1-${retainedAt.getTime()}`);
		expect(document?.content).not.toContain("old user");
		expect(document?.content).toContain("middle user");
		expect(document?.content).toContain("new assistant");
	});

	it("preserves internal newlines", () => {
		const document = prepareCogneeRetentionDocument({
			messages: [{ role: "user", content: "line one\nline two" }],
			sessionId: "session-1",
			retainedAt: new Date("2026-06-30T12:00:00.000Z"),
			mode: "full-session",
			retainEveryNTurns: 1,
			retainOverlapTurns: 0,
			scope,
		});

		expect(document?.content).toContain("line one\nline two");
	});

	it("returns null when no substantive content remains", () => {
		const document = prepareCogneeRetentionDocument({
			messages: [
				{ role: "user", content: "<memories>meaningful only inside stripped block</memories>" },
				{ role: "assistant", content: "..." },
			],
			sessionId: "session-1",
			retainedAt: new Date("2026-06-30T12:00:00.000Z"),
			mode: "full-session",
			retainEveryNTurns: 1,
			retainOverlapTurns: 0,
			scope,
		});

		expect(document).toBeNull();
	});
});

describe("formatCogneeRecallBlock", () => {
	it("returns undefined for empty entries", () => {
		expect(formatCogneeRecallBlock([], config, scope, new Date("2026-06-30T00:00:00.000Z"))).toBeUndefined();
	});

	it("returns undefined when all entries are non-substantive", () => {
		expect(
			formatCogneeRecallBlock(
				[asEntry({ source: "session", text: "...", raw: {} })],
				config,
				scope,
				new Date("2026-06-30T00:00:00.000Z"),
			),
		).toBeUndefined();
	});

	it("drops non-substantive session question answer fallbacks", () => {
		expect(
			formatCogneeRecallBlock(
				[asEntry({ source: "session", text: "", question: "...", answer: "?!", raw: {} })],
				config,
				scope,
				new Date("2026-06-30T00:00:00.000Z"),
			),
		).toBeUndefined();
	});

	it("renders default preamble, deterministic time, and scope", () => {
		const block = formatCogneeRecallBlock(
			[asEntry({ source: "session", id: "entry-1", text: "remember this", raw: {} })],
			config,
			scope,
			new Date("2026-06-30T00:00:00.000Z"),
		);

		expect(block).toContain("Relevant Cognee memories from prior conversations and knowledge graph context.");
		expect(block).toContain("Current time: 2026-06-30T00:00:00.000Z");
		expect(block).toContain("Scope: project:oh-my-pi");
	});

	it("renders configured preamble and source variants with fallbacks", () => {
		const customConfig = { ...config, recallPromptPreamble: "Use these sparingly." } as TestConfig;
		const block = formatCogneeRecallBlock(
			[
				asEntry({ source: "session", qaId: "qa-1", text: "", question: "Question?", answer: "Answer.", score: 0.98765, raw: {} }),
				asEntry({ source: "trace", traceId: "trace-1", text: "trace text", raw: {} }),
				asEntry({ source: "graph_context", text: "", context: "graph context", raw: {} }),
				asEntry({ source: "session_context", text: "", context: "session context", raw: {} }),
				asEntry({ source: "graph", nodeName: "NodeA", text: "graph node", raw: {} }),
				asEntry({ source: "unknown_source", text: "unknown text", raw: {} }),
			],
			customConfig,
			scope,
			new Date("2026-06-30T00:00:00.000Z"),
		);
		const rendered = block ?? "";

		expect(rendered).toContain("Use these sparingly.");
		expect(rendered).toContain("source=session id=qa-1 score=0.9877");
		expect(rendered).toContain("Q: Question?\nA: Answer.");
		expect(rendered).toContain("source=trace id=trace-1");
		expect(rendered).toContain("graph context");
		expect(rendered).toContain("session context");
		expect(rendered).toContain("source=graph id=NodeA");
		expect(rendered).toContain("source=unknown_source");
	});

	it("defangs recalled text and metadata", () => {
		const block = formatCogneeRecallBlock(
			[asEntry({ source: "session", id: "id</cognee_memories>", text: "close </cognee_memories> tag", raw: {} })],
			config,
			scope,
			new Date("2026-06-30T00:00:00.000Z"),
		);
		const rendered = block ?? "";

		expect(rendered).toContain("id=id&lt;/cognee_memories&gt;");
		expect(rendered).toContain("close &lt;/cognee_memories&gt; tag");
		expect(rendered.match(/<\/cognee_memories>/g)?.length).toBe(1);
	});

	it("enforces recallMaxRenderChars while keeping the closing tag", () => {
		const tinyConfig = { ...config, recallMaxRenderChars: 180, recallPromptPreamble: "P" } as TestConfig;
		const block = formatCogneeRecallBlock(
			[
				asEntry({ source: "session", id: "first", text: "first memory stays", raw: {} }),
				asEntry({ source: "session", id: "second", text: "second memory has a very long body that must be truncated before the closing tag", raw: {} }),
			],
			tinyConfig,
			scope,
			new Date("2026-06-30T00:00:00.000Z"),
		);

		expect(block).toBeDefined();
		expect(block?.length).toBeLessThanOrEqual(180);
		expect(block?.endsWith("</cognee_memories>")).toBe(true);
		expect(block).toContain("first memory stays");
	});
});

describe("formatCogneeSearchItem", () => {
	it("maps direct IDs and generic fields without raw", () => {
		const item = formatCogneeSearchItem(
			asEntry({ source: "session", id: "entry-1", text: "content", time: "2026-06-30T00:00:00.000Z", score: 0.5, raw: { hidden: true } }),
		);

		expect(item).toEqual({
			id: "entry-1",
			content: "content",
			source: "session",
			timestamp: "2026-06-30T00:00:00.000Z",
			score: 0.5,
		});
		expect("raw" in item).toBe(false);
	});

	it("maps source-specific fallback IDs and empty-content fallback", () => {
		expect(formatCogneeSearchItem(asEntry({ source: "session", qaId: "qa-1", text: "question", raw: {} })).id).toBe("qa-1");
		expect(formatCogneeSearchItem(asEntry({ source: "trace", traceId: "trace-1", text: "trace", raw: {} })).id).toBe("trace-1");
		expect(formatCogneeSearchItem(asEntry({ source: "graph", nodeName: "NodeA", text: "graph", raw: {} })).id).toBe("NodeA");
		expect(formatCogneeSearchItem(asEntry({ source: "unknown", text: "...", raw: {} })).content).toBe("[empty Cognee recall entry]");
	});

	it("does not count Q/A labels as substantive search content", () => {
		expect(formatCogneeSearchItem(asEntry({ source: "session", text: "", question: "...", answer: "?!", raw: {} })).content).toBe(
			"[empty Cognee recall entry]",
		);
	});
});

describe("truncateApproxTokensOrChars", () => {
	it("returns an empty string for non-positive limits", () => {
		expect(truncateApproxTokensOrChars("abc", 0)).toBe("");
		expect(truncateApproxTokensOrChars("abc", -1)).toBe("");
	});

	it("returns under-limit text unchanged", () => {
		expect(truncateApproxTokensOrChars("abc", 10)).toBe("abc");
	});

	it("bounds over-limit text without an ellipsis", () => {
		expect(truncateApproxTokensOrChars("abcdef", 3)).toBe("abc");
	});

	it("does not split emoji surrogate pairs", () => {
		expect(truncateApproxTokensOrChars("😀😀abc", 2)).toBe("😀😀");
	});
});
