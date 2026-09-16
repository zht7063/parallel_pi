import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator, workspace } from './coordinator.mjs';
import { root, Rpc } from './rpc.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-pi-v02-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = join(dir, 'a'), b = join(dir, 'b'), data = join(dir, 'data');
  mkdirSync(a);
  const git = (...args) => execFileSync('git', args, { cwd: a, stdio: 'pipe' }).toString().trim();
  git('init', '-b', 'main');
  writeFileSync(join(a, 'tracked'), 'base');
  git('add', 'tracked');
  git('-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-m', 'fixture');
  git('worktree', 'add', '-b', 'other', b);
  return { dir, a, b, data, git };
}
async function until(predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw Error('Probe condition timed out');
    await delay(20);
  }
}
function alive(pid) {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return state.length > 0 && !state.startsWith('Z');
  } catch { return false; }
}
function killGroup(pid) { try { process.kill(-pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }

test('V02 real worktrees: serial per branch, parallel across branches, canonical aliases, idempotency', { timeout: 30000 }, async t => {
  const { dir, a, b, data } = fixture(t);
  const coordinator = new Coordinator(data);
  try {
    const alias = join(dir, 'alias'); symlinkSync(a, alias, 'dir');
    assert.equal(workspace(a).key, workspace(alias).key);
    assert.equal(workspace(a).repository, workspace(b).repository);
    assert.notEqual(workspace(a).key, workspace(b).key);
    coordinator.enqueue('a1', a, 'probe-tool');
    coordinator.enqueue('a2', alias, 'probe-tool');
    coordinator.enqueue('b1', b, 'probe-tool');
    assert.equal(coordinator.enqueue('a1', alias, 'probe-tool').id, 'a1');
    assert.throws(() => coordinator.enqueue('a1', a, 'different'), /Idempotency conflict/);
    assert.throws(() => new Coordinator(data), /Another backend/);
    coordinator.pump();
    assert.deepEqual([...coordinator.active.keys()], ['a1', 'b1']);
    assert.equal(coordinator.get('a2').state, 'queued');
    await Promise.all([...coordinator.active.values()].map(e => e.done));
    for (const id of ['a1', 'b1']) assert.equal(coordinator.get(id).state, 'succeeded', coordinator.get(id).error);
    const a1 = coordinator.get('a1'), b1 = coordinator.get('b1');
    assert.ok(a1.started < b1.ended && b1.started < a1.ended, 'actual pi process lifetimes overlap');
    coordinator.pump();
    await Promise.all([...coordinator.active.values()].map(e => e.done));
    assert.ok(coordinator.get('a2').started >= a1.ended);
    const events = coordinator.db.prepare('SELECT cursor FROM event ORDER BY cursor').all();
    assert.equal(new Set(events.map(e => e.cursor)).size, events.length);
  } finally { await coordinator.close(); }
});
test('V02 stop pauses lane, keeps edits and queued work, then explicit resume', { timeout: 30000 }, async t => {
  const { a, data } = fixture(t);
  const coordinator = new Coordinator(data);
  try {
    writeFileSync(join(a, 'tracked'), 'user dirty change');
    coordinator.enqueue('stop', a, 'probe-slow-tool');
    coordinator.enqueue('next', a, 'next');
    coordinator.pump();
    await until(() => existsSync(join(a, 'tool.pid')));
    const pid = Number(readFileSync(join(a, 'tool.pid'), 'utf8'));
    await coordinator.stop('stop');
    await until(() => !alive(pid));
    assert.equal(coordinator.get('stop').state, 'cancelled');
    assert.equal(coordinator.lane('stop').state, 'paused');
    coordinator.pump();
    assert.equal(coordinator.get('next').state, 'queued');
    assert.equal(readFileSync(join(a, 'tracked'), 'utf8'), 'user dirty change');
    assert.equal(existsSync(join(a, 'late-write')), false);
    coordinator.resume('stop'); coordinator.pump();
    await Promise.all([...coordinator.active.values()].map(e => e.done));
    assert.equal(coordinator.get('next').state, 'succeeded');
  } finally { await coordinator.close(); }
});
test('V02 changed worktree binding fails and pauses instead of running in another branch', async t => {
  const { a, data, git } = fixture(t);
  const coordinator = new Coordinator(data);
  try {
    coordinator.enqueue('changed', a, 'must not execute');
    git('switch', '-c', 'changed');
    coordinator.pump();
    await Promise.all([...coordinator.active.values()].map(e => e.done));
    assert.equal(coordinator.get('changed').state, 'failed');
    assert.equal(coordinator.get('changed').pid, null);
    assert.equal(coordinator.lane('changed').state, 'paused');
  } finally { await coordinator.close(); }
});
for (const killKernelFirst of [false, true]) test(`V02 crash recovery: ${killKernelFirst ? 'kernel SIGKILL leaves detached tool' : 'backend SIGKILL closes stdin and pi cleans tool'}`, { timeout: 30000 }, async t => {
  const { a, data } = fixture(t);
  const child = fork(`${root}probes/v02-worker.mjs`, [data, a], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let actors;
  let reopened;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try { [actors] = await once(child, 'message', { signal: controller.signal }); }
    finally { clearTimeout(timer); }
    assert.equal(actors.type, 'running');
    if (killKernelFirst) {
      child.kill('SIGSTOP'); // Freeze application persistence before crashing the kernel.
      killGroup(actors.pid);
      await until(() => !alive(actors.pid));
      assert.ok(alive(actors.toolPid), 'detached Bash survives kernel process-group kill');
    }
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    reopened = new Coordinator(data);
    assert.equal(reopened.get('crash-active').state, 'interrupted');
    assert.equal(reopened.get('crash-queued').state, 'queued');
    assert.equal(reopened.lane('crash-active').state, 'recovering');
    reopened.pump(); assert.equal(reopened.active.size, 0);
    assert.throws(() => reopened.resume('crash-active'), /reconciliation/);
    if (killKernelFirst) {
      assert.ok(alive(actors.toolPid), 'orphaned Bash remains alive');
      killGroup(actors.toolPid);
    }
    await until(() => !alive(actors.toolPid));
    assert.equal(existsSync(join(a, 'late-write')), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (actors) { killGroup(actors.pid); killGroup(actors.toolPid); }
    await reopened?.close();
  }
});
test('V02 pending session creation blocks branch; restart requires reconciliation of real file', { timeout: 20000 }, async t => {
  const { a, data, dir } = fixture(t);
  let coordinator = new Coordinator(data);
  const sessionPath = join(dir, 'created-session.jsonl');
  const agent = join(dir, 'agent'); mkdirSync(agent);
  let rpc;
  try {
    coordinator.enqueue('queued', a, 'queued');
    const lane = coordinator.get('queued').lane;
    coordinator.beginOperation('create', lane, 'create-session', sessionPath);
    coordinator.pump(); assert.equal(coordinator.active.size, 0);
    rpc = new Rpc(a, agent, ['--session', sessionPath]);
    await rpc.prompt('created before application commit');
    await rpc.close();
    await coordinator.close(); coordinator = new Coordinator(data);
    assert.equal(coordinator.lane('queued').state, 'recovering');
    assert.ok(existsSync(sessionPath));
    assert.match(readFileSync(sessionPath, 'utf8'), /created before application commit/);
    coordinator.pump(); assert.equal(coordinator.active.size, 0);
  } finally { await rpc?.close(); await coordinator.close(); }
});

for (const stage of ['before-spawn', 'after-spawn', 'after-acceptance']) test(`V02 startup crash window: ${stage} is never automatically replayed`, { timeout: 20000 }, async t => {
  const { a, data } = fixture(t);
  const child = fork(`${root}probes/v02-window-worker.mjs`, [data, a, stage], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const [code, signal] = await once(child, 'exit', { signal: AbortSignal.timeout(15000) });
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  const actors = JSON.parse(readFileSync(join(data, 'test-actors.json')));
  const coordinator = new Coordinator(data);
  try {
    assert.equal(coordinator.get('uncertain').state, 'interrupted');
    assert.equal(coordinator.lane('uncertain').state, 'recovering');
    assert.equal(coordinator.get('untouched').state, 'queued');
    if (stage !== 'after-acceptance') assert.equal(coordinator.get('uncertain').pid, null);
    coordinator.pump(); assert.equal(coordinator.active.size, 0);
    assert.throws(() => coordinator.resume('uncertain'), /reconciliation/);
    if (actors.pid) await until(() => !alive(actors.pid));
  } finally { if (actors.pid) killGroup(actors.pid); await coordinator.close(); }
});

test('V02 unexpected kernel death holds lane recovering while detached tool remains', { timeout: 20000 }, async t => {
  const { a, data } = fixture(t);
  const coordinator = new Coordinator(data);
  let toolPid;
  try {
    coordinator.enqueue('kernel-death', a, 'probe-slow-tool');
    coordinator.enqueue('blocked', a, 'must not start');
    coordinator.pump();
    await until(() => existsSync(join(a, 'tool.pid')));
    toolPid = Number(readFileSync(join(a, 'tool.pid'), 'utf8'));
    const entry = coordinator.active.get('kernel-death');
    killGroup(entry.rpc.child.pid);
    await entry.done;
    assert.ok(alive(toolPid));
    assert.equal(coordinator.get('kernel-death').state, 'interrupted');
    assert.equal(coordinator.lane('kernel-death').state, 'recovering');
    coordinator.pump(); assert.equal(coordinator.active.size, 0);
    assert.equal(coordinator.get('blocked').state, 'queued');
    assert.throws(() => coordinator.resume('kernel-death'), /reconciliation/);
  } finally { if (toolPid) killGroup(toolPid); await coordinator.close(); }
});

test('V02 waiting for a question occupies capacity; ready branches receive fair turns', { timeout: 30000 }, async t => {
  const { a, b, data } = fixture(t);
  const coordinator = new Coordinator(data, 1);
  try {
    coordinator.enqueue('question', a, 'probe-question-tool');
    coordinator.enqueue('a-backlog', a, 'a next');
    coordinator.enqueue('b-ready', b, 'b next');
    coordinator.pump();
    const entry = coordinator.active.get('question');
    const request = await entry.rpc.wait(e => e.type === 'extension_ui_request' && e.method === 'input');
    assert.equal(coordinator.get('question').state, 'waiting');
    coordinator.pump();
    assert.equal(coordinator.active.size, 1);
    assert.equal(coordinator.get('b-ready').state, 'queued');
    assert.equal(coordinator.get('a-backlog').state, 'queued');
    entry.rpc.send({ type: 'extension_ui_response', id: request.id, value: 'continue' });
    await entry.done;
    assert.equal(coordinator.get('question').state, 'succeeded');
    coordinator.pump();
    assert.deepEqual([...coordinator.active.keys()], ['b-ready']);
    await Promise.all([...coordinator.active.values()].map(e => e.done));
    coordinator.pump();
    await Promise.all([...coordinator.active.values()].map(e => e.done));
    assert.equal(coordinator.get('a-backlog').state, 'succeeded');
  } finally { await coordinator.close(); }
});
