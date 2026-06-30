import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import type { CogneeConfig } from "./config";

const DEFAULT_DATASET_NAME = "omp";
const PROJECT_NODE_PREFIX = "project:";
const UNKNOWN_PROJECT = "unknown";

type CogneeConfigWithNodeSet = CogneeConfig & { nodeSet?: readonly string[] };

type DatasetTarget = Pick<
	CogneeScope,
	"datasetName" | "datasetId" | "retainDatasetLabel" | "recallDatasetLabels" | "recallDatasets" | "recallDatasetIds"
>;

export interface CogneeScope {
	/** Stable label for status/debug output, e.g. "global:omp" or "project:oh-my-pi". */
	label: string;

	/** Dataset target for remember/improve/forget. Exactly one of name/id should be set. */
	datasetName?: string;
	datasetId?: string;

	/** Human labels for MemoryBackendStatus. */
	retainDatasetLabel: string;
	recallDatasetLabels: string[];

	/** Recall target arrays. Dataset IDs win over names. */
	recallDatasets?: string[];
	recallDatasetIds?: string[];

	/** Node tags sent to remember. Includes configured static nodes plus project node when applicable. */
	retainNodeSet?: string[];

	/** Optional node filter for strict project recall. Undefined in v1 per-project-tagged to preserve global+project recall. */
	recallNodeName?: string[];

	/** Project label derived from primary git checkout root or cwd basename. */
	projectLabel?: string;
	projectNode?: string;

	/** The OMP session ID to forward to Cognee session-memory APIs when enabled. */
	sessionId?: string;
}

function clean(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function baseDatasetName(config: CogneeConfig): string {
	const baseName = clean(config.datasetName) ?? DEFAULT_DATASET_NAME;
	const prefix = clean(config.datasetNamePrefix);
	return prefix ? `${prefix}-${baseName}` : baseName;
}

function deriveProjectLabel(cwd: string): string {
	if (!cwd) return UNKNOWN_PROJECT;
	const primaryRoot = git.repo.primaryRootSync(cwd);
	return path.basename(primaryRoot ?? cwd) || UNKNOWN_PROJECT;
}

function nameTarget(datasetName: string): DatasetTarget {
	return {
		datasetName,
		retainDatasetLabel: datasetName,
		recallDatasetLabels: [datasetName],
		recallDatasets: [datasetName],
	};
}

function idTarget(datasetId: string): DatasetTarget {
	const datasetLabel = `id:${datasetId}`;
	return {
		datasetId,
		retainDatasetLabel: datasetLabel,
		recallDatasetLabels: [datasetLabel],
		recallDatasetIds: [datasetId],
	};
}

function normalizedNodeSet(config: CogneeConfigWithNodeSet, projectNode?: string): string[] | undefined {
	const nodes: string[] = [];
	const seen = new Set<string>();

	for (const candidate of [...(config.nodeSet ?? []), projectNode]) {
		const node = clean(candidate);
		if (!node || seen.has(node)) continue;
		seen.add(node);
		nodes.push(node);
	}

	return nodes.length ? nodes : undefined;
}

export function deriveCogneeDatasetName(config: CogneeConfig, cwd: string): string {
	const base = baseDatasetName(config);

	switch (config.scoping) {
		case "global":
			return base;
		case "per-project":
			return `${base}-${deriveProjectLabel(cwd)}`;
		case "per-project-tagged":
			return base;
	}

	const exhaustive: never = config.scoping;
	return exhaustive;
}

export function computeCogneeScope(config: CogneeConfig, cwd: string, sessionId?: string): CogneeScope {
	const id = clean(config.datasetId);
	const session = clean(sessionId);
	const staticNodeSet = normalizedNodeSet(config);
	const sessionField = session ? { sessionId: session } : {};

	switch (config.scoping) {
		case "global": {
			if (id) {
				return {
					label: `global:id:${id}`,
					...idTarget(id),
					...(staticNodeSet ? { retainNodeSet: staticNodeSet } : {}),
					...sessionField,
				};
			}

			const datasetName = deriveCogneeDatasetName(config, cwd);
			return {
				label: `global:${datasetName}`,
				...nameTarget(datasetName),
				...(staticNodeSet ? { retainNodeSet: staticNodeSet } : {}),
				...sessionField,
			};
		}
		case "per-project": {
			if (id) {
				const projectLabel = deriveProjectLabel(cwd);
				logger.warn(
					"Cognee per-project scoping cannot derive per-project dataset IDs; using configured dataset ID as a global target.",
					{ scoping: config.scoping, datasetId: id, projectLabel },
				);
				return {
					label: `global:id:${id}`,
					...idTarget(id),
					...(staticNodeSet ? { retainNodeSet: staticNodeSet } : {}),
					...sessionField,
				};
			}

			const projectLabel = deriveProjectLabel(cwd);
			const datasetName = deriveCogneeDatasetName(config, cwd);
			return {
				label: `project:${projectLabel}`,
				...nameTarget(datasetName),
				projectLabel,
				...(staticNodeSet ? { retainNodeSet: staticNodeSet } : {}),
				...sessionField,
			};
		}
		case "per-project-tagged": {
			const projectLabel = deriveProjectLabel(cwd);
			const projectNode = `${PROJECT_NODE_PREFIX}${projectLabel}`;
			const retainNodeSet = normalizedNodeSet(config, projectNode);
			const target = id ? idTarget(id) : nameTarget(deriveCogneeDatasetName(config, cwd));

			return {
				label: `project-tagged:${projectLabel}`,
				...target,
				projectLabel,
				projectNode,
				...(retainNodeSet ? { retainNodeSet } : {}),
				// Soft scoping: recall intentionally searches the shared dataset without a node filter so
				// untagged/global memories remain visible; users needing hard isolation must use per-project.
				...sessionField,
			};
		}
	}

	const exhaustive: never = config.scoping;
	return exhaustive;
}
