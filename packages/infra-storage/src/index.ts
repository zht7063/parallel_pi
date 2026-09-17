import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { AppStore, AppState, AppEvent, Transaction } from '@parallel-pi/application';

export function openStore(directory: string): AppStore {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = realpathSync(directory);
  const lockPath = join(root, 'instance.sqlite');
  const lock = new DatabaseSync(lockPath, { timeout: 0 });
  chmodSync(lockPath, 0o600);
  try {
    lock.exec('BEGIN EXCLUSIVE');
  } catch (cause) {
    lock.close();
    throw new Error('Another backend owns this application data directory', { cause });
  }
  let db!: DatabaseSync;
  try {
    const path = join(root, 'app.sqlite');
    db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (version > 1)
      throw new Error('Application database is newer than this build; restore a compatible backup');
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event (cursor INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
      PRAGMA user_version=1;`);
    const initial: AppState = {
      projects: [],
      lanes: [],
      operations: [],
      sessions: [],
      runs: [],
      attachments: [],
      concurrency: 2,
      drafts: [],
      memorySaves: [],
      memoryChanges: [],
      gitCommits: [],
    };
    db.prepare('INSERT OR IGNORE INTO app_state VALUES (1,?)').run(JSON.stringify(initial));
  } catch (error) {
    // Closing the instance transaction relinquishes ownership even when schema startup fails.
    try {
      db?.close();
    } finally {
      lock.close();
    }
    throw error;
  }
  let closed = false;
  let inTransaction = false;
  function ensureOpen() {
    if (closed) throw new Error('Application store is closed');
  }
  function state(): AppState {
    const value: AppState = JSON.parse(
      String(db.prepare('SELECT payload FROM app_state WHERE id=1').get()?.payload),
    );
    // Additive pre-release data: older M2 snapshots have no memory save jobs.
    value.memorySaves ??= [];
    value.memoryChanges ??= [];
    value.gitCommits ??= [];
    return value;
  }
  function cursor(): number {
    return Number(db.prepare('SELECT COALESCE(MAX(cursor),0) AS value FROM event').get()?.value);
  }
  return {
    snapshot() {
      ensureOpen();
      // Single synchronous owner: nothing can interleave between metadata and cursor reads.
      return { state: state(), cursor: cursor() };
    },
    transaction<T>(update: (transaction: Transaction) => T): T {
      ensureOpen();
      if (inTransaction) throw new Error('Nested application transactions are not supported');
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      let writable = true;
      try {
        const next = state();
        const result = update({
          state: next,
          emit(type, data) {
            if (!writable) throw new Error('Transaction event writer is no longer active');
            db.prepare('INSERT INTO event(type,at,data) VALUES (?,?,?)').run(
              type,
              Date.now(),
              JSON.stringify(data),
            );
          },
        });
        if (result && typeof result === 'object' && 'then' in result)
          throw new Error('Application transactions must be synchronous');
        // ponytail: one metadata document is O(total metadata) per command; normalize tables when measured size warrants it. Events/history stay separate.
        db.prepare('UPDATE app_state SET payload=? WHERE id=1').run(JSON.stringify(next));
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        writable = false;
        inTransaction = false;
      }
    },
    append(type, data) {
      ensureOpen();
      if (inTransaction) throw new Error('Use the transaction event writer inside a transaction');
      db.prepare('INSERT INTO event(type,at,data) VALUES (?,?,?)').run(
        type,
        Date.now(),
        JSON.stringify(data),
      );
    },
    events(after, limit = 500) {
      ensureOpen();
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new Error('Invalid event cursor or page size');
      return db
        .prepare('SELECT * FROM event WHERE cursor>? ORDER BY cursor LIMIT ?')
        .all(after, limit)
        .map(
          (row) =>
            ({
              cursor: Number(row.cursor),
              version: 1,
              type: String(row.type),
              at: Number(row.at),
              data: JSON.parse(String(row.data)),
            }) satisfies AppEvent,
        );
    },
    close() {
      if (closed) return;
      if (inTransaction) throw new Error('Cannot close during a transaction');
      closed = true;
      try {
        db.close();
      } finally {
        lock.close();
      }
    },
  };
}
export { createAttachmentStore } from './attachments.ts';

export { createHandoffStore } from './handoffs.ts';
