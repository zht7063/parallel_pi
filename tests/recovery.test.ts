import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { WorkspaceSnapshot } from '@parallel-pi/contracts';

async function until(predicate: () => boolean | Promise<boolean>, description: string) {
  for (let i = 0; i < 400; i++) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${description}`);
}

test(
  'real backend SIGKILL preserves queued work, reaps tools and requires explicit resume without replay',
  { timeout: 30000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'parallel-recovery-'));
    const directory = join(root, 'repository');
    mkdirSync(directory);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', directory, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(directory, 'code'), 'committed');
    git('add', '.');
    git('commit', '-m', 'initial');
    writeFileSync(join(directory, 'code'), 'dirty');
    const start = () =>
      spawn(process.execPath, ['tests/backend-crash-worker.ts', root], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    let backend = start(),
      url = '',
      cookie = '';
    let stderr = '';
    backend.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    t.after(async () => {
      if (backend.exitCode === null && backend.signalCode === null) {
        const exited = once(backend, 'exit');
        backend.kill('SIGTERM');
        await exited;
      }
      rmSync(root, { recursive: true, force: true });
    });
    async function connect() {
      await until(() => existsSync(join(root, 'url')), `server listening: ${stderr}`);
      url = readFileSync(join(root, 'url'), 'utf8');
      const response = await fetch(url + '/api/session');
      cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    }
    async function command(value: unknown) {
      const response = await fetch(url + '/api/command', {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    }
    async function snapshot(): Promise<WorkspaceSnapshot> {
      return (await fetch(url + '/api/snapshot', { headers: { cookie } })).json();
    }
    await connect();
    await command({ type: 'project.add', directory });
    const lane = (await snapshot()).lanes[0]!;
    const session = await command({
      type: 'session.create',
      laneId: lane.id,
      title: 'Crash test',
      model: { provider: 'parallel-probe', model: 'probe-a' },
    });
    const input = {
      type: 'run.enqueue',
      requestId: 'crashed-request',
      sessionId: session.id,
      text: 'probe-slow-tool',
      attachmentIds: [],
    };
    const active = await command(input);
    const queued = await command({
      ...input,
      requestId: 'queued-request',
      text: 'after explicit resume',
    });
    await until(() => existsSync(join(directory, 'tool.pid')), 'real Bash tool started');
    const toolPid = Number(readFileSync(join(directory, 'tool.pid'), 'utf8'));
    const exit = once(backend, 'exit');
    backend.kill('SIGKILL');
    await exit;
    unlinkSync(join(root, 'url'));
    backend = start();
    backend.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    await connect();
    const recovered = await snapshot();
    assert.equal(recovered.runs.find((run) => run.id === active.id)?.state, 'interrupted');
    assert.equal(recovered.runs.find((run) => run.id === queued.id)?.state, 'queued');
    assert.equal(recovered.lanes[0]?.state, 'paused');
    assert.throws(() => process.kill(toolPid, 0), /ESRCH/);
    assert.equal((await command(input)).id, active.id);
    assert.equal((await snapshot()).runs.length, 2);
    await delay(200);
    assert.equal((await snapshot()).runs.find((run) => run.id === queued.id)?.state, 'queued');
    assert.equal(recovered.runs.find((run) => run.id === active.id)?.handoff?.state, 'pending');
    await command({ type: 'handoff.retry', runId: active.id });
    await command({ type: 'lane.resume', laneId: lane.id });
    await until(
      async () =>
        (await snapshot()).runs.find((run) => run.id === queued.id)?.state === 'succeeded',
      'queued run completed',
    );
    assert.equal((await snapshot()).runs.find((run) => run.id === active.id)?.state, 'interrupted');
    assert.equal(existsSync(join(directory, 'late-write')), false);
    assert.equal(readFileSync(join(directory, 'code'), 'utf8'), 'dirty');
  },
);
