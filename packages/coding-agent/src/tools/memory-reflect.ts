import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import reflectDescription from "../prompts/tools/reflect.md" with { type: "text" };
import { resolveMemoryToolOps } from "./memory-ops";
import type { ToolSession } from ".";

const memoryReflectSchema = type({
	query: type("string").describe("question to answer"),
	"context?": type("string").describe("optional context"),
});

export type MemoryReflectParams = typeof memoryReflectSchema.infer;

export class MemoryReflectTool implements AgentTool<typeof memoryReflectSchema> {
	readonly name = "reflect";
	readonly approval = "read" as const;
	readonly label = "Reflect";
	readonly description = reflectDescription;
	readonly parameters = memoryReflectSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Synthesize an answer from long-term memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryReflectTool | null {
		return resolveMemoryToolOps(session)?.supportsReflect === true ? new MemoryReflectTool(session) : null;
	}

	async execute(_id: string, params: MemoryReflectParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const ops = resolveMemoryToolOps(this.session);
			if (!ops?.supportsReflect) throw new Error("No active memory backend supports reflect.");
			return ops.reflect(params.query, params.context, signal);
		});
	}
}
