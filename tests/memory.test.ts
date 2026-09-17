import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSupervisor } from '@parallel-pi/infra-platform';
import { createMemoryAccess } from '@parallel-pi/infra-mwf';

test(
  'native memory inspection, policy preservation and revision changes share recoverable receipts',
  { timeout: 30000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'parallel-memory-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const directory = join(root, 'project');
    mkdirSync(directory);
    const memory = createMemoryAccess(
      createSupervisor(join(root, 'supervision')),
      join(root, 'inputs'),
    );
    const context = () => ({ directory, operationId: randomUUID() });
    assert.equal((await memory.inspect(context())).initialized, false);
    assert.equal(existsSync(join(directory, '.mwf')), false, 'reading does not initialize');
    const initId = randomUUID();
    assert.equal(
      (
        await memory.modify({
          ...context(),
          requestId: initId,
          change: { kind: 'init', gitMode: 'ignore' },
        })
      ).gitMode,
      'ignore',
    );
    assert.equal(
      (
        await memory.modify({
          ...context(),
          requestId: initId,
          change: { kind: 'init', gitMode: 'ignore' },
        })
      ).replayed,
      true,
    );
    assert.equal(
      (
        await memory.modify({
          ...context(),
          requestId: randomUUID(),
          change: { kind: 'init', gitMode: 'track' },
        })
      ).gitMode,
      'ignore',
      'existing ignore policy survives init',
    );
    assert.match(readFileSync(join(directory, '.gitignore'), 'utf8'), /\.mwf/);
    const added = await memory.add({
      ...context(),
      requestId: randomUUID(),
      source: { sessionId: 'test-session' },
      content: {
        type: 'knowledge',
        title: 'Build rules',
        summary: 'Keep build inputs',
        body: 'Original content',
        candidate: true,
        scope: { paths: ['src/**'] },
      },
    });
    const listed = await memory.inspect({ ...context(), recordId: added.id });
    assert.equal(listed.records[0]?.status, 'candidate');
    assert.equal(listed.record?.body.startsWith('Original content'), true);
    assert.match(listed.record!.body, /test-session/);
    assert.deepEqual(listed.record?.statuses, ['candidate', 'stable', 'deprecated']);
    const candidateRecall = await memory.inspect({ ...context(), query: { path: 'src/main.ts' } });
    assert.equal(
      candidateRecall.records[0]?.status,
      'candidate',
      'native recall keeps candidate status explicit',
    );
    const requestId = randomUUID();
    const change = {
      kind: 'update' as const,
      id: added.id,
      revision: listed.record!.revision,
      status: 'stable',
      summary: 'Confirmed build inputs',
      body: 'Verified content\n\n## 来源\n\nConfirmed from test-session',
      scope: { paths: ['src/**'] },
    };
    const corrected = await memory.modify({ ...context(), requestId, change });
    assert.equal(corrected.replayed, false);
    assert.notEqual(corrected.revision, change.revision);
    assert.equal(
      (await memory.modify({ ...context(), requestId, change })).replayed,
      true,
      'lost confirmation replays receipt before checking old revision',
    );
    const recalled = await memory.inspect({
      ...context(),
      query: { path: 'src/main.ts' },
      recordId: added.id,
    });
    assert.equal(recalled.total, 1);
    assert.deepEqual(recalled.records[0]?.reasons, ['path:src/**']);
    assert.deepEqual(recalled.record?.scope.paths, ['src/**']);
    await assert.rejects(
      memory.modify({ ...context(), requestId: randomUUID(), change }),
      /changed|REVISION_CONFLICT/,
    );
    await assert.rejects(
      memory.modify({
        ...context(),
        requestId,
        change: { ...change, summary: 'Different intent' },
      }),
      /IDEMPOTENCY_CONFLICT/,
    );
    const next = { ...change, revision: recalled.record!.revision, status: 'deprecated' };
    const concurrent = await Promise.allSettled([
      memory.modify({ ...context(), requestId: randomUUID(), change: next }),
      memory.modify({
        ...context(),
        requestId: randomUUID(),
        change: { ...next, summary: 'Concurrent edit' },
      }),
    ]);
    assert.equal(concurrent.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(
      (await memory.inspect({ ...context(), query: { path: 'src/main.ts' } })).total,
      0,
      'invalidated memory is no longer recalled',
    );
    const privateLocal = join(directory, '.mwf/local/private.md');
    writeFileSync(privateLocal, 'private local material');
    const final = await memory.inspect(context());
    assert.doesNotMatch(JSON.stringify(final), /private local material/);
    assert.equal(final.records.length, 1);
    const other = join(root, 'other-worktree');
    mkdirSync(other);
    assert.equal(
      (await memory.inspect({ directory: other, operationId: randomUUID() })).initialized,
      false,
    );
    assert.equal(existsSync(join(other, '.mwf')), false);
    const configPath = join(directory, '.mwf/config.json');
    const invalid = JSON.stringify({
      ...JSON.parse(readFileSync(configPath, 'utf8')),
      git_mode: 'invalid-policy',
    });
    writeFileSync(configPath, invalid);
    await assert.rejects(memory.inspect(context()), /INVALID_CONFIG/);
    assert.equal(
      readFileSync(configPath, 'utf8'),
      invalid,
      'invalid policy is reported without rewriting it',
    );
  },
);
