/**
 * Server-side conversation storage, backed by `node:sqlite`.
 *
 * A client sends a session id and only the new message; the gateway rebuilds
 * the thread. That is what makes it possible to move a live conversation from a
 * 128k model to an 8k one when the first runs out of quota — the history lives
 * here rather than in the client's request body.
 *
 * sqlite rather than JSON because this grows without bound and needs range
 * queries; it is built into Node, so the zero-dependency rule still holds.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface StoredMessage {
  seq: number;
  role: string;
  content: string;
  /** Non-content fields (tool_calls, name, tool_call_id) preserved verbatim. */
  extra: string | null;
  tokens: number;
  createdAt: number;
}

export interface StoredSummary {
  id: number;
  fromSeq: number;
  toSeq: number;
  content: string;
  tokens: number;
  model: string;
  createdAt: number;
}

export interface SessionInfo {
  id: string;
  /** Masked key that owns it, or null when unclaimed. */
  owner: string | null;
  createdAt: number;
  updatedAt: number;
  messages: number;
  tokens: number;
  summaries: number;
}

export class ContextStore {
  private readonly db: DatabaseSync;
  private readonly stmts: {
    insertMessage: StatementSync;
    listMessages: StatementSync;
    touchSession: StatementSync;
    insertSession: StatementSync;
    ownerOf: StatementSync;
    insertSummary: StatementSync;
    findSummary: StatementSync;
    listSummaries: StatementSync;
    deleteSession: StatementSync;
    deleteMessages: StatementSync;
    deleteSummaries: StatementSync;
    maxSeq: StatementSync;
    sessions: StatementSync;
    session: StatementSync;
  };

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // Conversation history is as sensitive as anything the gateway holds; the
    // default umask would leave it readable by every user on the box.
    if (file !== ':memory:') {
      try {
        chmodSync(file, 0o600);
      } catch {
        /* a filesystem without POSIX modes; nothing to tighten */
      }
    }

    // WAL keeps a long-running gateway's writes from blocking dashboard reads.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        -- Masked identity of the key that created the session. Session ids are
        -- caller-chosen strings like "proj-42"; without an owner anyone holding
        -- any valid key could read anyone else's thread by guessing one.
        owner TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        extra TEXT,
        tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        from_seq INTEGER NOT NULL,
        to_seq INTEGER NOT NULL,
        content TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_range ON summaries(session_id, from_seq, to_seq);
    `);

    // Older databases predate the owner column.
    const columns = (this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes('owner')) this.db.exec('ALTER TABLE sessions ADD COLUMN owner TEXT');

    this.stmts = {
      insertSession: this.db.prepare('INSERT OR IGNORE INTO sessions(id, created_at, updated_at, owner) VALUES(?, ?, ?, ?)'),
      ownerOf: this.db.prepare('SELECT owner FROM sessions WHERE id = ?'),
      touchSession: this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?'),
      insertMessage: this.db.prepare(
        'INSERT OR REPLACE INTO messages(session_id, seq, role, content, extra, tokens, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
      ),
      listMessages: this.db.prepare('SELECT seq, role, content, extra, tokens, created_at FROM messages WHERE session_id = ? ORDER BY seq'),
      maxSeq: this.db.prepare('SELECT COALESCE(MAX(seq), -1) AS s FROM messages WHERE session_id = ?'),
      insertSummary: this.db.prepare(
        'INSERT OR REPLACE INTO summaries(session_id, from_seq, to_seq, content, tokens, model, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
      ),
      findSummary: this.db.prepare('SELECT id, from_seq, to_seq, content, tokens, model, created_at FROM summaries WHERE session_id = ? AND from_seq = ? AND to_seq = ?'),
      listSummaries: this.db.prepare('SELECT id, from_seq, to_seq, content, tokens, model, created_at FROM summaries WHERE session_id = ? ORDER BY to_seq'),
      deleteSession: this.db.prepare('DELETE FROM sessions WHERE id = ?'),
      deleteMessages: this.db.prepare('DELETE FROM messages WHERE session_id = ?'),
      deleteSummaries: this.db.prepare('DELETE FROM summaries WHERE session_id = ?'),
      sessions: this.db.prepare(`
        SELECT s.id, s.created_at, s.updated_at, s.owner,
               (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messages,
               (SELECT COALESCE(SUM(tokens), 0) FROM messages m WHERE m.session_id = s.id) AS tokens,
               (SELECT COUNT(*) FROM summaries x WHERE x.session_id = s.id) AS summaries
        FROM sessions s ORDER BY s.updated_at DESC LIMIT ?
      `),
      session: this.db.prepare(`
        SELECT s.id, s.created_at, s.updated_at, s.owner,
               (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messages,
               (SELECT COALESCE(SUM(tokens), 0) FROM messages m WHERE m.session_id = s.id) AS tokens,
               (SELECT COUNT(*) FROM summaries x WHERE x.session_id = s.id) AS summaries
        FROM sessions s WHERE s.id = ?
      `),
    };
  }

  ensure(sessionId: string, now = Date.now(), owner: string | null = null): void {
    this.stmts.insertSession.run(sessionId, now, now, owner);
  }

  /**
   * May `owner` use this session?
   *
   * An unclaimed session (created before owners existed, or by an anonymous
   * caller on a loopback-only gateway) is open. Once a session has an owner,
   * only that owner may read or continue it.
   */
  canAccess(sessionId: string, owner: string | null): boolean {
    const row = this.stmts.ownerOf.get(sessionId) as { owner: string | null } | undefined;
    if (!row) return true; // does not exist yet — creating it claims it
    if (row.owner === null || row.owner === undefined) return true;
    return row.owner === owner;
  }

  append(
    sessionId: string,
    messages: { role: string; content: string; extra?: string | null; tokens: number }[],
    now = Date.now(),
    owner: string | null = null,
  ): number {
    if (messages.length === 0) return this.nextSeq(sessionId) - 1;
    this.ensure(sessionId, now, owner);

    let seq = this.nextSeq(sessionId);
    // One transaction so a crash mid-append cannot leave half a turn behind.
    this.db.exec('BEGIN');
    try {
      for (const m of messages) {
        this.stmts.insertMessage.run(sessionId, seq, m.role, m.content, m.extra ?? null, m.tokens, now);
        seq += 1;
      }
      this.stmts.touchSession.run(now, sessionId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return seq - 1;
  }

  private nextSeq(sessionId: string): number {
    const row = this.stmts.maxSeq.get(sessionId) as { s: number } | undefined;
    return (row?.s ?? -1) + 1;
  }

  messages(sessionId: string): StoredMessage[] {
    const rows = this.stmts.listMessages.all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      seq: Number(r['seq']),
      role: String(r['role']),
      content: String(r['content']),
      extra: r['extra'] === null || r['extra'] === undefined ? null : String(r['extra']),
      tokens: Number(r['tokens']),
      createdAt: Number(r['created_at']),
    }));
  }

  /**
   * Cache a compaction summary by the exact range it covers.
   *
   * Re-compacting the same span is the single most expensive thing the context
   * engine can do — it is a full LLM call over most of a window — so it happens
   * exactly once per range, ever.
   */
  putSummary(sessionId: string, fromSeq: number, toSeq: number, content: string, tokens: number, model: string, now = Date.now()): void {
    this.stmts.insertSummary.run(sessionId, fromSeq, toSeq, content, tokens, model, now);
  }

  getSummary(sessionId: string, fromSeq: number, toSeq: number): StoredSummary | null {
    const row = this.stmts.findSummary.get(sessionId, fromSeq, toSeq) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: Number(row['id']),
      fromSeq: Number(row['from_seq']),
      toSeq: Number(row['to_seq']),
      content: String(row['content']),
      tokens: Number(row['tokens']),
      model: String(row['model']),
      createdAt: Number(row['created_at']),
    };
  }

  summaries(sessionId: string): StoredSummary[] {
    const rows = this.stmts.listSummaries.all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r['id']),
      fromSeq: Number(r['from_seq']),
      toSeq: Number(r['to_seq']),
      content: String(r['content']),
      tokens: Number(r['tokens']),
      model: String(r['model']),
      createdAt: Number(r['created_at']),
    }));
  }

  info(sessionId: string): SessionInfo | null {
    const row = this.stmts.session.get(sessionId) as Record<string, unknown> | undefined;
    return row ? toInfo(row) : null;
  }

  list(limit = 50): SessionInfo[] {
    return (this.stmts.sessions.all(limit) as Record<string, unknown>[]).map(toInfo);
  }

  delete(sessionId: string): void {
    this.db.exec('BEGIN');
    try {
      this.stmts.deleteMessages.run(sessionId);
      this.stmts.deleteSummaries.run(sessionId);
      this.stmts.deleteSession.run(sessionId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

function toInfo(row: Record<string, unknown>): SessionInfo {
  return {
    id: String(row['id']),
    owner: row['owner'] === null || row['owner'] === undefined ? null : String(row['owner']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    messages: Number(row['messages']),
    tokens: Number(row['tokens']),
    summaries: Number(row['summaries']),
  };
}
