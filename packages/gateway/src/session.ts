/**
 * Session hydration: turn `{ session, messages: [newMessage] }` into the full
 * conversation, and persist the reply afterwards.
 *
 * The `session` field is a Freeway extension and is stripped before anything is
 * forwarded upstream — no provider knows about it.
 */

import { ContextStore, Tokenizer, textOf, type RefitMessage } from '@freeway/core';

export interface SessionContext {
  id: string;
  /** Sequence number of the last message that existed before this request. */
  baseSeq: number;
  /** How many stored turns were rehydrated. */
  restored: number;
}

export interface HydrateResult {
  messages: RefitMessage[];
  session: SessionContext | null;
}

/**
 * Merge stored history with what the client just sent.
 *
 * Clients are allowed to send the whole array as usual — in that case the
 * stored history is ignored for anything they re-sent, so a session id is
 * additive rather than a different protocol.
 */
export class SessionForbiddenError extends Error {
  constructor(sessionId: string) {
    super(`session "${sessionId}" belongs to a different key`);
    this.name = 'SessionForbiddenError';
  }
}

export function hydrate(
  store: ContextStore,
  sessionId: string | null,
  incoming: RefitMessage[],
  tokenizer: Tokenizer,
  model?: string,
  owner: string | null = null,
): HydrateResult {
  if (!sessionId) return { messages: incoming, session: null };

  // Session ids are caller-chosen strings. Without this check, "proj-42" is
  // readable by anyone who guesses it.
  if (!store.canAccess(sessionId, owner)) throw new SessionForbiddenError(sessionId);

  const stored = store.messages(sessionId);
  const baseSeq = stored.length > 0 ? (stored[stored.length - 1]?.seq ?? -1) : -1;

  if (stored.length === 0) {
    // First turn of a new session: everything the client sent is the history.
    store.append(
      sessionId,
      incoming.map((m) => ({
        role: m.role,
        content: textOf(m.content),
        extra: extraOf(m),
        tokens: tokenizer.estimate(textOf(m.content), model),
      })),
      Date.now(),
      owner,
    );
    return { messages: incoming, session: { id: sessionId, baseSeq: -1, restored: 0 } };
  }

  const history: RefitMessage[] = stored.map((m) => {
    const extra = m.extra ? (JSON.parse(m.extra) as Record<string, unknown>) : {};
    return { role: m.role, content: m.content, ...extra };
  });

  // Only messages the client did not already replay get appended, so a client
  // that keeps its own copy and one that relies on the server both work.
  const known = new Set(history.map(fingerprint));
  const fresh = incoming.filter((m) => !known.has(fingerprint(m)));

  if (fresh.length > 0) {
    store.append(
      sessionId,
      fresh.map((m) => ({
        role: m.role,
        content: textOf(m.content),
        extra: extraOf(m),
        tokens: tokenizer.estimate(textOf(m.content), model),
      })),
      Date.now(),
      owner,
    );
  }

  return {
    messages: [...history, ...fresh],
    session: { id: sessionId, baseSeq, restored: history.length },
  };
}

/** Persist the assistant's reply so the next turn sees it. */
export function recordReply(store: ContextStore, sessionId: string, content: string, tokens: number): void {
  if (!content) return;
  store.append(sessionId, [{ role: 'assistant', content, extra: null, tokens }]);
}

function extraOf(m: RefitMessage): string | null {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === 'role' || k === 'content') continue;
    extra[k] = v;
  }
  return Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
}

/** Cheap identity for dedupe. Content is bounded so a huge message stays cheap. */
function fingerprint(m: RefitMessage): string {
  return `${m.role}:${textOf(m.content).slice(0, 200)}`;
}
