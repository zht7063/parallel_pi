import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSupervisor } from '@parallel-pi/infra-platform';
import { createEngine } from '@parallel-pi/infra-pi';
import type { EngineEvent } from '@parallel-pi/application';

const fixture = fileURLToPath(new URL('../probes/fixture-extension.mjs', import.meta.url));
test(
  'real supervised pi persists text/images/tools, resumes, correlates questions and rejects unavailable models',
  { timeout: 300000 },
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
    let before: Awaited<ReturnType<typeof connection.messages>> = [];
    await t.test('RPC, tools, images and resume', { timeout: 30000 }, async () => {
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
      await connection.execute('', [
        {
          mimeType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=',
        },
      ]);
      await connection.execute('image', [
        {
          mimeType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=',
        },
      ]);
      before = await connection.messages();
      assert.ok(before.some((message) => message.role === 'user' && message.images.length === 1));
      assert.equal((await connection.close()).settled, true);
      connection = await engine.open(
        { operationId: 'resume', directory, sessionRef: engine.sessionPath('session') },
        (event) => events.push(event),
      );
      assert.deepEqual(await connection.messages(), before);
      assert.equal(existsSync(engine.sessionPath('session')), true);
      assert.equal((await connection.close()).settled, true);
    });
    const sourceRef = engine.sessionPath('session');
    const sourceBytes = readFileSync(sourceRef, 'utf8');
    const users = before.filter((message) => message.role === 'user');
    assert.ok(users.filter((message) => message.text).every((message) => message.forkable));
    assert.ok(users.some((message) => !message.text && message.images.length && !message.forkable));
    assert.ok(
      before.filter((message) => message.role !== 'user').every((message) => !message.forkable),
    );
    for (const [index, selected] of users.entries()) {
      if (!selected.forkable) continue;
      await t.test(`native fork at user message ${index}`, { timeout: 30000 }, async () => {
        const input = {
          operationId: `fork-${index}`,
          directory,
          sourceRef,
          targetRef: engine.sessionPath(`child-${index}`),
          entryId: selected.id,
        };
        const forked = await engine.fork(input);
        assert.deepEqual(forked.draft, { text: selected.text, images: selected.images });
        assert.deepEqual(
          forked.messages,
          before.slice(
            0,
            before.findIndex((message) => message.id === selected.id),
          ),
        );
        assert.equal(readFileSync(sourceRef, 'utf8'), sourceBytes);
        // Lost publication/confirmation recovers the native snapshot, without a new process.
        rmSync(input.targetRef);
        assert.deepEqual(await engine.reconcileFork(input), forked);
        const reopened = await engine.open(
          { operationId: `child-read-${index}`, directory, sessionRef: input.targetRef },
          () => {},
        );
        try {
          assert.deepEqual(await reopened.messages(), forked.messages);
        } finally {
          assert.equal((await reopened.close()).settled, true);
        }
        const original = readFileSync(input.targetRef, 'utf8');
        writeFileSync(input.targetRef, original + 'conflicting data');
        await assert.rejects(engine.reconcileFork(input), /differs/);
        assert.equal(readFileSync(input.targetRef, 'utf8'), original + 'conflicting data');
      });
    }
    await assert.rejects(
      engine.fork({
        operationId: 'invalid-tool-point',
        directory,
        sourceRef,
        targetRef: engine.sessionPath('invalid'),
        entryId: before.find((message) => message.role === 'tool')!.id,
      }),
      /did not complete/,
    );
    assert.equal(readFileSync(sourceRef, 'utf8'), sourceBytes);
  },
);

test('session identity accepts directory aliases but rejects a different workspace', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-session-alias-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'workspace');
  mkdirSync(directory);
  mkdirSync(join(root, 'other'));
  symlinkSync(directory, join(root, 'alias'));
  const engine = createEngine({
    supervisor: createSupervisor(join(root, 'supervision')),
    sessionRoot: join(root, 'sessions'),
  });
  symlinkSync(join(root, 'sessions'), join(root, 'session-alias'));
  const path = engine.sessionPath('test');
  writeFileSync(
    path,
    JSON.stringify({ type: 'session', version: 3, cwd: directory, id: 'test' }) + '\n',
  );
  assert.equal(await engine.reconcileSession(path, join(root, 'alias')), true);
  assert.deepEqual(
    engine.readSession(join(root, 'session-alias/test.jsonl'), join(root, 'alias')),
    [],
  );
  await assert.rejects(engine.reconcileSession(path, join(root, 'other')), /does not match/);
});
