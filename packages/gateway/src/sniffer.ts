/**
 * A pass-through Transform that watches an SSE stream go by and picks the
 * `usage` block out of it.
 *
 * Providers only report token usage in the final chunk of a stream, so this is
 * the only place the real numbers can be captured. Bytes are forwarded
 * unmodified — the client receives exactly what the provider sent.
 */

import { Transform, type TransformCallback } from 'node:stream';

export interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** Guard against a provider that never sends a newline filling memory. */
const MAX_PARTIAL_LINE = 256 * 1024;

export class UsageSniffer extends Transform {
  usage: StreamUsage | null = null;
  /** Accumulated assistant text, for estimating when no usage is reported. */
  text = '';

  private partial = '';

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    // Forward first and unchanged: inspection must never alter what the client
    // receives, and must never delay it either.
    this.push(chunk);

    this.partial += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (this.partial.length > MAX_PARTIAL_LINE) {
      // Not a real SSE stream, or a pathologically long line. Stop accumulating
      // rather than growing without bound; pass-through is unaffected.
      this.partial = '';
      callback();
      return;
    }

    const lines = this.partial.split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) this.inspect(line);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (this.partial) this.inspect(this.partial);
    this.partial = '';
    callback();
  }

  private inspect(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    // Parsing every chunk would be wasteful; only chunks that could carry the
    // fields we want are worth the JSON.parse.
    const hasUsage = payload.includes('"usage"');
    const hasContent = payload.includes('"content"');
    if (!hasUsage && !hasContent) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;

    const usage = (parsed as { usage?: unknown }).usage;
    if (typeof usage === 'object' && usage !== null) {
      const u = usage as Record<string, unknown>;
      this.usage = {
        ...(typeof u['prompt_tokens'] === 'number' ? { prompt_tokens: u['prompt_tokens'] } : {}),
        ...(typeof u['completion_tokens'] === 'number' ? { completion_tokens: u['completion_tokens'] } : {}),
        ...(typeof u['total_tokens'] === 'number' ? { total_tokens: u['total_tokens'] } : {}),
      };
    }

    const choices = (parsed as { choices?: unknown }).choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        const delta = (choice as { delta?: { content?: unknown } } | null)?.delta;
        if (typeof delta?.content === 'string') this.text += delta.content;
      }
    }
  }
}
