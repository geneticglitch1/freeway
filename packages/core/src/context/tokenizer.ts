/**
 * Token estimation that gets less wrong the more you use it.
 *
 * There is no tokenizer here — shipping tiktoken would break the zero-dependency
 * rule, and there is no single correct tokenizer across a dozen providers
 * anyway. Instead: start at the usual `chars/4`, then compare every estimate
 * against the `prompt_tokens` the provider actually reported and learn a
 * per-model correction factor.
 *
 * The estimate is honest about being an estimate — the ratio and its sample
 * count are exposed so the dashboard can show how much to trust it.
 */

export interface Ratio {
  model: string;
  /** Multiplier applied to the chars/4 baseline. 1.0 means the baseline is right. */
  factor: number;
  samples: number;
  updatedAt: number;
}

export interface TokenizerSnapshot {
  version: number;
  ratios: Record<string, { factor: number; samples: number; updatedAt: number }>;
}

const VERSION = 1;
const BASE_CHARS_PER_TOKEN = 4;
/** Ignore absurd corrections; a factor outside this is a bug or a bad report. */
const MIN_FACTOR = 0.4;
const MAX_FACTOR = 3.0;

export class Tokenizer {
  private readonly ratios = new Map<string, Ratio>();

  /** Baseline estimate, before any learned correction. */
  static baseline(text: string): number {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / BASE_CHARS_PER_TOKEN));
  }

  estimate(text: string, model?: string): number {
    const base = Tokenizer.baseline(text);
    if (!model) return base;
    const ratio = this.ratios.get(model);
    return ratio ? Math.max(1, Math.round(base * ratio.factor)) : base;
  }

  estimateMessages(messages: { role?: string; content?: unknown }[], model?: string): number {
    let total = 0;
    for (const m of messages) {
      total += this.estimate(textOf(m.content), model);
      // Per-message framing overhead: role, delimiters, and the wrapper every
      // chat format adds. Roughly 4 tokens in the OpenAI formats.
      total += 4;
    }
    return total;
  }

  /**
   * Feed a real `prompt_tokens` back in alongside the text it counted.
   *
   * Converges with an EWMA rather than jumping, because a single request with
   * an unusual payload (a base64 image, a wall of CJK) is not evidence that the
   * model's whole ratio has changed.
   */
  learn(model: string, text: string, reportedTokens: number, now = Date.now()): void {
    if (!model || reportedTokens <= 0) return;
    const base = Tokenizer.baseline(text);
    if (base <= 0) return;

    const observed = reportedTokens / base;
    if (!Number.isFinite(observed) || observed < MIN_FACTOR || observed > MAX_FACTOR) return;

    const existing = this.ratios.get(model);
    if (!existing) {
      this.ratios.set(model, { model, factor: observed, samples: 1, updatedAt: now });
      return;
    }
    // Settle faster while there is little evidence, slower once confident.
    const alpha = Math.max(0.05, 1 / (existing.samples + 1));
    const factor = existing.factor + alpha * (observed - existing.factor);
    this.ratios.set(model, {
      model,
      factor: Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, factor)),
      samples: existing.samples + 1,
      updatedAt: now,
    });
  }

  ratio(model: string): Ratio | undefined {
    return this.ratios.get(model);
  }

  all(): Ratio[] {
    return [...this.ratios.values()].sort((a, b) => b.samples - a.samples);
  }

  snapshot(): TokenizerSnapshot {
    const ratios: TokenizerSnapshot['ratios'] = {};
    for (const [model, r] of this.ratios) ratios[model] = { factor: r.factor, samples: r.samples, updatedAt: r.updatedAt };
    return { version: VERSION, ratios };
  }

  restore(snap: TokenizerSnapshot | undefined): void {
    if (!snap || snap.version !== VERSION) return;
    for (const [model, r] of Object.entries(snap.ratios ?? {})) {
      if (typeof r?.factor !== 'number') continue;
      this.ratios.set(model, {
        model,
        factor: Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, r.factor)),
        samples: typeof r.samples === 'number' ? r.samples : 1,
        updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
      });
    }
  }
}

/** Flatten a message's content, including multi-part vision payloads. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (typeof part !== 'object' || part === null) continue;
    const p = part as Record<string, unknown>;
    if (typeof p['text'] === 'string') parts.push(p['text']);
    // An image contributes tokens but not characters; charging a flat estimate
    // is far closer than counting the data URI's length as text.
    else if (p['type'] === 'image_url' || p['type'] === 'image') parts.push(' '.repeat(4 * 800));
  }
  return parts.join('\n');
}
