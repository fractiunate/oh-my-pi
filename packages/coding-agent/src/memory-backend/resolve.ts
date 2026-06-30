import type { Settings } from "../config/settings";
import { localBackend } from "./local-backend";
import { offBackend } from "./off-backend";
import type { MemoryBackend } from "./types";

/**
 * Pick the active memory backend for a Settings instance.
 *
 * Selection rules (single source of truth — every memory consumer routes
 * through this):
 *   - `memory.backend === "hindsight"`  → Hindsight remote memory
 *   - `memory.backend === "mnemopi"`    → local Mnemopi SQLite memory
 *   - `memory.backend === "cognee"`     → Cognee graph/session memory backend
 *   - `memory.backend === "local"`      → local rollout summary pipeline
 *   - everything else                   → no-op
 *
 * `memories.enabled` remains accepted only as a legacy migration input. Once
 * a config is loaded, `memory.backend` is the sole runtime selector.
 *
 * Backend modules are lazy-imported so an unused backend's state/client
 * dependencies are never loaded into a process that won't use them — a
 * static import would pull every backend into every consumer's bundle.
 */
export async function resolveMemoryBackend(settings: Settings): Promise<MemoryBackend> {
	const id = settings.get("memory.backend");
	if (id === "hindsight") return (await import("../hindsight/backend")).hindsightBackend;
	if (id === "mnemopi") return (await import("../mnemopi/backend")).mnemopiBackend;
	if (id === "cognee") return (await import("../cognee/backend")).cogneeBackend;
	if (id === "local") return localBackend;
	return offBackend;
}
