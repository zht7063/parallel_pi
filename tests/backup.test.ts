import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { openStore } from '@parallel-pi/infra-storage';

test('offline backup rejects live/unfinished state and preserves complete local data with verified corruption detection', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data'),
    agent = join(root, 'agent'),
    repo = join(root, 'repo');
  for (const path of [agent, join(repo, '.git'), join(repo, '.mwf'), join(data, 'sessions')])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(agent, 'auth.json'), '{"test-secret":"local-only"}');
  writeFileSync(join(repo, 'dirty.txt'), 'uncommitted content');
  writeFileSync(join(repo, '.mwf', 'memory.md'), 'original memory');
  writeFileSync(join(data, 'sessions', 'native.jsonl'), '{"type":"session"}\n');
  symlinkSync(data, join(root, 'data-alias'));
  let store = openStore(data);
  t.after(() => store.close());
  store.transaction((tx) => {
    tx.state.projects.push({
      id: 'p',
      title: 'backup',
      repository: join(repo, '.git'),
      directory: repo,
      createdAt: 1,
    });
    tx.state.sessions.push({
      id: 's',
      laneId: 'l',
      title: 'original',
      nativeRef: join(root, 'data-alias/sessions/native.jsonl'),
      state: 'ready',
      model: { provider: 'test', model: 'test' },
      createdAt: 1,
      messages: [],
    });
    tx.emit('backup.fixture', { original: true });
  });
  const run = (output: string) =>
    spawnSync(
      'python3',
      ['scripts/backup.py', 'create', output, '--data-dir', data, '--agent-dir', agent],
      { encoding: 'utf8' },
    );
  const output = join(root, 'backup');
  assert.match(run(output).stderr, /Stop the backend/);
  assert.equal(existsSync(output), false);
  store.transaction((tx) =>
    tx.state.operations.push({
      id: 'unresolved',
      laneId: 'l',
      kind: 'inspect-git',
      target: repo,
      state: 'uncertain',
      error: null,
      createdAt: 1,
    }),
  );
  store.close();
  assert.match(run(output).stderr, /Reconcile pending/);
  store = openStore(data);
  store.transaction((tx) => {
    tx.state.operations[0]!.state = 'completed';
  });
  store.close();
  store = openStore(data);
  store.transaction((tx) =>
    tx.state.runs.push({
      id: 'queued',
      requestId: 'queued',
      fingerprint: 'fixture',
      sessionId: 's',
      laneId: 'l',
      text: 'must not switch kernels silently',
      attachmentIds: [],
      model: { provider: 'test', model: 'test' },
      state: 'queued',
      sequence: 1,
      createdAt: 1,
      endedAt: null,
      error: null,
      question: null,
    }),
  );
  store.close();
  assert.match(run(output).stderr, /Finish\/cancel queued runs/);
  store = openStore(data);
  store.transaction((tx) => {
    tx.state.runs[0]!.state = 'cancelled';
  });
  store.close();
  store = openStore(data);
  store.transaction((tx) => {
    tx.state.runs[0]!.handoff = {
      state: 'failed',
      error: 'injected',
      content: {
        version: 1,
        runId: 'queued',
        sessionId: 's',
        laneId: 'l',
        ref: 'refs/heads/main',
        nativeSession: join(data, 'sessions/native.jsonl'),
        request: 'fixture',
        attachmentIds: [],
        outcome: 'cancelled',
        error: null,
        endedAt: 1,
        observedAssistant: '',
        truncated: false,
        eventRange: { after: 0, through: 1 },
      },
    };
  });
  store.close();
  assert.match(run(output).stderr, /Resolve pending handoff/);
  store = openStore(data);
  store.transaction((tx) => {
    tx.state.runs[0]!.handoff!.state = 'continued';
  });
  store.close();
  rmSync(join(data, 'sessions/native.jsonl'));
  assert.match(run(output).stderr, /Missing or external session/);
  writeFileSync(join(data, 'sessions/native.jsonl'), '{"type":"session"}\n');
  const external = join(root, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'resource'), 'external config');
  symlinkSync(external, join(agent, 'external'));
  assert.match(run(output).stderr, /External symlink target needs/);
  const result = spawnSync(
    'python3',
    [
      'scripts/backup.py',
      'create',
      output,
      '--data-dir',
      data,
      '--agent-dir',
      agent,
      '--include',
      external,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.complete, true);
  assert.deepEqual(manifest.requiredFiles, [join(data, 'sessions/native.jsonl').slice(1)]);
  assert.equal(statSync(output).mode & 0o777, 0o700);
  assert.equal(statSync(join(output, 'files.tar.gz')).mode & 0o777, 0o600);
  const extracted = join(root, 'extracted');
  mkdirSync(extracted);
  const extract = spawnSync('tar', ['-xzf', join(output, 'files.tar.gz'), '-C', extracted], {
    encoding: 'utf8',
  });
  assert.equal(extract.status, 0, extract.stderr);
  assert.equal(readFileSync(join(extracted, repo, 'dirty.txt'), 'utf8'), 'uncommitted content');
  assert.equal(readFileSync(join(extracted, repo, '.mwf/memory.md'), 'utf8'), 'original memory');
  assert.equal(
    readFileSync(join(extracted, agent, 'auth.json'), 'utf8'),
    '{"test-secret":"local-only"}',
  );
  const restored = openStore(join(extracted, data));
  assert.equal(restored.snapshot().state.projects[0]!.directory, repo);
  assert.equal(restored.events(0)[0]!.type, 'backup.fixture');
  restored.close();
  assert.notEqual(run(output).status, 0);
  assert.equal(existsSync(join(output, 'manifest.json')), true);
  writeFileSync(join(output, 'files.tar.gz'), 'corrupted');
  const bad = spawnSync('python3', ['scripts/backup.py', 'verify', output], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /checksum mismatch/);
});

test(
  'backup requires released supervision locks and persisted cleanup proof',
  { timeout: 15000 },
  async (t) => {
    const { createSupervisor } = await import('@parallel-pi/infra-platform');
    const root = mkdtempSync(join(tmpdir(), 'parallel-backup-worker-'));
    const data = join(root, 'data');
    const store = openStore(data);
    store.close();
    const supervisor = createSupervisor(join(data, 'supervision'));
    const worker = supervisor.start({
      id: 'backup-worker',
      directory: root,
      command: 'python3',
      args: ['-u', '-c', 'import time; print("ready"); time.sleep(60)'],
    });
    t.after(async () => {
      await worker.stop();
      await worker.completion;
      rmSync(root, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => worker.onOutput(() => resolve()));
    const run = () =>
      spawnSync(
        'python3',
        [
          'scripts/backup.py',
          'create',
          join(root, 'backup'),
          '--data-dir',
          data,
          '--agent-dir',
          join(root, 'absent-agent'),
        ],
        { encoding: 'utf8' },
      );
    assert.match(run().stderr, /supervised worker is still alive/);
    await worker.stop();
    assert.equal((await worker.completion).settled, true);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    rmSync(join(root, 'backup'), { recursive: true });
    rmSync(join(data, 'supervision', 'backup-worker', 'result.json'));
    assert.notEqual(run().status, 0);
    assert.equal(existsSync(join(root, 'backup')), false);
  },
);
