/**
 * CogneeSessionPropagation focused tests.
 *
 * Exercises the Cognee session side-channel accessor, lifecycle parity
 * (rekey / new-transcript reset / dispose), and parent-state propagation
 * through SDK startup and the task executor — all with fake
 * `CogneeSessionStateLike` objects. No live Cognee server, no real HTTP, no
 * real Cognee client.
 *
 * The alias-flattening mirrors in `task/index.ts` and `eval/agent-bridge.ts`
 * (`state?.aliasOf ?? state`) are one-line structural helpers over the accessor
 * proven below; per the implementation plan they are verified by code
 * inspection rather than a broad TaskTool / eval-bridge integration test.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackend from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { MemoryBackend, MemoryBackendStartOptions } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { removeSyncWithRetries, Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import {
	getCogneeSessionState,
	setCogneeSessionState,
	type CogneeSessionStateLike,
} from "../src/cognee/state";

// --- Fake Cognee session state ------------------------------------------------

interface FakeCogneeState extends CogneeSessionStateLike {
	readonly setSessionIdCalls: string[];
	resetCalls: number;
	flushCalls: number;
	disposeCalls: number;
	events: string[];
}

function createFakeCogneeState(
	overrides: { aliasOf?: CogneeSessionStateLike; sessionId?: string } = {},
): FakeCogneeState {
	const state: FakeCogneeState = {
		sessionId: overrides.sessionId ?? "sess-initial",
		aliasOf: overrides.aliasOf,
		lastRetainedTurn: 0,
		hasRecalledForFirstTurn: false,
		setSessionIdCalls: [],
		resetCalls: 0,
		flushCalls: 0,
		disposeCalls: 0,
		events: [],
		setSessionId(sid: string) {
			this.setSessionIdCalls.push(sid);
		},
		resetConversationTracking() {
			this.resetCalls += 1;
		},
		enqueueRetain() {},
		async flushRetainQueue() {
			this.flushCalls += 1;
			this.events.push("flush");
		},
		async beforeAgentStartPrompt(): Promise<string | undefined> {
			return undefined;
		},
		async dispose() {
			this.disposeCalls += 1;
			this.events.push("dispose");
		},
	};
	return state;
}

// --- Harness ------------------------------------------------------------------

interface Harness {
	agent: Agent;
	session: AgentSession;
	sessionManager: SessionManager;
	tempDir: TempDir;
	authStorage: AuthStorage;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	while (cleanup.length > 0) {
		const run = cleanup.pop();
		if (run) await run().catch(() => {});
	}
});

async function createHarness(backend: string = "off"): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-cognee-session-propagation-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const sessionManager = SessionManager.create(
		tempDir.path(),
		path.join(tempDir.path(), "sessions"),
	);
	const agent = new Agent({
		initialState: { systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "memory.backend": backend }),
		modelRegistry,
	});
	cleanup.push(async () => {
		await session.dispose().catch(() => {});
		authStorage.close();
		tempDir.removeSync();
	});
	return { agent, session, sessionManager, tempDir, authStorage };
}

// --- Accessor / lifecycle -----------------------------------------------------

describe("CogneeSessionPropagation: AgentSession side channel", () => {
	it("getCogneeSessionState returns the state registered via setCogneeSessionState and clears on undefined", async () => {
		const { session } = await createHarness("cognee");
		const fake = createFakeCogneeState();

		setCogneeSessionState(session, fake);
		expect(session.getCogneeSessionState()).toBe(fake);

		const previous = setCogneeSessionState(session, undefined);
		expect(previous).toBe(fake);
		expect(session.getCogneeSessionState()).toBeUndefined();
	});

	it("rekeys Cognee state to the fresh provider session id on freshSession()", async () => {
		const { agent, session } = await createHarness("cognee");
		const fake = createFakeCogneeState();
		setCogneeSessionState(session, fake);

		const result = session.freshSession();
		expect(result).toBeDefined();
		if (!result) return;

		// The fresh provider id is the new agent.sessionId; the rekey helper
		// must forward it to the Cognee state.
		expect(agent.sessionId).toBe(result.sessionId);
		expect(fake.setSessionIdCalls).toContain(result.sessionId);
	});

	it("resets primary Cognee conversation tracking on a new transcript", async () => {
		const { session } = await createHarness("cognee");
		const primary = createFakeCogneeState();
		setCogneeSessionState(session, primary);

		await session.newSession();

		expect(primary.resetCalls).toBe(1);
	});

	it("skips Cognee conversation-tracking reset for alias state on a new transcript", async () => {
		const { session } = await createHarness("cognee");
		const parentPrimary = createFakeCogneeState();
		const alias = createFakeCogneeState({ aliasOf: parentPrimary });
		setCogneeSessionState(session, alias);

		await session.newSession();

		// Aliases must never clear the parent primary's recall/turn counters.
		expect(alias.resetCalls).toBe(0);
		expect(parentPrimary.resetCalls).toBe(0);
	});

	it("flushes, clears the side channel, and disposes Cognee state on dispose()", async () => {
		// The dispose test owns its own session disposal; remove the shared
		// cleanup's dispose to avoid a double-dispose race.
		const harness = await createHarness("cognee");
		const { session, authStorage, tempDir } = harness;
		cleanup.pop();
		const fake = createFakeCogneeState();
		setCogneeSessionState(session, fake);

		await session.dispose();

		// Flush must happen before dispose so a retain queue that checks current
		// session state still sees itself while flushing.
		expect(fake.flushCalls).toBe(1);
		expect(fake.disposeCalls).toBe(1);
		expect(fake.events).toEqual(["flush", "dispose"]);
		expect(session.getCogneeSessionState()).toBeUndefined();

		authStorage.close();
		tempDir.removeSync();
	});

	it("does not rekey Cognee state when the backend is not cognee", async () => {
		const { session } = await createHarness("mnemopi");
		const fake = createFakeCogneeState();
		setCogneeSessionState(session, fake);

		session.freshSession();

		// Rekey guards on `memory.backend === "cognee"`; a Mnemopi session must
		// leave the Cognee state's session id untouched.
		expect(fake.setSessionIdCalls).toHaveLength(0);
	});
});

// --- SDK startup propagation --------------------------------------------------

describe("CogneeSessionPropagation: SDK startup forwarding", () => {
	it("forwards parentCogneeSessionState into memoryBackend.start options", async () => {
		const registryDir = path.join(os.tmpdir(), `pi-cognee-sdk-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		const authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);

		const fakePrimary = createFakeCogneeState({ sessionId: "parent-primary" });
		let capturedStart: (MemoryBackendStartOptions & { parentCogneeSessionState?: CogneeSessionStateLike }) | undefined;
		const fakeBackend: MemoryBackend = {
			id: "cognee",
			async start(options) {
				capturedStart = options as MemoryBackendStartOptions & {
					parentCogneeSessionState?: CogneeSessionStateLike;
				};
			},
			async buildDeveloperInstructions() {
				return undefined;
			},
			async clear() {},
			async enqueue() {},
		};
		const spy = vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(fakeBackend);

		const createdSessions: AgentSession[] = [];
		cleanup.push(async () => {
			for (const s of createdSessions) await s.dispose().catch(() => {});
			authStorage.close();
			if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
			spy.mockRestore();
		});

		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"memory.backend": "cognee",
				"autolearn.enabled": true,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			toolNames: ["read"],
			parentCogneeSessionState: fakePrimary,
		});
		createdSessions.push(session);

		expect(capturedStart).toBeDefined();
		expect(capturedStart?.parentCogneeSessionState).toBe(fakePrimary);
	});
});

// --- Task executor propagation ------------------------------------------------

function yieldingSubagentSession(): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	const session = {
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "retry_fallback_applied",
					from: "primary/bad-runtime-model",
					to: "fallback/working-model",
					role: "subagent:cognee-propagation",
				});
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success" },
					},
					isError: false,
				});
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

describe("CogneeSessionPropagation: task executor forwarding", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards parentCogneeSessionState from ExecutorOptions into createAgentSession", async () => {
		const fakePrimary = createFakeCogneeState({ sessionId: "parent-primary" });
		let capturedParent: CogneeSessionStateLike | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedParent = (options as { parentCogneeSessionState?: CogneeSessionStateLike })
				.parentCogneeSessionState;
			return {
				session: yieldingSubagentSession(),
				extensionsResult: {},
				setToolUIContext: () => {},
			} as never;
		});

		const primary = buildModel({
			provider: "primary",
			id: "bad-runtime-model",
			name: "bad-runtime-model",
			api: "openai-completions",
			baseUrl: "https://primary.example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		});
		const fallback = buildModel({
			provider: "fallback",
			id: "working-model",
			name: "working-model",
			api: "openai-completions",
			baseUrl: "https://fallback.example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		});

		const agent: AgentDefinition = {
			name: "task",
			description: "test",
			systemPrompt: "test",
			source: "bundled",
		};
		const settings = Settings.isolated({
			"retry.fallbackChains": { default: ["global/inherited-model"] },
		});
		settings.setModelRole("default", "primary/bad-runtime-model");

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "cognee-propagation",
			modelOverride: ["primary/bad-runtime-model", "fallback/working-model"],
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, fallback],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
			parentCogneeSessionState: fakePrimary,
		});

		expect(result).toBeDefined();
		expect(capturedParent).toBe(fakePrimary);
	});
});
