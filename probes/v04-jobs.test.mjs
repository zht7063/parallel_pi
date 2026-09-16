import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { execute } from './.cache/mwf-source/packages/mwf/dist/core.js';
import { Coordinator } from './coordinator.mjs';
import { saveMemory } from './memory-jobs.mjs';

test('V04 successful run + failed critical save pause lane; restart retries only save', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-pi-memory-jobs-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  let coordinator;
  try {
    git('init', '-b', 'main'); writeFileSync(join(dir, 'tracked'), 'test'); git('add', 'tracked');
    git('-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-m', 'fixture');
    execute('init', { project_root: dir, git_mode: 'ignore' });
    const data = join(dir, 'data');
    coordinator = new Coordinator(data);
    coordinator.enqueue('success', dir, 'completed successfully');
    coordinator.enqueue('next', dir, 'must wait for save');
    coordinator.pump();
    await Promise.all([...coordinator.active.values()].map(e => e.done));
    assert.equal(coordinator.get('success').state, 'succeeded');
    const args = { project_root: dir, type: 'knowledge', title: 'Saved outcome', summary: 'Keep verified outcome', body: 'Evidence from successful run.', request_id: 'success-save' };
    assert.throws(() => saveMemory(coordinator, 'success', args, stage => { if (stage === 'prepared') throw Error('injected storage failure'); }), /storage failure/);
    assert.equal(coordinator.get('success').state, 'succeeded');
    assert.equal(coordinator.lane('success').state, 'paused');
    coordinator.pump(); assert.equal(coordinator.get('next').state, 'queued');
    const startEvents = coordinator.db.prepare("SELECT count(*) AS n FROM event WHERE run='success' AND type='starting'").get().n;
    await coordinator.close(); coordinator = new Coordinator(data);
    const job = coordinator.db.prepare("SELECT * FROM memory_job WHERE run='success'").get();
    assert.equal(job.state, 'failed');
    assert.equal(saveMemory(coordinator, 'success', JSON.parse(job.input)).replayed, true);
    assert.equal(coordinator.db.prepare("SELECT state FROM memory_job WHERE run='success'").get().state, 'saved');
    assert.equal(coordinator.db.prepare("SELECT count(*) AS n FROM event WHERE run='success' AND type='starting'").get().n, startEvents);
    assert.equal(execute('doctor', { project_root: dir }).ok, true);
  } finally { await coordinator?.close(); rmSync(dir, { recursive: true, force: true }); }
});
