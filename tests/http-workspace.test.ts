import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createBackend } from '../apps/server/src/bootstrap.ts';
import type { WorkspaceSnapshot } from '@parallel-pi/contracts';

test(
  'HTTP commands reach real pi, snapshots exclude native refs, and SSE resumes without resending',
  { timeout: 30000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'parallel-http-'));
    const directory = join(root, 'repository');
    mkdirSync(directory);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', directory, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(directory, 'file'), 'initial');
    git('add', '.');
    git('commit', '-m', 'initial');
    const backend = await createBackend({
      dataDirectory: join(root, 'data'),
      agentDirectory: join(root, 'agent'),
      engineArgs: [
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '-e',
        fileURLToPath(new URL('../probes/fixture-extension.mjs', import.meta.url)),
      ],
    });
    t.after(async () => {
      await backend.close();
      rmSync(root, { recursive: true, force: true });
    });
    backend.server.listen(0, '127.0.0.1');
    await once(backend.server, 'listening');
    const address = backend.server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const sessionResponse = await fetch(url + '/api/session');
    const cookie = sessionResponse.headers.get('set-cookie')!.split(';')[0]!;
    const headers = { cookie, 'Content-Type': 'application/json' };
    const command = async (value: unknown) => {
      const response = await fetch(url + '/api/command', {
        method: 'POST',
        headers,
        body: JSON.stringify(value),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const snapshot = async (): Promise<WorkspaceSnapshot> =>
      (await fetch(url + '/api/snapshot', { headers })).json();
    const owner = await command({ type: 'project.add', directory });
    assert.deepEqual(Object.keys(owner), ['id']);
    const initial = await snapshot();
    const lane = initial.lanes[0]!;
    const session = await command({
      type: 'session.create',
      laneId: lane.id,
      title: 'HTTP session',
      model: { provider: 'parallel-probe', model: 'probe-a' },
    });
    const before = await snapshot();
    assert.equal(JSON.stringify(before).includes('nativeRef'), false);
    assert.ok(before.projects.every((value) => !('repository' in value)));
    const sent = {
      type: 'run.enqueue',
      requestId: 'http-run',
      sessionId: session.id,
      text: 'hello over HTTP',
      attachmentIds: [],
    };
    const run = await command(sent);
    assert.equal((await command(sent)).id, run.id);
    let final = await snapshot();
    for (let i = 0; i < 300 && final.runs[0]?.state !== 'succeeded'; i++) {
      await delay(25);
      final = await snapshot();
    }
    assert.equal(final.runs[0]?.state, 'succeeded', JSON.stringify(final.runs));
    const controller = new AbortController();
    const events = await fetch(url + `/api/events?after=${before.cursor}`, {
      headers,
      signal: controller.signal,
    });
    assert.equal(events.status, 200);
    const reader = events.body!.getReader();
    let text = '';
    while (!text.includes('data:')) {
      const part = await reader.read();
      text += new TextDecoder().decode(part.value);
    }
    assert.match(text, /"type":"changed"/);
    controller.abort();
    assert.equal((await snapshot()).runs.length, 1);
    const bad = await fetch(url + '/api/command', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'run.enqueue',
        requestId: 'bad',
        sessionId: session.id,
        text: '',
        attachmentIds: 'not-array',
      }),
    });
    assert.equal(bad.status, 400);
  },
);
