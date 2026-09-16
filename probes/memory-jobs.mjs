// V04 experiment: application-owned save intent; no new MWF schema fields.
import { execute } from './.cache/mwf-source/packages/mwf/dist/core.js';
export function saveMemory(coordinator, runId, args, fault) {
  const db = coordinator.db;
  db.exec(`CREATE TABLE IF NOT EXISTS memory_job (run TEXT PRIMARY KEY, input TEXT NOT NULL, state TEXT NOT NULL, error TEXT)`);
  const input = JSON.stringify(args);
  const existing = db.prepare('SELECT * FROM memory_job WHERE run=?').get(runId);
  if (existing && existing.input !== input) throw Error('Save intent conflict');
  if (!args.request_id) throw Error('Save requires stable request_id');
  db.prepare("INSERT INTO memory_job VALUES (?,?,'pending',NULL) ON CONFLICT(run) DO NOTHING").run(runId, input);
  try {
    const result = execute('add', args, { fault });
    db.prepare("UPDATE memory_job SET state='saved',error=NULL WHERE run=?").run(runId);
    return result;
  } catch (error) {
    db.exec('BEGIN IMMEDIATE');
    db.prepare("UPDATE memory_job SET state='failed',error=? WHERE run=?").run(error.message, runId);
    db.prepare("UPDATE lane SET state='paused' WHERE id=?").run(coordinator.get(runId).lane);
    db.exec('COMMIT');
    throw error;
  }
}
