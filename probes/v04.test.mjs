import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { execute } from './.cache/mwf-source/packages/mwf/dist/core.js';
import { root } from './rpc.mjs';
import { updateMemory } from './memory-revision.mjs';
import { hash } from './.cache/mwf-source/packages/mwf/dist/storage.js';

const cli = `${root}probes/.cache/mwf-source/packages/mwf/dist/cli.js`;
const argsFor = project_root => ({ project_root, type: 'preference', title: 'Probe preference', summary: 'Prefer explicit evidence', body: 'Verified in an isolated V04 probe.', request_id: 'save-1' });
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-pi-v04-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function callChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', c => { output += c; });
    child.stderr.on('data', c => { error += c; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error + output)));
  });
}
test('V04 bootstrap, recall, idempotent saves and conflicting request IDs', t => {
  const project_root = temporary(t);
  execute('init', { project_root, git_mode: 'track' });
  assert.match(execute('bootstrap', { project_root }).data.handoff, /Project handoff/);
  const args = argsFor(project_root);
  const first = execute('add', args);
  assert.equal(execute('add', args).replayed, true);
  assert.throws(() => execute('add', { ...args, summary: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.ok(JSON.stringify(execute('recall', { project_root, query: 'explicit evidence' })).includes(first.data.id));
  assert.equal(execute('doctor', { project_root }).ok, true);
});
test('V04 interrupted transactions recover without duplicate records', t => {
  for (const stage of ['prepared', 'applied:0', 'before-cleanup']) {
    const project_root = temporary(t);
    execute('init', { project_root, git_mode: 'ignore' });
    const args = argsFor(project_root);
    assert.throws(() => execute('add', args, { fault(at) { if (at === stage) throw Error('injected interruption'); } }), /injected/);
    const recovered = execute('add', args);
    assert.equal(recovered.replayed, true);
    assert.equal(execute('doctor', { project_root }).ok, true);
    assert.equal(existsSync(join(project_root, '.mwf/local/transaction.json')), false);
  }
});
test('V04 recovery preserves an external edit and its pending journal', t => {
  const project_root = temporary(t);
  execute('init', { project_root, git_mode: 'track' });
  assert.throws(() => execute('add', argsFor(project_root), { fault(at) { if (at === 'prepared') throw Error('interrupted'); } }));
  const journalPath = join(project_root, '.mwf/local/transaction.json');
  const journal = JSON.parse(readFileSync(journalPath));
  const target = join(project_root, journal.changes[0].path);
  writeFileSync(target, 'external edit');
  assert.throws(() => execute('add', argsFor(project_root)), { code: 'RECOVERY_CONFLICT' });
  assert.equal(readFileSync(target, 'utf8'), 'external edit');
  assert.ok(existsSync(journalPath));
});
test('V04 real concurrent CLI writers serialize and deduplicate', async t => {
  const project_root = temporary(t);
  execute('init', { project_root, git_mode: 'track' });
  const args = argsFor(project_root);
  const results = await Promise.all(Array.from({ length: 4 }, () => callChild(['add', '--input', JSON.stringify(args)])));
  assert.equal(new Set(results.map(r => r.data.id)).size, 1);
  assert.equal(results.filter(r => r.replayed).length, 3);
  assert.equal(execute('doctor', { project_root }).ok, true);
});
test('V04 native update has no caller revision guard (documented capability gap)', t => {
  const project_root = temporary(t);
  execute('init', { project_root, git_mode: 'track' });
  const record = execute('add', argsFor(project_root));
  execute('update', { project_root, id: record.data.id, body: 'New external conclusion', apply: true });
  execute('update', { project_root, id: record.data.id, body: 'Stale UI conclusion', apply: true });
  assert.match(readFileSync(join(project_root, record.data.path), 'utf8'), /Stale UI conclusion/);
  assert.throws(() => execute('update', { project_root, id: record.data.id, expected_revision: 'old', apply: true }), { code: 'INVALID_INPUT' });
});
test('V04 real worktrees inherit tracked memory but do not share subsequent writes', t => {
  const dir = temporary(t), repo = join(dir, 'repo'), other = join(dir, 'other');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();
  git('init', '-b', 'main');
  execute('init', { project_root: repo, git_mode: 'track' });
  const record = execute('add', argsFor(repo));
  git('add', '.mwf', '.gitignore', 'AGENTS.md');
  git('-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-m', 'fixture');
  git('worktree', 'add', '-b', 'other', other);
  assert.ok(readFileSync(join(other, record.data.path), 'utf8').includes('explicit evidence'));
  execute('update', { project_root: other, id: record.data.id, body: 'Other worktree only', apply: true });
  assert.ok(!readFileSync(join(repo, record.data.path), 'utf8').includes('Other worktree only'));
  assert.match(git('check-ignore', '.mwf/local/runtime.sqlite'), /runtime.sqlite/);
  const ignored = join(dir, 'ignored'); mkdirSync(ignored);
  execute('init', { project_root: ignored, git_mode: 'ignore' });
  assert.match(readFileSync(join(ignored, '.gitignore'), 'utf8'), /\.mwf\//);
});

test('V04 revision adapter uses native lock and transaction to preserve external corrections', t => {
  const project_root = temporary(t);
  execute('init', { project_root, git_mode: 'track' });
  const record = execute('add', argsFor(project_root));
  const file = join(project_root, record.data.path);
  const oldRevision = hash(readFileSync(file, 'utf8'));
  execute('update', { project_root, id: record.data.id, body: 'External corrected evidence', apply: true });
  assert.throws(() => updateMemory({ project_root, id: record.data.id, body: 'Stale UI correction' }, oldRevision), /Memory revision conflict/);
  assert.match(readFileSync(file, 'utf8'), /External corrected evidence/);
  const current = hash(readFileSync(file, 'utf8'));
  updateMemory({ project_root, id: record.data.id, body: 'Accepted correction' }, current);
  assert.match(readFileSync(file, 'utf8'), /Accepted correction/);
  const latest = hash(readFileSync(file, 'utf8'));
  assert.throws(() => updateMemory({ project_root, id: record.data.id, body: 'Racing correction' }, latest, () => {
    writeFileSync(file, readFileSync(file, 'utf8').replace('Accepted correction', 'External editor won race'));
  }), { code: 'WRITE_CONFLICT' });
  assert.match(readFileSync(file, 'utf8'), /External editor won race/);
  assert.equal(execute('doctor', { project_root }).ok, true);
});
