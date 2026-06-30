import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingTab,
	TAB_GROUPS,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { getSettingsForTab } from "@oh-my-pi/pi-coding-agent/modes/components/settings-defs";

interface UiShape {
	tab: SettingTab;
	group?: string;
}

function getUi(path: SettingPath): UiShape | undefined {
	const entry = SETTINGS_SCHEMA[path];
	if (!("ui" in entry)) return undefined;
	return entry.ui;
}

describe("settings layout", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("every UI setting declares a group registered in TAB_GROUPS for its tab", () => {
		const violations: string[] = [];
		for (const path in SETTINGS_SCHEMA) {
			const ui = getUi(path as SettingPath);
			if (!ui) continue;
			if (!ui.group) {
				violations.push(`${path}: missing ui.group`);
			} else if (!TAB_GROUPS[ui.tab].includes(ui.group)) {
				violations.push(`${path}: group "${ui.group}" not in TAB_GROUPS["${ui.tab}"]`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("getSettingsForTab returns contiguous groups in TAB_GROUPS order", () => {
		for (const tab of SETTING_TABS) {
			const defs = getSettingsForTab(tab);
			expect(defs.length).toBeGreaterThan(0);

			// Collapse the def sequence into the order groups first appear.
			const sequence: string[] = [];
			for (const def of defs) {
				const group = def.group ?? "";
				if (sequence[sequence.length - 1] !== group) sequence.push(group);
			}

			// Contiguous: no group appears twice in the collapsed sequence.
			expect(new Set(sequence).size).toBe(sequence.length);

			// Ordered: grouped sections follow the TAB_GROUPS declaration order.
			const grouped = sequence.filter(group => group !== "");
			const expected = TAB_GROUPS[tab].filter(group => grouped.includes(group));
			expect(grouped).toEqual(expected);
		}
	});

	it("registers the Cognee memory group after existing memory groups", () => {
		expect(TAB_GROUPS.memory.filter(group => group === "Cognee")).toHaveLength(1);
		expect(TAB_GROUPS.memory).toEqual(["General", "Auto-Learn", "Mnemopi", "Hindsight", "Cognee"]);
	});

	it("exposes only visible Cognee rows in the memory tab", () => {
		const cogneeVisiblePaths: SettingPath[] = [
			"cognee.apiUrl",
			"cognee.datasetName",
			"cognee.datasetId",
			"cognee.scoping",
			"cognee.autoRecall",
			"cognee.autoRetain",
			"cognee.retainMode",
			"cognee.runInBackground",
			"cognee.recallSearchType",
			"cognee.recallScope",
			"cognee.onlyContext",
			"cognee.improveOnEnqueue",
			"cognee.buildGlobalContextIndex",
			"cognee.sessionMemoryEnabled",
		];
		const cogneeVisiblePathSet = new Set(cogneeVisiblePaths);
		const memoryDefs = getSettingsForTab("memory");
		const cogneeDefs = memoryDefs.filter(def => cogneeVisiblePathSet.has(def.path));

		expect(cogneeDefs.map(def => def.path)).toEqual(cogneeVisiblePaths);
		for (const def of cogneeDefs) {
			expect(def.tab).toBe("memory");
			expect(def.group).toBe("Cognee");
			expect(def.condition).toBeDefined();
		}
	});

	it("keeps Cognee config-file-only settings out of the memory tab", () => {
		const hiddenCogneePaths: SettingPath[] = [
			"cognee.apiKey",
			"cognee.datasetNamePrefix",
			"cognee.nodeSet",
			"cognee.ontologyKeys",
			"cognee.retainEveryNTurns",
			"cognee.recallTopK",
			"cognee.debug",
		];
		const memoryPathSet = new Set(getSettingsForTab("memory").map(def => def.path));

		for (const path of hiddenCogneePaths) {
			expect(path in SETTINGS_SCHEMA).toBe(true);
			expect(memoryPathSet.has(path)).toBe(false);
		}
		expect(getUi("cognee.apiKey")).toBeUndefined();
	});

	it("shows Cognee memory rows only when Cognee is the active backend", () => {
		const cogneeDefs = getSettingsForTab("memory").filter(def => def.group === "Cognee");

		for (const def of cogneeDefs) {
			expect(def.condition?.()).toBe(false);
		}

		for (const backend of ["local", "hindsight", "mnemopi"] as const) {
			Settings.instance.set("memory.backend", backend);
			for (const def of cogneeDefs) {
				expect(def.condition?.()).toBe(false);
			}
		}

		Settings.instance.set("memory.backend", "cognee");
		for (const def of cogneeDefs) {
			expect(def.condition?.()).toBe(true);
		}
	});

	it("keeps Hindsight and Mnemopi rows hidden when Cognee is active", () => {
		Settings.instance.set("memory.backend", "cognee");
		const memoryDefs = getSettingsForTab("memory");
		const hindsightDefs = memoryDefs.filter(def => def.group === "Hindsight" && def.condition);
		const mnemopiDefs = memoryDefs.filter(def => def.group === "Mnemopi" && def.condition);

		for (const def of hindsightDefs) {
			expect(def.condition?.()).toBe(false);
		}
		for (const def of mnemopiDefs) {
			expect(def.condition?.()).toBe(false);
		}

		Settings.instance.set("memory.backend", "hindsight");
		for (const def of hindsightDefs) {
			expect(def.condition?.()).toBe(true);
		}

		Settings.instance.set("memory.backend", "mnemopi");
		for (const def of mnemopiDefs) {
			expect(def.condition?.()).toBe(true);
		}
	});

	it("exposes native terminal progress in the appearance settings menu", () => {
		const def = getSettingsForTab("appearance").find(def => def.path === "terminal.showProgress");

		expect(def).toMatchObject({
			type: "boolean",
			label: "Native Terminal Progress",
			group: "Display",
		});
	});

	it("hides advisor dependent settings when advisor is disabled", () => {
		const advisorDependentPaths: SettingPath[] = ["advisor.subagents", "advisor.syncBacklog", "advisor.immuneTurns"];
		const advisorDependentPathSet = new Set(advisorDependentPaths);
		const defs = getSettingsForTab("model").filter(def => advisorDependentPathSet.has(def.path));

		expect(defs.map(def => def.path)).toEqual(advisorDependentPaths);
		for (const def of defs) {
			expect(def.condition?.()).toBe(false);
		}

		Settings.instance.set("advisor.enabled", true);

		for (const def of defs) {
			expect(def.condition?.()).toBe(true);
		}
	});

	it("shows provider request limits as a providers services submenu setting", () => {
		const [def] = getSettingsForTab("providers").filter(item => item.path === "providers.maxInFlightRequests");

		expect(def).toMatchObject({
			path: "providers.maxInFlightRequests",
			type: "providerLimits",
			tab: "providers",
			group: "Services",
		});
	});
});
