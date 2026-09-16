// Executable V02 experiment, not the application's final module layout.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { Rpc } from './rpc.mjs';

export function workspace(cwd) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const directory = realpathSync(git('rev-parse', '--show-toplevel'));
  const repository = realpathSync(resolve(cwd, git('rev-parse', '--git-common-dir')));
  const ref = git('symbolic-ref', 'HEAD');
  return { directory, repository, ref, key: JSON.stringify([repository, ref]) };
}

export class Coordinator {
  active = new Map();
  constructor(directory, limit = 2, onStage = () => {}) {
    this.onStage = onStage;
    this.directory = directory;
    this.limit = limit;
    mkdirSync(directory, { recursive: true });
    this.lock = new DatabaseSync(join(directory, 'instance.sqlite'), { timeout: 0 });
    try { this.lock.exec('BEGIN EXCLUSIVE'); }
    catch (error) { this.lock.close(); throw new Error('Another backend owns this data directory', { cause: error }); }
    this.db = new DatabaseSync(join(directory, 'app.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS lane (id TEXT PRIMARY KEY, cwd TEXT UNIQUE, state TEXT NOT NULL, served INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS run (id TEXT PRIMARY KEY, lane TEXT NOT NULL, digest TEXT NOT NULL,
        prompt TEXT NOT NULL, model TEXT NOT NULL, state TEXT NOT NULL, pid INTEGER, started INTEGER, ended INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS event (cursor INTEGER PRIMARY KEY, run TEXT NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operation (id TEXT PRIMARY KEY, lane TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL);`);
    // An unverified old process must never grant execution permission after restart.
    this.db.exec(`BEGIN IMMEDIATE;
      UPDATE lane SET state='recovering' WHERE id IN (SELECT lane FROM run WHERE state IN ('starting','running','stopping','waiting'));
      UPDATE run SET state='interrupted' WHERE state IN ('starting','running','stopping','waiting');
      UPDATE lane SET state='recovering' WHERE id IN (SELECT lane FROM operation WHERE state='pending');
      COMMIT;`);
  }
  enqueue(id, cwd, prompt, model = 'probe-a') {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw Error('Invalid run ID');
    const binding = workspace(cwd);
    const digest = createHash('sha256').update(JSON.stringify([binding.key, prompt, model])).digest('hex');
    const old = this.db.prepare('SELECT * FROM run WHERE id=?').get(id);
    if (old) {
      if (old.digest !== digest) throw Error('Idempotency conflict');
      return old;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO lane (id,cwd,state) VALUES (?,?,'ready') ON CONFLICT(id) DO NOTHING").run(binding.key, binding.directory);
      const lane = this.db.prepare('SELECT * FROM lane WHERE id=?').get(binding.key);
      if (lane.cwd !== binding.directory) throw Error('Branch already bound to another directory');
      this.db.prepare("INSERT INTO run (id,lane,digest,prompt,model,state) VALUES (?,?,?,?,?,'queued')").run(id, binding.key, digest, prompt, model);
      this.db.prepare("INSERT INTO event (run,type,at) VALUES (?,'queued',?)").run(id, Date.now());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(id);
  }
  get(id) { return this.db.prepare('SELECT * FROM run WHERE id=?').get(id); }
  lane(id) { return this.db.prepare('SELECT * FROM lane WHERE id=?').get(this.get(id).lane); }
  transition(id, state, error = null) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE run SET state=?,error=? WHERE id=?').run(state, error, id);
      this.db.prepare('INSERT INTO event (run,type,at) VALUES (?,?,?)').run(id, state, Date.now());
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  pump() {
    const candidates = this.db.prepare("SELECT run.*,lane.cwd FROM run JOIN lane ON lane.id=run.lane WHERE run.state='queued' AND lane.state='ready' ORDER BY lane.served,run.rowid").all();
    for (const run of candidates) {
      if (this.active.size >= this.limit) break;
      if ([...this.active.values()].some(a => a.lane === run.lane)) continue;
      if (this.db.prepare("SELECT 1 FROM operation WHERE lane=? AND state='pending'").get(run.lane)) continue;
      const entry = { lane: run.lane, rpc: null, cancelled: false };
      this.db.prepare('UPDATE lane SET served=(SELECT COALESCE(MAX(served),0)+1 FROM lane) WHERE id=?').run(run.lane);
      this.active.set(run.id, entry);
      entry.done = this.execute(run, entry);
    }
  }
  async execute(run, entry) {
    let result = 'failed', error = null;
    try {
      if (workspace(run.cwd).key !== run.lane) throw Error('Worktree binding changed');
      this.transition(run.id, 'starting');
      const agentDir = join(this.directory, run.id);
      mkdirSync(agentDir, { recursive: true });
      this.onStage('before-spawn', run, entry);
      entry.rpc = new Rpc(run.cwd, agentDir, ['--model', run.model]);
      this.onStage('after-spawn', run, entry);
      this.db.prepare('UPDATE run SET pid=?,started=? WHERE id=?').run(entry.rpc.child.pid, Date.now(), run.id);
      const available = await entry.rpc.command('get_available_models');
      if (!available.models.some(model => model.provider === 'parallel-probe' && model.id === run.model)) throw Error('Fixed model unavailable in catalog');
      const state = await entry.rpc.command('get_state');
      if (state.model?.provider !== 'parallel-probe' || state.model.id !== run.model) throw Error('Fixed model unavailable');
      this.transition(run.id, 'running');
      let seen = entry.rpc.events.length;
      entry.rpc.changes.on('change', () => {
        const fresh = entry.rpc.events.slice(seen);
        seen = entry.rpc.events.length;
        if (fresh.some(event => event.type === 'extension_ui_request' && ['input', 'select', 'confirm', 'editor'].includes(event.method))) {
          if (entry.cancelled) {
            for (const id of entry.rpc.questions.keys()) entry.rpc.send({ type: 'extension_ui_response', id, cancelled: true });
          } else this.transition(run.id, 'waiting');
        }
      });
      const after = entry.rpc.events.length;
      await entry.rpc.command('prompt', { message: run.prompt });
      this.onStage('after-acceptance', run, entry);
      await entry.rpc.wait(event => event.type === 'agent_end', after);
      const events = entry.rpc.events.slice(after);
      const failed = events.find(e => e.type === 'message_end' && e.message.role === 'assistant' && ['error', 'aborted'].includes(e.message.stopReason));
      if (failed && !entry.cancelled) throw Error(`Kernel returned ${failed.message.stopReason}`);
      result = entry.cancelled ? 'cancelled' : 'succeeded';
    } catch (e) {
      error = e.message;
      result = entry.rpc?.exited ? 'interrupted' : (entry.cancelled ? 'cancelled' : 'failed');
    }
    finally {
      await entry.rpc?.close();
      this.db.prepare('UPDATE run SET ended=? WHERE id=?').run(Date.now(), run.id);
      this.transition(run.id, result, error);
      if (result !== 'succeeded') this.db.prepare('UPDATE lane SET state=? WHERE id=?').run(result === 'interrupted' ? 'recovering' : 'paused', run.lane);
      this.active.delete(run.id);
    }
  }
  async stop(id) {
    const active = this.active.get(id);
    if (!active?.rpc) throw Error('Run not active');
    active.cancelled = true;
    this.transition(id, 'stopping');
    await active.rpc.command('clear_queue');
    const aborted = active.rpc.command('abort');
    for (const id of active.rpc.questions.keys()) active.rpc.send({ type: 'extension_ui_response', id, cancelled: true });
    await aborted;
    await active.done;
  }
  resume(id) {
    const lane = this.lane(id);
    if (lane.state === 'recovering') throw Error('Process/operation reconciliation required');
    this.db.prepare("UPDATE lane SET state='ready' WHERE id=?").run(lane.id);
  }
  beginOperation(id, lane, kind, target) {
    if ([...this.active.values()].some(a => a.lane === lane)) throw Error('Branch is executing');
    if (this.db.prepare("SELECT 1 FROM operation WHERE lane=? AND state='pending'").get(lane)) throw Error('Branch operation pending');
    this.db.prepare("INSERT INTO operation VALUES (?,?,?,?,'pending')").run(id, lane, kind, target);
  }
  async close() {
    for (const [id, entry] of [...this.active]) {
      if (entry.rpc) await this.stop(id);
    }
    this.db.close();
    this.lock.exec('ROLLBACK'); this.lock.close();
  }
}
