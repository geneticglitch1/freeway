/**
 * Make a conversation fit a model's context window.
 *
 * This is what lets a thread keep working when its provider runs out of quota
 * and the request fails over to a model with a sixteenth of the window. The
 * ladder escalates only as far as it has to, because every rung loses something:
 *
 *   1. passthrough      it already fits; do nothing
 *   2. drop-tool-noise  clear stale tool results, leaving a marker      (free)
 *   3. window           keep the system message, the first user turn,
 *                       and the last N turns verbatim                   (free)
 *   4. compact          summarise the dropped middle with a cheap model (an LLM call)
 *   5. hard-truncate    deterministic character-level cut               (always terminates)
 *
 * Rung 5 exists because rung 4 can fail: summarisation under length pressure is
 * a documented failure mode, and a model asked to compress can return something
 * *longer* than its input. When that happens the summary is discarded and the
 * ladder escalates rather than looping.
 */

import { Tokenizer, textOf } from './tokenizer.ts';

export type RefitStrategy = 'passthrough' | 'drop-tool-noise' | 'window' | 'compact' | 'hard-truncate';

export interface RefitMessage {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
  [key: string]: unknown;
}

export interface RefitOptions {
  /** The target model's context window. */
  contextWindow: number;
  /** Held back for the model's own reply. */
  reserveOutputTokens: number;
  /** Turns kept verbatim at the tail before compaction considers them. */
  maxTurns: number;
  model?: string;
  tokenizer?: Tokenizer;
  /**
   * Produces a summary of the dropped middle. Omit it and the ladder skips
   * rung 4 and goes straight to deterministic truncation.
   */
  summarize?: (messages: RefitMessage[], budgetTokens: number) => Promise<string | null>;
}

export interface RefitResult {
  messages: RefitMessage[];
  strategy: RefitStrategy;
  tokensBefore: number;
  tokensAfter: number;
  /** Verbatim messages retained. */
  kept: number;
  dropped: number;
  summaries: number;
  /** Set when the input cannot be made to fit at all. */
  error: string | null;
  /** Rungs attempted, for the `x-freeway-context` header. */
  trail: RefitStrategy[];
}

const TOOL_CLEARED = '[tool result cleared to fit the context window]';

export class ContextTooLargeError extends Error {
  readonly required: number;
  readonly available: number;

  constructor(required: number, available: number) {
    super(`the latest message alone needs ~${required} tokens but only ${available} are available in this model's context window`);
    this.name = 'ContextTooLargeError';
    this.required = required;
    this.available = available;
  }
}

/**
 * Never split a tool call from its result.
 *
 * An assistant message with `tool_calls` and the `tool` messages answering it
 * are one indivisible unit; sending half of it makes most providers 400. Groups
 * are the atom the ladder actually moves around.
 */
interface Group {
  messages: RefitMessage[];
  startIndex: number;
  tokens: number;
}

function groupMessages(messages: RefitMessage[], tk: Tokenizer, model?: string): Group[] {
  const groups: Group[] = [];
  let i = 0;

  while (i < messages.length) {
    const start = i;
    const batch: RefitMessage[] = [];
    const current = messages[i];
    if (!current) break;

    batch.push(current);
    i += 1;

    const hasToolCalls = Array.isArray(current.tool_calls) && current.tool_calls.length > 0;
    if (hasToolCalls) {
      // Absorb every tool reply that belongs to this assistant turn.
      while (i < messages.length && messages[i]?.role === 'tool') {
        const next = messages[i];
        if (next) batch.push(next);
        i += 1;
      }
    }

    groups.push({ messages: batch, startIndex: start, tokens: tk.estimateMessages(batch, model) });
  }
  return groups;
}

function totalTokens(messages: RefitMessage[], tk: Tokenizer, model?: string): number {
  return tk.estimateMessages(messages, model);
}

export async function refit(input: RefitMessage[], options: RefitOptions): Promise<RefitResult> {
  const tk = options.tokenizer ?? new Tokenizer();
  const model = options.model;
  const budget = Math.max(256, options.contextWindow - options.reserveOutputTokens);
  const trail: RefitStrategy[] = [];

  const tokensBefore = totalTokens(input, tk, model);

  const base = (strategy: RefitStrategy, messages: RefitMessage[], kept: number, dropped: number, summaries: number): RefitResult => ({
    messages,
    strategy,
    tokensBefore,
    tokensAfter: totalTokens(messages, tk, model),
    kept,
    dropped,
    summaries,
    error: null,
    trail: [...trail],
  });

  // ---- 1. passthrough ------------------------------------------------------
  trail.push('passthrough');
  if (tokensBefore <= budget) return base('passthrough', input, input.length, 0, 0);

  const system = input.filter((m) => m.role === 'system');
  const rest = input.filter((m) => m.role !== 'system');
  const systemTokens = tk.estimateMessages(system, model);

  // The newest user turn is the request itself. If it cannot fit even alone,
  // no amount of history trimming helps — say so rather than mangling it.
  const lastUser = [...rest].reverse().find((m) => m.role === 'user');
  if (lastUser) {
    const lastTokens = tk.estimateMessages([lastUser], model);
    if (systemTokens + lastTokens > budget) {
      throw new ContextTooLargeError(systemTokens + lastTokens, budget);
    }
  }

  // ---- 2. drop tool noise --------------------------------------------------
  trail.push('drop-tool-noise');
  const cleared = clearOldToolResults(rest, tk, model, budget - systemTokens);
  if (cleared.changed) {
    const candidate = [...system, ...cleared.messages];
    if (totalTokens(candidate, tk, model) <= budget) {
      return base('drop-tool-noise', candidate, candidate.length, 0, 0);
    }
  }
  const working = cleared.changed ? cleared.messages : rest;

  // ---- 3. window -----------------------------------------------------------
  trail.push('window');
  const groups = groupMessages(working, tk, model);
  const anchor = groups[0] && groups[0].messages[0]?.role === 'user' ? groups[0] : null;
  const anchorTokens = anchor ? anchor.tokens : 0;

  const tail: Group[] = [];
  let tailTokens = 0;
  const startFrom = anchor ? 1 : 0;

  for (let i = groups.length - 1; i >= startFrom; i--) {
    const g = groups[i];
    if (!g) continue;
    if (tail.length >= options.maxTurns) break;
    if (systemTokens + anchorTokens + tailTokens + g.tokens > budget) break;
    tail.unshift(g);
    tailTokens += g.tokens;
  }

  const droppedGroups = groups.slice(startFrom, groups.length - tail.length);
  const keptMessages = [...(anchor ? anchor.messages : []), ...tail.flatMap((g) => g.messages)];
  const windowed = [...system, ...keptMessages];

  if (droppedGroups.length === 0 && totalTokens(windowed, tk, model) <= budget) {
    return base('window', windowed, windowed.length, 0, 0);
  }

  // ---- 4. compact ----------------------------------------------------------
  if (options.summarize && droppedGroups.length > 0) {
    trail.push('compact');
    const droppedMessages = droppedGroups.flatMap((g) => g.messages);
    const droppedTokens = tk.estimateMessages(droppedMessages, model);
    const summaryBudget = Math.max(128, Math.min(1024, Math.floor((budget - systemTokens - anchorTokens - tailTokens) * 0.8)));

    if (summaryBudget > 0) {
      const summary = await options.summarize(droppedMessages, summaryBudget);
      if (summary && summary.trim()) {
        const summaryTokens = tk.estimate(summary, model);
        // A "summary" longer than what it replaced is a known failure mode. It
        // is not an error — it just means this rung did not help, so escalate.
        if (summaryTokens < droppedTokens) {
          const candidate: RefitMessage[] = [
            ...system,
            { role: 'system', content: `Summary of the earlier conversation:\n${summary}` },
            ...keptMessages,
          ];
          if (totalTokens(candidate, tk, model) <= budget) {
            return base('compact', candidate, keptMessages.length, droppedMessages.length, 1);
          }
        }
      }
    }
  }

  // ---- 5. hard truncate ----------------------------------------------------
  // Deterministic, no model involved, guaranteed to terminate. Whatever else
  // failed, the request still goes out.
  trail.push('hard-truncate');
  const truncated = hardTruncate([...system, ...keptMessages], budget, tk, model);
  return {
    ...base('hard-truncate', truncated, truncated.length, input.length - truncated.length, 0),
    strategy: 'hard-truncate',
  };
}

/**
 * Replace the content of tool results that are no longer the most recent.
 *
 * Old tool output — a file that was read, a search that was run — has usually
 * already been absorbed into the assistant's later reasoning, so it is the
 * cheapest thing in a context to give up. Anthropic's `clear_tool_uses` takes
 * the same approach.
 */
function clearOldToolResults(
  messages: RefitMessage[],
  tk: Tokenizer,
  model: string | undefined,
  budget: number,
): { messages: RefitMessage[]; changed: boolean } {
  const out = messages.map((m) => ({ ...m }));
  let changed = false;
  let running = tk.estimateMessages(out, model);

  // Oldest first: the most recent tool results are the ones still in play.
  for (let i = 0; i < out.length && running > budget; i++) {
    const m = out[i];
    if (!m || m.role !== 'tool') continue;
    const text = textOf(m.content);
    if (text.length <= TOOL_CLEARED.length) continue;

    const before = tk.estimate(text, model);
    m.content = TOOL_CLEARED;
    running -= before - tk.estimate(TOOL_CLEARED, model);
    changed = true;
  }
  return { messages: out, changed };
}

/** Character-level trim from the oldest non-system message forward. */
function hardTruncate(messages: RefitMessage[], budget: number, tk: Tokenizer, model?: string): RefitMessage[] {
  const out = messages.map((m) => ({ ...m }));

  // Drop whole messages first, oldest non-system, never the last one.
  while (out.length > 1 && totalTokens(out, tk, model) > budget) {
    const idx = out.findIndex((m, i) => m.role !== 'system' && i < out.length - 1);
    if (idx === -1) break;
    out.splice(idx, 1);
  }

  // Still over: cut the surviving text down by characters.
  if (totalTokens(out, tk, model) > budget) {
    for (let i = 0; i < out.length && totalTokens(out, tk, model) > budget; i++) {
      const m = out[i];
      if (!m) continue;
      const text = textOf(m.content);
      if (text.length < 200) continue;
      const over = totalTokens(out, tk, model) - budget;
      const cut = Math.min(text.length - 100, over * 4 + 100);
      m.content = `${text.slice(0, Math.max(100, text.length - cut))}\n…[truncated]`;
    }
  }
  return out;
}

/**
 * One-line summary of what happened, for the `x-freeway-context` header.
 *
 * ASCII only — a header value must be latin-1, and a Unicode arrow here makes
 * `writeHead` throw ERR_INVALID_CHAR on every refitted request.
 */
export function describeRefit(result: RefitResult): string {
  const parts = [`refit=${result.strategy}`, `tokens=${result.tokensBefore}->${result.tokensAfter}`, `kept=${result.kept}`];
  if (result.dropped > 0) parts.push(`dropped=${result.dropped}`);
  if (result.summaries > 0) parts.push(`summaries=${result.summaries}`);
  return parts.join(' ');
}
