import { describe, expect, it } from "bun:test";
import type { AgentSession } from "../session/agent-session";
import type { CogneeClient, CogneeRememberDataItem, CogneeRememberRequest, CogneeRememberResult } from "./client";
import type { CogneeConfig } from "./config";
import type { CogneeScope } from "./scope";
import { CogneeSessionState } from "./state";

function makeClient(calls: CogneeRememberRequest[]): CogneeClient {
	const remember = async (request: CogneeRememberRequest): Promise<CogneeRememberResult> => {
		calls.push(request);
		return { status: "completed", raw: { status: "completed" } };
	};
	return {
		remember,
		rememberEntry: async () => ({ status: "completed", raw: { status: "completed" } }),
		recall: async () => [],
		improve: async () => ({}),
		forget: async () => ({}),
		listDatasets: async () => [],
		getDatasetStatus: async () => ({}),
		listDatasetData: async () => ({}),
		createDataset: async request => ({ name: request.name, raw: { name: request.name } }),
	};
}

function makeState(calls: CogneeRememberRequest[]): CogneeSessionState {
	const session = {
		sessionManager: {
			getCwd: () => "/tmp/Current Folder",
			getEntries: () => [],
		},
		emitNotice: () => {},
		subscribe: () => () => {},
		refreshBaseSystemPrompt: async () => {},
	} as unknown as AgentSession;
	const config = {
		retainContext: "manual",
		runInBackground: false,
		ontologyKeys: [],
		sessionMemoryEnabled: false,
	} as unknown as CogneeConfig;
	const scope: CogneeScope = {
		label: "global:omp",
		datasetName: "omp",
		retainDatasetLabel: "omp",
		recallDatasetLabels: ["omp"],
		recallDatasets: ["omp"],
	};
	return new CogneeSessionState({
		sessionId: "session-1",
		client: makeClient(calls),
		config,
		scope,
		session,
	});
}

describe("CogneeSessionState", () => {
	it("saves manual memories with datetime-current-folder filenames", async () => {
		const calls: CogneeRememberRequest[] = [];
		const state = makeState(calls);

		const result = await state.save({ content: "Remember project convention.", context: "test" });

		expect(result.stored).toBe(1);
		expect(calls).toHaveLength(1);
		const data = calls[0].data as CogneeRememberDataItem;
		expect(data.content).toContain("Remember project convention.");
		expect(data.filename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-Current-Folder\.txt$/);
	});
});
