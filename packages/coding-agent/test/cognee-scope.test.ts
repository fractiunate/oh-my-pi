import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { CogneeConfig } from "../src/cognee/config";
import { computeCogneeScope, deriveCogneeDatasetName } from "../src/cognee/scope";

// Isolate `git` invocations in this file from the host's global config —
// `~/.gitconfig` commit signing or template hooks would otherwise make the
// linked-worktree fixtures flaky.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_ASKPASS = "true";
delete process.env.XDG_CONFIG_HOME;

type TestCogneeConfig = CogneeConfig & { nodeSet: string[] };

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test User",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test User",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		const stdout = new TextDecoder().decode(result.stdout).trim();
		throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout || `exit ${result.exitCode}`}`);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

const baseConfig = (overrides: Partial<TestCogneeConfig> = {}): TestCogneeConfig => ({
	apiUrl: "http://localhost:8000",
	apiKey: null,
	datasetName: null,
	datasetId: null,
	datasetNamePrefix: "",
	scoping: "per-project-tagged",
	nodeSet: [],
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 3,
	retainOverlapTurns: 2,
	retainContext: "omp",
	runInBackground: true,
	chunkSize: 4096,
	chunksPerBatch: 36,
	customPrompt: null,
	ontologyKeys: [],
	graphModel: null,
	recallSearchType: "GRAPH_COMPLETION",
	recallScope: "auto",
	recallTopK: 10,
	recallContextTurns: 1,
	recallMaxQueryChars: 1200,
	recallMaxRenderChars: 12_000,
	recallPromptPreamble: "preamble",
	onlyContext: false,
	verbose: false,
	improveOnEnqueue: true,
	buildGlobalContextIndex: false,
	sessionMemoryEnabled: false,
	debug: false,
	...overrides,
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("computeCogneeScope", () => {
	describe("global", () => {
		it("returns the default shared dataset target", () => {
			expect(computeCogneeScope(baseConfig({ scoping: "global" }), "/work/proj")).toEqual({
				label: "global:omp",
				datasetName: "omp",
				retainDatasetLabel: "omp",
				recallDatasetLabels: ["omp"],
				recallDatasets: ["omp"],
			});
		});

		it("applies configured dataset name and prefix", () => {
			const scope = computeCogneeScope(
				baseConfig({ scoping: "global", datasetName: "team", datasetNamePrefix: "prod" }),
				"/work/proj",
			);

			expect(scope.datasetName).toBe("prod-team");
			expect(scope.recallDatasets).toEqual(["prod-team"]);
			expect(scope.retainDatasetLabel).toBe("prod-team");
			expect(scope.recallDatasetLabels).toEqual(["prod-team"]);
		});

		it("trims dataset scalars and falls back from blanks", () => {
			expect(
				deriveCogneeDatasetName(
					baseConfig({ scoping: "global", datasetName: "   ", datasetNamePrefix: "  " }),
					"/work/proj",
				),
			).toBe("omp");
			expect(
				deriveCogneeDatasetName(
					baseConfig({ scoping: "global", datasetName: " team ", datasetNamePrefix: " prod " }),
					"/work/proj",
				),
			).toBe("prod-team");
		});

		it("uses dataset IDs as the only target when configured", () => {
			const scope = computeCogneeScope(
				baseConfig({ scoping: "global", datasetName: "team", datasetNamePrefix: "prod", datasetId: " ds-123 " }),
				"/work/proj",
			);

			expect(scope.label).toBe("global:id:ds-123");
			expect(scope.datasetId).toBe("ds-123");
			expect(scope.recallDatasetIds).toEqual(["ds-123"]);
			expect(scope.retainDatasetLabel).toBe("id:ds-123");
			expect(scope.recallDatasetLabels).toEqual(["id:ds-123"]);
			expect(scope.datasetName).toBeUndefined();
			expect(scope.recallDatasets).toBeUndefined();
		});
	});

	describe("deriveCogneeDatasetName", () => {
		it("derives names by scoping mode and ignores datasetId", () => {
			const config = { datasetName: " team ", datasetNamePrefix: " prod ", datasetId: "ignored" };

			expect(deriveCogneeDatasetName(baseConfig({ ...config, scoping: "global" }), "/work/proj")).toBe("prod-team");
			expect(deriveCogneeDatasetName(baseConfig({ ...config, scoping: "per-project" }), "/work/proj")).toBe(
				"prod-team-proj",
			);
			expect(deriveCogneeDatasetName(baseConfig({ ...config, scoping: "per-project-tagged" }), "/work/proj")).toBe(
				"prod-team",
			);
		});
	});

	describe("per-project", () => {
		it("falls back to the cwd basename outside a repo", () => {
			const scope = computeCogneeScope(baseConfig({ scoping: "per-project" }), "/work/cool-app");

			expect(scope.projectLabel).toBe("cool-app");
			expect(scope.label).toBe("project:cool-app");
			expect(scope.datasetName).toBe("omp-cool-app");
		});

		it("uses unknown for an empty cwd", () => {
			const scope = computeCogneeScope(baseConfig({ scoping: "per-project" }), "");

			expect(scope.projectLabel).toBe("unknown");
			expect(scope.datasetName).toBe("omp-unknown");
		});

		it("includes normalized static nodes without mutating input", () => {
			const nodeSet = [" team:infra ", "", "team:infra", " app:web "];
			const original = [...nodeSet];

			expect(computeCogneeScope(baseConfig({ scoping: "global", nodeSet }), "/work/proj").retainNodeSet).toEqual([
				"team:infra",
				"app:web",
			]);
			expect(
				computeCogneeScope(baseConfig({ scoping: "per-project", nodeSet }), "/work/proj").retainNodeSet,
			).toEqual(["team:infra", "app:web"]);
			expect(nodeSet).toEqual(original);
		});

		it("derives a project-specific ID target when datasetId is configured", () => {
			const scope = computeCogneeScope(
				baseConfig({ scoping: "per-project", datasetId: " ds-123 " }),
				"/work/cool-app",
			);

			expect(scope.label).toBe("project:cool-app");
			expect(scope.datasetId).toBe("ds-123-cool-app");
			expect(scope.recallDatasetIds).toEqual(["ds-123-cool-app"]);
			expect(scope.retainDatasetLabel).toBe("id:ds-123-cool-app");
			expect(scope.recallDatasetLabels).toEqual(["id:ds-123-cool-app"]);
			expect(scope.datasetName).toBeUndefined();
			expect(scope.recallDatasets).toBeUndefined();
			expect(scope.projectLabel).toBe("cool-app");
			expect(scope.projectNode).toBeUndefined();
		});
	});

	describe("per-project-tagged", () => {
		it("retains and recalls with the project node while targeting the shared dataset", () => {
			const scope = computeCogneeScope(
				baseConfig({ scoping: "per-project-tagged", nodeSet: ["team:infra"] }),
				"/repo/cool-app",
			);

			expect(scope.datasetName).toBe("omp");
			expect(scope.label).toBe("project-tagged:cool-app");
			expect(scope.projectLabel).toBe("cool-app");
			expect(scope.projectNode).toBe("project:cool-app");
			expect(scope.retainNodeSet).toEqual(["team:infra", "project:cool-app"]);
			expect(scope.recallNodeName).toEqual(["project:cool-app"]);
			expect(scope.recallDatasets).toEqual(["omp"]);
			expect(scope.recallDatasetIds).toBeUndefined();
		});

		it("does not append a duplicate project node", () => {
			const scope = computeCogneeScope(
				baseConfig({
					scoping: "per-project-tagged",
					nodeSet: ["team:infra", " project:cool-app ", "project:cool-app"],
				}),
				"/repo/cool-app",
			);

			expect(scope.retainNodeSet).toEqual(["team:infra", "project:cool-app"]);
		});

		it("uses dataset IDs with the project node recall filter", () => {
			const scope = computeCogneeScope(
				baseConfig({ scoping: "per-project-tagged", datasetId: " ds-123 " }),
				"/repo/cool-app",
			);

			expect(scope.label).toBe("project-tagged:cool-app");
			expect(scope.datasetId).toBe("ds-123");
			expect(scope.recallDatasetIds).toEqual(["ds-123"]);
			expect(scope.datasetName).toBeUndefined();
			expect(scope.recallDatasets).toBeUndefined();
			expect(scope.projectLabel).toBe("cool-app");
			expect(scope.projectNode).toBe("project:cool-app");
			expect(scope.retainNodeSet).toEqual(["project:cool-app"]);
			expect(scope.recallNodeName).toEqual(["project:cool-app"]);
		});
	});

	it("passes through only non-empty session IDs", () => {
		expect(computeCogneeScope(baseConfig({ scoping: "global" }), "/work/proj", " session-1 ").sessionId).toBe(
			"session-1",
		);
		expect(computeCogneeScope(baseConfig({ scoping: "global" }), "/work/proj").sessionId).toBeUndefined();
		expect(computeCogneeScope(baseConfig({ scoping: "global" }), "/work/proj", "").sessionId).toBeUndefined();
		expect(computeCogneeScope(baseConfig({ scoping: "global" }), "/work/proj", "   ").sessionId).toBeUndefined();
	});

	describe("git worktree handling", () => {
		let baseDir: string;
		let primaryRoot: string;
		let worktreeRoot: string;
		let bareRepoRoot: string;
		let bareWorktreeA: string;
		let bareWorktreeB: string;

		beforeAll(async () => {
			baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cognee-scope-worktree-"));
			primaryRoot = path.join(baseDir, "myrepo");
			worktreeRoot = path.join(baseDir, "myrepo-feature-x");
			await fs.mkdir(primaryRoot, { recursive: true });
			runGit(primaryRoot, ["-c", "init.defaultBranch=main", "init"]);
			runGit(primaryRoot, ["config", "user.email", "tester@example.com"]);
			runGit(primaryRoot, ["config", "user.name", "Tester"]);
			await fs.writeFile(path.join(primaryRoot, "README.md"), "hi\n");
			runGit(primaryRoot, ["add", "-A"]);
			runGit(primaryRoot, ["commit", "-m", "base"]);
			runGit(primaryRoot, ["worktree", "add", worktreeRoot, "-b", "feature-x"]);

			bareRepoRoot = path.join(baseDir, "bare-repo.git");
			bareWorktreeA = path.join(baseDir, "bare-a");
			bareWorktreeB = path.join(baseDir, "bare-b");
			runGit(baseDir, ["init", "--bare", bareRepoRoot]);
			runGit(primaryRoot, ["remote", "add", "bare", bareRepoRoot]);
			runGit(primaryRoot, ["push", "bare", "main"]);
			runGit(baseDir, ["--git-dir", bareRepoRoot, "worktree", "add", bareWorktreeA, "-b", "bare-a", "main"]);
			runGit(baseDir, ["--git-dir", bareRepoRoot, "worktree", "add", bareWorktreeB, "-b", "bare-b", "main"]);
		});

		afterAll(async () => {
			if (baseDir) await removeWithRetries(baseDir);
		});

		it("uses the same project label from a primary checkout and linked worktree", () => {
			const fromPrimary = computeCogneeScope(baseConfig({ scoping: "per-project-tagged" }), primaryRoot);
			const fromWorktree = computeCogneeScope(baseConfig({ scoping: "per-project-tagged" }), worktreeRoot);

			expect(fromPrimary.projectLabel).toBe("myrepo");
			expect(fromPrimary.projectNode).toBe("project:myrepo");
			expect(fromWorktree.projectLabel).toBe("myrepo");
			expect(fromWorktree.projectNode).toBe("project:myrepo");
			expect(fromWorktree).toEqual(fromPrimary);
		});

		it("uses the primary root basename for the per-project dataset suffix from a worktree", () => {
			const scope = computeCogneeScope(baseConfig({ scoping: "per-project" }), worktreeRoot);

			expect(scope.projectLabel).toBe("myrepo");
			expect(scope.label).toBe("project:myrepo");
			expect(scope.datasetName).toBe("omp-myrepo");
		});

		it("uses one shared label across worktrees attached to a bare repository", () => {
			const fromA = computeCogneeScope(baseConfig({ scoping: "per-project-tagged" }), bareWorktreeA);
			const fromB = computeCogneeScope(baseConfig({ scoping: "per-project-tagged" }), bareWorktreeB);

			expect(fromA.projectLabel).toBe("bare-repo.git");
			expect(fromA.projectNode).toBe("project:bare-repo.git");
			expect(fromB).toEqual(fromA);
			expect(computeCogneeScope(baseConfig({ scoping: "per-project" }), bareWorktreeB).datasetName).toBe(
				"omp-bare-repo.git",
			);
		});

		it("falls back to the cwd basename outside any repository", () => {
			const scope = computeCogneeScope(baseConfig({ scoping: "per-project-tagged" }), baseDir);

			expect(scope.projectLabel).toBe(path.basename(baseDir));
			expect(scope.projectNode).toBe(`project:${path.basename(baseDir)}`);
		});
	});
});
