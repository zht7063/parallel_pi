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

for (const hook of ['pre-commit', 'post-commit']) {
  test(
    `backend SIGKILL during ${hook} reconciles the original HTTP commit without replay`,
    { timeout: 30000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'parallel-commit-crash-'));
      const directory = join(root, 'repository');
      mkdirSync(directory);
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', directory, ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      git('init', '-b', 'main');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      writeFileSync(join(directory, 'selected'), 'original selected\n');
      writeFileSync(join(directory, 'other'), 'original other\n');
      git('add', '.');
      git('commit', '-m', 'initial');
      const originalHead = git('rev-parse', 'HEAD');
      writeFileSync(join(directory, 'selected'), 'selected change\n');
      writeFileSync(join(directory, 'other'), 'staged other\n');
      git('add', '--', 'other');
      writeFileSync(join(directory, 'other'), 'unstaged other\n');
      const start = () =>
        spawn(process.execPath, ['tests/backend-crash-worker.ts', root], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      let backend = start();
      let stderr = '';
      const capture = () =>
        backend.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
      capture();
      t.after(async () => {
        if (backend.exitCode === null && backend.signalCode === null) {
          const ended = once(backend, 'exit');
          backend.kill('SIGTERM');
          await ended;
        }
        rmSync(root, { recursive: true, force: true });
      });
      async function connect() {
        await until(() => existsSync(join(root, 'url')), 'commit backend listening: ' + stderr);
        const url = readFileSync(join(root, 'url'), 'utf8');
        const response = await fetch(url + '/api/session');
        return {
          url,
          headers: {
            cookie: response.headers.get('set-cookie')!.split(';')[0]!,
            'content-type': 'application/json',
          },
        };
      }
      let client = await connect();
      async function command(input: unknown) {
        const response = await fetch(client.url + '/api/command', {
          method: 'POST',
          headers: client.headers,
          body: JSON.stringify(input),
        });
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        return body;
      }
      async function snapshot(): Promise<WorkspaceSnapshot> {
        return (await fetch(client.url + '/api/snapshot', { headers: client.headers })).json();
      }
      await command({ type: 'project.add', directory });
      const lane = (await snapshot()).lanes[0]!;
      const session = await command({
        type: 'session.create',
        laneId: lane.id,
        title: 'After interrupted commit',
        model: { provider: 'parallel-probe', model: 'probe-a' },
      });
      writeFileSync(
        join(directory, '.git/hooks', hook),
        `#!/bin/sh
printf 'once\n' >> '${join(root, 'hook-count')}'
echo $$ > '${join(root, 'hook.pid')}'
sleep 30 &
echo $! > '${join(root, 'child.pid')}'
wait
printf unsafe > '${join(root, 'late-write')}'
`,
        { mode: 0o700 },
      );
      const view = await command({ type: 'git.inspect', laneId: lane.id });
      const preview = await command({
        type: 'git.preview-commit',
        laneId: lane.id,
        revision: view.revision,
        paths: ['selected'],
      });
      const index = readFileSync(join(directory, '.git/index'));
      const input = {
        type: 'git.commit',
        laneId: lane.id,
        requestId: 'interrupted-http-commit',
        revision: preview.revision,
        tree: preview.tree,
        paths: preview.paths,
        message: 'Explicit selected commit',
      };
      const pending = fetch(client.url + '/api/command', {
        method: 'POST',
        headers: client.headers,
        body: JSON.stringify(input),
      }).then(
        () => 'response',
        () => 'disconnected',
      );
      await until(
        () =>
          existsSync(join(root, 'child.pid')) &&
          readFileSync(join(root, 'child.pid'), 'utf8').trim().length > 0,
        'native commit hook blocked',
      );
      await until(
        async () => (await snapshot()).gitCommits[0]?.hook === hook,
        'durable hook progress',
      );
      const job = (await snapshot()).gitCommits[0]!;
      assert.equal(job.state, 'pending');
      assert.equal(existsSync(join(directory, '.git/index.lock')), true);
      const queued = await command({
        type: 'run.enqueue',
        requestId: 'after-interrupted-commit',
        sessionId: session.id,
        text: 'after explicit commit recovery',
        attachmentIds: [],
      });
      assert.equal((await snapshot()).runs.find((item) => item.id === queued.id)?.state, 'queued');
      const pids = ['hook.pid', 'child.pid'].map((file) =>
        Number(readFileSync(join(root, file), 'utf8')),
      );
      const ended = once(backend, 'exit');
      backend.kill('SIGKILL');
      await ended;
      assert.equal(await pending, 'disconnected', 'the original HTTP confirmation is lost');
      unlinkSync(join(root, 'url'));
      backend = start();
      capture();
      client = await connect();
      const recovered = await snapshot();
      const result = recovered.gitCommits.find((item) => item.id === job.id)!;
      assert.equal(
        result.state,
        hook === 'pre-commit' ? 'failed' : 'committed',
        result.error ?? '',
      );
      assert.equal(recovered.lanes[0]!.state, 'paused');
      assert.equal(recovered.runs.find((item) => item.id === queued.id)?.state, 'queued');
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/);
      assert.equal(existsSync(join(root, 'late-write')), false);
      assert.equal(existsSync(join(directory, '.git/index.lock')), false);
      assert.equal(readFileSync(join(root, 'hook-count'), 'utf8'), 'once\n');
      assert.equal(readFileSync(join(directory, 'selected'), 'utf8'), 'selected change\n');
      assert.equal(readFileSync(join(directory, 'other'), 'utf8'), 'unstaged other\n');
      assert.equal(git('show', ':other'), 'staged other');
      if (hook === 'pre-commit') {
        assert.equal(result.commit, null);
        assert.equal(git('rev-parse', 'HEAD'), originalHead);
        assert.deepEqual(readFileSync(join(directory, '.git/index')), index);
      } else {
        assert.equal(result.commit, git('rev-parse', 'HEAD'));
        assert.match(result.error!, /post-commit was interrupted/);
        assert.equal(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'selected');
        assert.equal(git('show', 'HEAD:selected'), 'selected change');
        assert.equal(git('diff', '--cached', '--name-only'), 'other');
      }
      assert.deepEqual(
        await command(input),
        result,
        'retry retains the original request and outcome',
      );
      assert.deepEqual(await command({ type: 'git.reconcile', jobId: job.id }), result);
      assert.equal((await snapshot()).gitCommits.length, 1);
      assert.equal(readFileSync(join(root, 'hook-count'), 'utf8'), 'once\n');
      assert.equal(git('rev-list', '--count', 'HEAD'), hook === 'pre-commit' ? '1' : '2');
      await command({ type: 'lane.resume', laneId: lane.id });
      await until(
        async () =>
          (await snapshot()).runs.find((item) => item.id === queued.id)?.state === 'succeeded',
        'explicitly resumed queue',
      );
      assert.equal(readFileSync(join(root, 'hook-count'), 'utf8'), 'once\n');
      assert.equal(git('show', ':other'), 'staged other');
    },
  );
}
