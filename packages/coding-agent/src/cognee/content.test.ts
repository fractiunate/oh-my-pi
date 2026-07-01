import { describe, expect, it } from "bun:test";
import { formatCogneeDocumentFilename, prepareCogneeRetentionDocument } from "./content";
import type { CogneeScope } from "./scope";

const SCOPE: CogneeScope = {
	label: "project:oh-my-pi",
	datasetName: "omp",
	retainDatasetLabel: "omp",
	recallDatasetLabels: ["omp"],
	recallDatasets: ["omp"],
	projectLabel: "oh-my-pi",
};

describe("Cognee retention document filenames", () => {
	it("formats datetime and folder labels into safe text filenames", () => {
		const filename = formatCogneeDocumentFilename(new Date("2026-07-01T07:55:21.123Z"), "current folder", "01");
		expect(filename).toBe("2026-07-01T07-55-21-123Z-current-folder-01.txt");
	});

	it("attaches a datetime-folder filename to prepared retention documents", () => {
		const document = prepareCogneeRetentionDocument({
			messages: [{ role: "user", content: "Persist this fact." }],
			sessionId: "session-1",
			retainedAt: new Date("2026-07-01T07:55:21.123Z"),
			mode: "full-session",
			retainEveryNTurns: 1,
			retainOverlapTurns: 0,
			scope: SCOPE,
			documentLabel: "current folder",
		});

		expect(document?.filename).toBe("2026-07-01T07-55-21-123Z-current-folder.txt");
		expect(document?.content).toContain("Persist this fact.");
	});
});
