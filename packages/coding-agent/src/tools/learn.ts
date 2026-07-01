import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import { sanitizeSkillName, writeManagedSkill } from "../autolearn/managed-skills";
import { isNameClaimedByAuthoredSkill } from "../extensibility/skills";
import { localBackend } from "../memory-backend/local-backend";
import learnDescription from "../prompts/tools/learn.md" with { type: "text" };
import type { ToolSession } from ".";
import { resolveMemoryToolOps } from "./memory-ops";

const learnSchema = type({
	memory: type("string").describe("the durable, self-contained lesson to remember (what, when, why)"),
	"context?": type("string").describe("optional source context for the lesson"),
	"skill?": type({
		action: "'create' | 'update'",
		name: type("string").describe("kebab-case skill name"),
		description: type("string").describe("one-line description of when to use the skill"),
		body: type("string").describe("the SKILL.md body in markdown (no frontmatter)"),
	}).describe("also create or enhance a managed skill in the same call"),
});

export type LearnParams = typeof learnSchema.infer;

/**
 * Orchestrating "learn" tool: persists a lesson to long-term memory and,
 * given a `skill` payload, mints/enhances a managed skill via the shared
 * `writeManagedSkill` primitive. Gated behind `autolearn.enabled`; `hindsight`,
 * `mnemopi`, and `cognee` use MemoryToolOps, while `local` uses `localBackend.save`
 * for the file-based `learned.md` compatibility path.
 */
export class LearnTool implements AgentTool<typeof learnSchema> {
	readonly name = "learn";
	readonly approval = (args: unknown) => {
		const params = args as Partial<LearnParams>;
		return params.skill || this.session.settings.get("memory.backend") === "local" ? "write" : "read";
	};
	readonly label = "Learn";
	readonly description = learnDescription;
	readonly parameters = learnSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Capture a reusable lesson to memory (and optionally a managed skill)";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): LearnTool | null {
		if (!session.settings.get("autolearn.enabled")) return null;
		const backend = session.settings.get("memory.backend");
		if (backend === "local" || resolveMemoryToolOps(session)) return new LearnTool(session);
		return null;
	}

	async execute(_id: string, params: LearnParams): Promise<AgentToolResult> {
		// 1) Persist or queue the lesson to long-term memory.
		const backend = this.session.settings.get("memory.backend");
		let memoryMessage: string;
		if (backend === "local") {
			const result = await localBackend.save?.(
				{ agentDir: this.session.settings.getAgentDir(), cwd: this.session.settings.getCwd() },
				{ content: params.memory, context: params.context, source: "coding-agent-learn", importance: 0.8 },
			);
			if (!result || result.stored === 0) {
				throw new Error("Lesson was empty after sanitization; nothing stored.");
			}
			memoryMessage = "Lesson stored";
		} else {
			const ops = resolveMemoryToolOps(this.session);
			if (!ops?.save) throw new Error("No active memory backend supports learn.");
			const result = await ops.save({
				content: params.memory,
				context: params.context,
				source: "coding-agent-learn",
				importance: 0.8,
			});
			const firstText = result.content.find(item => item.type === "text")?.text;
			if (!firstText) throw new Error("Memory backend did not return a learn result.");
			memoryMessage = firstText;
		}

		// 2) Optionally mint/enhance a managed skill. A failure here is surfaced
		// as a partial outcome — the lesson is already stored or queued.
		if (params.skill) {
			// A managed skill resolves below any authored skill of the same name, so
			// minting one under a claimed name writes a file that never surfaces. The
			// lesson is already stored/queued; refuse the skill rather than report a
			// false "Created" (mirrors ManageSkillTool).
			let safeSkillName: string | undefined;
			try {
				safeSkillName = sanitizeSkillName(params.skill.name);
			} catch {
				safeSkillName = undefined;
			}
			if (params.skill.action === "create" && safeSkillName && isNameClaimedByAuthoredSkill(safeSkillName)) {
				return {
					content: [
						{
							type: "text",
							text: `${memoryMessage}. Did not create managed skill "${params.skill.name}": an authored skill of that name already exists, and managed skills cannot override authored ones. Choose a different name.`,
						},
					],
					isError: true,
					details: { skill: null, shadowed: true },
				};
			}
			try {
				await writeManagedSkill(params.skill);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				throw new Error(`${memoryMessage}, but the managed skill could not be written: ${reason}`);
			}
			const verb = params.skill.action === "create" ? "Created" : "Updated";
			return {
				content: [{ type: "text", text: `${memoryMessage}. ${verb} managed skill "${params.skill.name}".` }],
				details: { skill: params.skill.name },
			};
		}

		return {
			content: [{ type: "text", text: `${memoryMessage}.` }],
			details: { skill: null },
		};
	}
}
