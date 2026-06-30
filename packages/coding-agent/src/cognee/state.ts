/**
 * Cognee session state side channel.
 *
 * TEMPORARY local structural helper for the `CogneeSessionPropagation`
 * workpackage. The dedicated `CogneeSessionState` workpackage owns the full
 * implementation (real Cognee client wiring, alias state, listeners, retain
 * queue, first-turn recall). Until that sibling lands and is integrated, this
 * file provides the frozen side-channel API — `CogneeSessionStateLike`,
 * `getCogneeSessionState`, and `setCogneeSessionState` — backed by a single
 * module-level `WeakMap`, so `AgentSession`, `sdk.ts`, task/eval propagation,
 * and focused tests can consume the frozen names with no import-path
 * divergence. On integration the sibling's `cognee/state.ts` supersedes this
 * file; the exported names are identical so consumers require no changes.
 *
 * Storage is singular: exactly this `WeakMap` holds Cognee state per
 * `AgentSession`. `AgentSession` exposes only a getter and delegates here; it
 * does not keep a private Cognee state field or a parallel cache.
 */
import type { AgentSession } from "../session/agent-session";

export interface CogneeSessionStateLike {
	readonly sessionId: string;
	readonly aliasOf?: CogneeSessionStateLike;
	readonly lastRecallSnippet?: string;
	readonly lastRetainedAtIso?: string;
	readonly lastRetainedTurn: number;
	readonly hasRecalledForFirstTurn: boolean;

	setSessionId(sessionId: string): void;
	resetConversationTracking(): void;
	enqueueRetain(content: string, context?: string): void;
	flushRetainQueue(): Promise<void>;
	beforeAgentStartPrompt(promptText: string): Promise<string | undefined>;
	dispose(): void | Promise<void>;
}

const cogneeSessionStates = new WeakMap<AgentSession, CogneeSessionStateLike>();

/**
 * Returns the Cognee state currently registered for `session`, or `undefined`.
 * Does not create state. May return either a primary or an alias state; callers
 * that need the primary must unwrap `aliasOf` intentionally.
 */
export function getCogneeSessionState(
	session: AgentSession | undefined,
): CogneeSessionStateLike | undefined {
	return session ? cogneeSessionStates.get(session) : undefined;
}

/**
 * Registers `state` (or clears it when `undefined`) for `session` in the side
 * channel and returns the previously registered state, if any. Mirrors the
 * `setMnemopiSessionState` / `setHindsightSessionState` storage style so
 * Cognee state has exactly one source of truth.
 */
export function setCogneeSessionState(
	session: AgentSession,
	state: CogneeSessionStateLike | undefined,
): CogneeSessionStateLike | undefined {
	const previous = cogneeSessionStates.get(session);
	if (state === undefined) {
		cogneeSessionStates.delete(session);
	} else {
		cogneeSessionStates.set(session, state);
	}
	return previous;
}
