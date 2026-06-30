import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import retainDescription from "../prompts/tools/retain.md" with { type: "text" };
import { resolveMemoryToolOps } from "./memory-ops";
import type { ToolSession } from ".";

const memoryRetainSchema = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

export type MemoryRetainParams = typeof memoryRetainSchema.infer;
export class MemoryRetainTool implements AgentTool<typeof memoryRetainSchema> {
	readonly name = "retain";
	readonly approval = "read" as const;
	readonly label = "Retain";
	readonly description = retainDescription;
	readonly parameters = memoryRetainSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Store important facts in long-term memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRetainTool | null {
		return resolveMemoryToolOps(session) ? new MemoryRetainTool(session) : null;
	}

	async execute(_id: string, params: MemoryRetainParams): Promise<AgentToolResult> {
		const ops = resolveMemoryToolOps(this.session);
		if (!ops) throw new Error("No active memory backend supports retain.");
		return ops.retain(params.items);
	}
}
