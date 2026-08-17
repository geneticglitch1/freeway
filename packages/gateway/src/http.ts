/** Thin helpers over node:http. No framework, no middleware stack. */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Req = IncomingMessage;
export type Res = ServerResponse;

export interface BodyResult {
  ok: boolean;
  raw: string;
  /** Set when the body exceeded the cap or was not valid JSON. */
  error: string | null;
  tooLarge: boolean;
}

/**
 * Read a request body with a hard ceiling.
 *
 * The cap is enforced while reading rather than after, so a client cannot
 * exhaust memory by streaming gigabytes at a gateway that only checks the size
 * once the whole thing has arrived.
 */
export function readBody(req: Req, maxBytes: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const finish = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Pause rather than destroy: killing the socket here would take the 413
        // response down with it, and the caller would see a connection reset
        // instead of being told what was wrong. The caller closes the socket
        // once the response has flushed.
        req.pause();
        finish({ ok: false, raw: '', error: `request body exceeds ${maxBytes} bytes`, tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, raw: Buffer.concat(chunks).toString('utf8'), error: null, tooLarge: false }));
    req.on('error', (err) => finish({ ok: false, raw: '', error: err.message, tooLarge: false }));
  });
}

export function sendJson(res: Res, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    ...headers,
  });
  res.end(payload);
}

export function sendText(res: Res, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

export interface ApiError {
  message: string;
  type: string;
  code: string | null;
}

/** OpenAI-shaped error envelope, plus a `freeway` block for our own diagnostics. */
export function sendError(
  res: Res,
  status: number,
  error: ApiError,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { error, ...(Object.keys(extra).length > 0 ? { freeway: extra } : {}) }, headers);
}

export function clientIp(req: Req): string {
  // Trusting XFF blindly lets a client spoof its own identity, so only the
  // socket address is authoritative unless the operator puts a proxy in front.
  return req.socket.remoteAddress ?? 'unknown';
}

export function bearerToken(req: Req): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1].trim();
  }
  const alt = req.headers['x-api-key'];
  if (typeof alt === 'string' && alt.trim()) return alt.trim();
  return null;
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1';
}

/**
 * Constant-time comparison of two secrets.
 *
 * `timingSafeEqual` needs equal-length buffers, and returning early on a length
 * mismatch would leak the key's length. Hashing both sides first gives fixed
 * width regardless of input, so neither length nor content is observable.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
