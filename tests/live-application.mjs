// Opt-in: node --env-file=.env --test tests/live-application.mjs
// Uses a real provider; excluded from the ordinary offline test suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createBackend } from '../apps/server/src/bootstrap.ts';

const provider = process.env.PARALLEL_PI_PROVIDER;
const model = process.env.PARALLEL_PI_MODEL;
assert.ok(provider && model, 'Configure provider/model and native API credentials locally');

test(
  'live application: HTTP text, bash, image and persisted continuation after backend restart',
  { timeout: 240000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'parallel-live-app-'));
    const directory = join(root, 'repository');
    mkdirSync(directory);
    const git = (...args) => execFileSync('git', ['-C', directory, ...args], { stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Live Acceptance');
    git('config', 'user.email', 'acceptance@example.invalid');
    writeFileSync(join(directory, 'code'), 'committed');
    git('add', '.');
    git('commit', '-m', 'initial');
    writeFileSync(join(directory, 'code'), 'preserve dirty content');
    const options = {
      dataDirectory: join(root, 'data'),
      agentDirectory: join(root, 'agent'),
      engineArgs: ['--no-extensions', '--no-skills', '--no-prompt-templates'],
    };
    let backend;
    let url;
    let headers;
    async function start() {
      backend = await createBackend(options);
      await new Promise((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${backend.server.address().port}`;
      const response = await fetch(url + '/api/session');
      headers = {
        cookie: response.headers.get('set-cookie').split(';')[0],
        'content-type': 'application/json',
      };
    }
    async function command(input) {
      const response = await fetch(url + '/api/command', {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 200, `HTTP command failed: ${input.type}`);
      return response.json();
    }
    async function snapshot() {
      return (await fetch(url + '/api/snapshot', { headers })).json();
    }
    async function history(sessionId) {
      return (
        await (
          await fetch(`${url}/api/history?sessionId=${sessionId}&limit=100`, { headers })
        ).json()
      ).messages;
    }
    async function run(sessionId, requestId, text, attachmentIds = []) {
      const intent = { type: 'run.enqueue', sessionId, requestId, text, attachmentIds };
      const accepted = await command(intent);
      assert.equal((await command(intent)).id, accepted.id);
      for (let i = 0; i < 900; i++) {
        const current = (await snapshot()).runs.find((item) => item.id === accepted.id);
        if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(current.state)) {
          assert.equal(
            current.state,
            'succeeded',
            `Live stage ${requestId} failed; inspect local application state`,
          );
          assert.deepEqual(current.model, { provider, model });
          return history(sessionId);
        }
        await delay(100);
      }
      throw new Error(`Live stage timed out: ${requestId}`);
    }
    const assistantText = (messages) =>
      messages.filter((item) => item.role === 'assistant').at(-1)?.text ?? '';
    try {
      await start();
      await command({ type: 'project.add', directory });
      const lane = (await snapshot()).lanes[0];
      const session = await command({
        type: 'session.create',
        laneId: lane.id,
        title: 'Live acceptance',
        model: { provider, model },
      });
      const first = await run(
        session.id,
        'live-text',
        'Remember marker PARALLEL_APP_731. Reply only with that marker.',
      );
      assert.match(assistantText(first), /PARALLEL_APP_731/);
      console.log('PASS: live HTTP text and request deduplication');
      const tool = await run(
        session.id,
        'live-tool',
        'Use the bash tool to run exactly: printf parallel-app-live-tool. Then briefly report the output.',
      );
      assert.ok(
        tool.some((item) => item.role === 'tool' && item.text.includes('parallel-app-live-tool')),
      );
      console.log('PASS: actual bash tool result in persisted history');
      const data = readFileSync(
        new URL('../probes/fixtures/red-square.png', import.meta.url),
      ).toString('base64');
      const attachment = backend.app.upload({ mimeType: 'image/png', data });
      const visual = await run(
        session.id,
        'live-image',
        'What is the dominant color of this image? Reply with one English word.',
        [attachment.id],
      );
      assert.match(assistantText(visual), /\bred\b/i);
      assert.ok(
        visual.some(
          (item) => item.role === 'user' && item.images.some((image) => image.data === data),
        ),
      );
      console.log('PASS: actual image understanding and persisted attachment');
      const priorIds = visual.map((item) => item.id);
      await backend.close();
      backend = undefined;
      await start();
      assert.deepEqual(
        (await history(session.id)).map((item) => item.id),
        priorIds,
      );
      assert.equal((await snapshot()).runs.length, 3);
      const resumed = await run(
        session.id,
        'live-resume',
        'What exact marker did I ask you to remember earlier? Reply only with that marker.',
      );
      assert.match(assistantText(resumed), /PARALLEL_APP_731/);
      assert.equal((await snapshot()).runs.length, 4);
      assert.equal(readFileSync(join(directory, 'code'), 'utf8'), 'preserve dirty content');
      console.log('PASS: backend restart, native continuation, no replay and dirty preservation');
    } finally {
      if (backend) await backend.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
