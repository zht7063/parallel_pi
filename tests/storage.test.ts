import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, createHandoffStore } from '@parallel-pi/infra-storage';
import type { Transaction, RunHandoff } from '@parallel-pi/application';

const storeModule = new URL('../packages/infra-storage/src/index.ts', import.meta.url).href;
test('SQLite atomically commits metadata/events, detaches snapshots and preserves restart cursors', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'parallel-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = openStore(directory);
  t.after(() => store.close());
  let lateWriter: Transaction | undefined;
  store.transaction((tx) => {
    tx.state.projects.push({
      id: 'p',
      repository: '/repo/.git',
      directory: '/repo',
      title: 'project',
      createdAt: 1,
    });
    tx.emit('project.added', { projectId: 'p' });
    lateWriter = tx;
  });
  assert.throws(() => lateWriter?.emit('late', {}), /no longer active/);
  const initial = store.snapshot();
  assert.equal(initial.cursor, 1);
  initial.state.projects.length = 0;
  assert.equal(store.snapshot().state.projects.length, 1);
  assert.throws(() =>
    store.transaction((tx) => {
      tx.state.projects.length = 0;
      tx.emit('must.rollback', {});
      throw new Error('injected disk/logic failure');
    }),
  );
  assert.equal(store.snapshot().cursor, 1);
  assert.equal(store.snapshot().state.projects.length, 1);
  assert.throws(() => store.transaction(() => store.transaction(() => {})), /Nested/);
  store.close();
  store = openStore(directory);
  assert.deepEqual(store.snapshot(), {
    ...initial,
    state: {
      ...initial.state,
      projects: [
        { id: 'p', repository: '/repo/.git', directory: '/repo', title: 'project', createdAt: 1 },
      ],
      lanes: [],
      operations: [],
    },
  });
  assert.deepEqual(
    store.events(0).map((event) => event.type),
    ['project.added'],
  );
  assert.deepEqual(store.events(1), []);
  assert.throws(() => store.events(-1));
});

test('instance ownership covers path aliases and a real second backend process', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'parallel-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = openStore(join(directory, 'data'));
  t.after(() => store.close());
  symlinkSync(join(directory, 'data'), join(directory, 'alias'));
  assert.throws(() => openStore(join(directory, 'alias')), /Another backend/);
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import { openStore, createHandoffStore } from ${JSON.stringify(storeModule)};
    try { openStore(process.argv[1]); process.exit(99); }
    catch (error) { process.exit(error.message.includes('Another backend') ? 0 : 98); }
  `,
    join(directory, 'data'),
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
});

test('SIGKILL during a real SQLite transaction retains the prior committed state and releases ownership', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'parallel-store-crash-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import { openStore, createHandoffStore } from ${JSON.stringify(storeModule)};
    const store = openStore(process.argv[1]);
    store.transaction(tx => tx.emit('committed', {}));
    store.transaction(tx => {
      tx.emit('uncommitted', {});
      process.kill(process.pid, 'SIGKILL');
    });
  `,
    directory,
  ]);
  assert.equal(result.signal, 'SIGKILL');
  const store = openStore(directory);
  t.after(() => store.close());
  assert.deepEqual(
    store.events(0).map((event) => event.type),
    ['committed'],
  );
});

test('immutable handoff publication replays exact content and preserves conflicting content', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'parallel-handoff-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const handoffs = createHandoffStore(directory);
  const content: RunHandoff = {
    version: 1,
    runId: 'run-1',
    sessionId: 'session-1',
    laneId: 'lane-1',
    ref: 'refs/heads/main',
    nativeSession: '/private/session.jsonl',
    request: 'task',
    attachmentIds: [],
    outcome: 'succeeded',
    error: null,
    endedAt: 1,
    observedAssistant: 'result',
    truncated: false,
    eventRange: { after: 0, through: 2 },
  };
  handoffs.put(content);
  handoffs.put(content);
  assert.throws(() => handoffs.put({ ...content, observedAssistant: 'conflict' }), /differs/);
  handoffs.put(content);
  assert.throws(() => handoffs.put({ ...content, runId: '../escape' }), /Invalid/);
});
