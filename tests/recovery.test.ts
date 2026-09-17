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
    const historyResponse = await fetch(`${url}/api/history?sessionId=${session.id}`, {
      headers: { cookie },
    });
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json();
    assert.equal(
      history.messages.filter(
        (item: { role: string; text: string }) =>
          item.role === 'user' && item.text === 'probe-slow-tool',
      ).length,
      1,
    );
    assert.ok(
      history.messages.some(
        (item: { role: string; text: string }) =>
          item.role === 'assistant' && item.text.includes('tool.pid'),
      ),
    );

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

test(
  'SIGKILL during project inspection reaps detached Git hooks and restart never replays the read',
  { timeout: 30000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'parallel-git-inspect-crash-'));
    const directory = join(root, 'repository');
    mkdirSync(directory);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', directory, ...args], { stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(directory, 'code'), 'committed');
    git('add', '.');
    git('commit', '-m', 'initial');
    writeFileSync(join(directory, 'code'), 'dirty');
    const index = readFileSync(join(directory, '.git/index'));
    const pids = join(root, 'hook-pids'),
      release = join(root, 'release'),
      hook = join(root, 'fsmonitor');
    writeFileSync(
      hook,
      `#!/usr/bin/env python3\nimport os,subprocess,time\np=subprocess.Popen(['sleep','60'],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nwith open(${JSON.stringify(pids)},'a') as out: out.write(str(p.pid)+'\\n')\nwhile not os.path.exists(${JSON.stringify(release)}): time.sleep(.01)\nos.write(1,b'token\\0/\\0')\n`,
      { mode: 0o700 },
    );
    git('config', 'core.fsmonitor', hook);
    const start = () =>
      spawn(process.execPath, ['tests/backend-crash-worker.ts', root], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    let backend = start(),
      stderr = '';
    const errors = () =>
      backend.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
    errors();
    t.after(async () => {
      writeFileSync(release, 'release');
      if (backend.exitCode === null && backend.signalCode === null) {
        const ended = once(backend, 'exit');
        backend.kill('SIGTERM');
        await ended;
      }
      if (existsSync(pids))
        for (const pid of readFileSync(pids, 'utf8').trim().split('\n')) {
          try {
            process.kill(Number(pid), 'SIGKILL');
          } catch {
            /* Already reaped. */
          }
        }
      rmSync(root, { recursive: true, force: true });
    });
    const connect = async () => {
      await until(() => existsSync(join(root, 'url')), 'metadata backend listening: ' + stderr);
      const url = readFileSync(join(root, 'url'), 'utf8');
      const response = await fetch(url + '/api/session');
      const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
      return { url, headers: { cookie, 'content-type': 'application/json' } };
    };
    let client = await connect();
    const input = { type: 'project.add', directory };
    const pending = fetch(client.url + '/api/command', {
      method: 'POST',
      headers: client.headers,
      body: JSON.stringify(input),
    }).catch(() => null);
    await until(() => existsSync(pids), 'native Git fsmonitor hook');
    const pid = Number(readFileSync(pids, 'utf8').trim());
    const ended = once(backend, 'exit');
    backend.kill('SIGKILL');
    await ended;
    await pending;
    unlinkSync(join(root, 'url'));
    backend = start();
    errors();
    client = await connect();
    const snapshot = await (
      await fetch(client.url + '/api/snapshot', { headers: client.headers })
    ).json();
    assert.equal(
      snapshot.projects.length,
      0,
      'a killed read must not fabricate successful project registration',
    );
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    await delay(100);
    assert.equal(
      readFileSync(pids, 'utf8').trim().split('\n').length,
      1,
      'restart must not run the hook again',
    );
    writeFileSync(release, 'release');
    const response = await fetch(client.url + '/api/command', {
      method: 'POST',
      headers: client.headers,
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200, await response.text());
    const children = readFileSync(pids, 'utf8').trim().split('\n');
    assert.equal(children.length, 2, 'only an explicit retry starts the new inspection');
    for (const child of children) assert.throws(() => process.kill(Number(child), 0), /ESRCH/);
    assert.equal(readFileSync(join(directory, 'code'), 'utf8'), 'dirty');
    assert.deepEqual(readFileSync(join(directory, '.git/index')), index);
  },
);
