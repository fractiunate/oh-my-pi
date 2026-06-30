import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isCogneeConfigured, loadCogneeConfig } from "@oh-my-pi/pi-coding-agent/cognee/config";

const DEFAULT_RECALL_PREAMBLE =
	"Relevant Cognee memories from prior conversations and knowledge graph context. " +
	"Use only when directly useful; verify against current repo state before acting.";

describe("loadCogneeConfig", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("defaults", () => {
		it("applies contracted defaults for a cognee-selected isolated settings instance", () => {
			const settings = Settings.isolated({ "memory.backend": "cognee" });
			const config = loadCogneeConfig(settings, {});

			expect(config.apiUrl).toBe("http://localhost:8000");
			expect(config.nodeSet).toEqual([]);
			expect(config.scoping).toBe("per-project-tagged");
			expect(config.retainMode).toBe("full-session");
			expect(config.recallSearchType).toBe("GRAPH_COMPLETION");
			expect(config.recallScope).toBe("auto");
			expect(config.recallPromptPreamble).toBe(DEFAULT_RECALL_PREAMBLE);

			// Numeric defaults
			expect(config.retainEveryNTurns).toBe(3);
			expect(config.retainOverlapTurns).toBe(2);
			expect(config.recallTopK).toBe(10);
			expect(config.recallContextTurns).toBe(1);
			expect(config.recallMaxQueryChars).toBe(1200);
			expect(config.recallMaxRenderChars).toBe(12000);
			// chunkSize/chunksPerBatch default to positive integers from schema
			expect(config.chunkSize).toBe(4096);
			expect(config.chunksPerBatch).toBe(36);

			// Misc defaults
			expect(config.datasetNamePrefix).toBe("");
			expect(config.retainContext).toBe("omp");
			expect(config.autoRecall).toBe(true);
			expect(config.autoRetain).toBe(true);
			expect(config.runInBackground).toBe(true);
			expect(config.improveOnEnqueue).toBe(true);
			expect(config.buildGlobalContextIndex).toBe(false);
			expect(config.sessionMemoryEnabled).toBe(false);
			expect(config.debug).toBe(false);
			expect(config.onlyContext).toBe(false);
			expect(config.verbose).toBe(false);
		});
	});

	describe("environment overrides", () => {
		it("overrides apiUrl and apiKey when env values are non-blank, trimmed", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.apiUrl": "http://from-settings:8000",
				"cognee.apiKey": "settings-key",
			});
			const config = loadCogneeConfig(settings, {
				COGNEE_API_URL: "  http://from-env:9000  ",
				COGNEE_API_KEY: "  env-key  ",
			});

			expect(config.apiUrl).toBe("http://from-env:9000");
			expect(config.apiKey).toBe("env-key");
		});

		it("does not override setting values when env values are blank", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.apiUrl": "http://from-settings:8000",
				"cognee.apiKey": "settings-key",
			});
			const config = loadCogneeConfig(settings, {
				COGNEE_API_URL: "   ",
				COGNEE_API_KEY: "",
			});

			expect(config.apiUrl).toBe("http://from-settings:8000");
			expect(config.apiKey).toBe("settings-key");
		});
	});

	describe("nullable strings", () => {
		it("turns blank datasetName/datasetId/customPrompt/graphModel into null", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.datasetName": "  ",
				"cognee.datasetId": "",
				"cognee.customPrompt": "   ",
				"cognee.graphModel": "",
			});
			const config = loadCogneeConfig(settings, {});

			expect(config.datasetName).toBeNull();
			expect(config.datasetId).toBeNull();
			expect(config.customPrompt).toBeNull();
			expect(config.graphModel).toBeNull();
		});

		it("preserves non-blank nullable strings", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.datasetName": "my-ds",
				"cognee.datasetId": "uuid-1234",
				"cognee.customPrompt": "custom prompt",
				"cognee.graphModel": "rdf",
			});
			const config = loadCogneeConfig(settings, {});

			expect(config.datasetName).toBe("my-ds");
			expect(config.datasetId).toBe("uuid-1234");
			expect(config.customPrompt).toBe("custom prompt");
			expect(config.graphModel).toBe("rdf");
		});

		it("turns blank datasetNamePrefix into empty string", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.datasetNamePrefix": "   ",
			});
			const config = loadCogneeConfig(settings, {});

			expect(config.datasetNamePrefix).toBe("");
		});
	});

	describe("array normalization", () => {
		it("trims, dedupes, drops empty and non-string entries for nodeSet and ontologyKeys", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.nodeSet": ["  a  ", "b", "", "  ", "a", 3, null, "c"],
				"cognee.ontologyKeys": ["x", "x", "  y  ", "y"],
			});
			const config = loadCogneeConfig(settings, {});

			expect(config.nodeSet).toEqual(["a", "b", "c"]);
			expect(config.ontologyKeys).toEqual(["x", "y"]);
		});

		it("returns empty arrays for non-array values", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.nodeSet": "not-an-array",
				"cognee.ontologyKeys": 42,
			});
			const config = loadCogneeConfig(settings, {});

			expect(config.nodeSet).toEqual([]);
			expect(config.ontologyKeys).toEqual([]);
		});
	});

	describe("closed enum validation", () => {
		it("falls back to per-project-tagged and warns on invalid scoping", () => {
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.scoping": "banana",
			});
			const config = loadCogneeConfig(settings, {});

			expect(config.scoping).toBe("per-project-tagged");
			expect(warnSpy).toHaveBeenCalled();
			const warnArg = warnSpy.mock.calls[0]?.[0];
			expect(String(warnArg)).toContain("Cognee: invalid scoping");
		});

		it("falls back to full-session and warns on invalid retainMode", () => {
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.retainMode": "banana",
			});
			const config = loadCogneeConfig(settings, {});

			expect(config.retainMode).toBe("full-session");
			expect(warnSpy).toHaveBeenCalled();
			const warnArg = warnSpy.mock.calls[0]?.[0];
			expect(String(warnArg)).toContain("Cognee: invalid retainMode");
		});

		it("does not warn when scoping and retainMode are valid", () => {
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.scoping": "global",
				"cognee.retainMode": "last-turn",
			});
			const config = loadCogneeConfig(settings, {});

			expect(config.scoping).toBe("global");
			expect(config.retainMode).toBe("last-turn");
			expect(warnSpy).not.toHaveBeenCalled();
		});
	});

	describe("open string defaults", () => {
		it("accepts any non-blank recallSearchType and recallScope", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.recallSearchType": "CUSTOM_TYPE",
				"cognee.recallScope": "custom-scope",
			});
			const config = loadCogneeConfig(settings, {});

			expect(config.recallSearchType).toBe("CUSTOM_TYPE");
			expect(config.recallScope).toBe("custom-scope");
		});

		it("defaults blank recallSearchType and recallScope", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.recallSearchType": "  ",
				"cognee.recallScope": "",
			});
			const config = loadCogneeConfig(settings, {});

			expect(config.recallSearchType).toBe("GRAPH_COMPLETION");
			expect(config.recallScope).toBe("auto");
		});
	});

	describe("numeric clamping", () => {
		it("clamps retainEveryNTurns to at least 1", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.retainEveryNTurns": 0,
			});
			expect(loadCogneeConfig(settings, {}).retainEveryNTurns).toBe(1);

			const settings2 = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.retainEveryNTurns": 5,
			});
			expect(loadCogneeConfig(settings2, {}).retainEveryNTurns).toBe(5);
		});

		it("clamps recallTopK and recallContextTurns to at least 1", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.recallTopK": -3,
				"cognee.recallContextTurns": 0,
			});
			const config = loadCogneeConfig(settings, {});
			expect(config.recallTopK).toBe(1);
			expect(config.recallContextTurns).toBe(1);
		});

		it("clamps retainOverlapTurns to at least 0", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.retainOverlapTurns": -5,
			});
			expect(loadCogneeConfig(settings, {}).retainOverlapTurns).toBe(0);
		});

		it("clamps recallMaxQueryChars and recallMaxRenderChars to at least 0", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.recallMaxQueryChars": -10,
				"cognee.recallMaxRenderChars": -1,
			});
			const config = loadCogneeConfig(settings, {});
			expect(config.recallMaxQueryChars).toBe(0);
			expect(config.recallMaxRenderChars).toBe(0);
		});

		it("returns null for non-positive or non-integer chunkSize/chunksPerBatch", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.chunkSize": 0,
				"cognee.chunksPerBatch": -1,
			});
			const config = loadCogneeConfig(settings, {});
			expect(config.chunkSize).toBeNull();
			expect(config.chunksPerBatch).toBeNull();
		});

		it("returns null for non-integer chunkSize", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.chunkSize": 4096.5,
			});
			expect(loadCogneeConfig(settings, {}).chunkSize).toBeNull();
		});

		it("returns positive integer chunkSize/chunksPerBatch when valid", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.chunkSize": 8192,
				"cognee.chunksPerBatch": 36,
			});
			const config = loadCogneeConfig(settings, {});
			expect(config.chunkSize).toBe(8192);
			expect(config.chunksPerBatch).toBe(36);
		});

		it("falls back to defaults for non-numeric values", () => {
			const settings = Settings.isolated({
				"memory.backend": "cognee",
				"cognee.retainEveryNTurns": "not-a-number",
				"cognee.recallTopK": NaN,
			});
			const config = loadCogneeConfig(settings, {});
			expect(config.retainEveryNTurns).toBe(3);
			expect(config.recallTopK).toBe(10);
		});
	});
});

describe("isCogneeConfigured", () => {
	it("returns true only for non-empty apiUrl", () => {
		const settings = Settings.isolated({ "memory.backend": "cognee" });
		const configured = loadCogneeConfig(settings, { COGNEE_API_URL: "http://x:8000" });
		expect(isCogneeConfigured(configured)).toBe(true);
	});

	it("returns false when apiUrl is null", () => {
		const settings = Settings.isolated({
			"memory.backend": "cognee",
			"cognee.apiUrl": "",
		});
		const config = loadCogneeConfig(settings, {});
		expect(isCogneeConfigured(config)).toBe(false);
	});
});
