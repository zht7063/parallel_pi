import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSupervisor } from '@parallel-pi/infra-platform';
import { createEngine } from '@parallel-pi/infra-pi';
import type { EngineEvent } from '@parallel-pi/application';

const fixture = fileURLToPath(new URL('../probes/fixture-extension.mjs', import.meta.url));
test(
  'real supervised pi persists text/images/tools, resumes, correlates questions and rejects unavailable models',
  { timeout: 30000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'parallel-engine-'));
    const directory = join(root, 'workspace');
    mkdirSync(directory);
    const engine = createEngine({
      supervisor: createSupervisor(join(root, 'supervision')),
      sessionRoot: join(root, 'sessions'),
      agentDirectory: join(root, 'agent'),
      extraArgs: ['--no-extensions', '--no-skills', '--no-prompt-templates', '-e', fixture],
    });
    const events: EngineEvent[] = [];
    let connection = await engine.open(
      { operationId: 'create', directory, sessionRef: engine.sessionPath('session'), create: true },
      (event) => {
        events.push(event);
        if (event.type === 'question') connection.answer(event.question.id, 'continue');
      },
    );
    t.after(async () => {
      await connection.close();
      rmSync(root, { recursive: true, force: true });
    });
    assert.equal(await engine.reconcileSession(connection.sessionRef, directory), true);
    assert.ok(
      (await connection.models()).some((model) => model.model === 'probe-a' && model.images),
    );
    await assert.rejects(
      connection.select({ provider: 'parallel-probe', model: 'does-not-exist' }),
      /unavailable/,
    );
    await connection.select({ provider: 'parallel-probe', model: 'probe-a' });
    await connection.execute('first marker\u2028中文', []);
    await connection.execute('probe-tool', []);
    await connection.execute('probe-question-tool', []);
    assert.ok(events.some((event) => event.type === 'tool' && event.phase === 'end'));
    assert.ok(events.some((event) => event.type === 'question'));
    await connection.execute('image', [
      {
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=',
      },
    ]);
    const before = await connection.messages();
    assert.ok(before.some((message) => message.role === 'user' && message.images.length === 1));
    assert.equal((await connection.close()).settled, true);
    connection = await engine.open(
      { operationId: 'resume', directory, sessionRef: engine.sessionPath('session') },
      (event) => events.push(event),
    );
    assert.deepEqual(await connection.messages(), before);
    assert.equal(existsSync(engine.sessionPath('session')), true);
  },
);
