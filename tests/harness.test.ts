import { createMemoryAccess } from '@parallel-pi/infra-mwf';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarness } from '@parallel-pi/application';
import { openStore, createAttachmentStore, createHandoffStore } from '@parallel-pi/infra-storage';
import { createGit } from '@parallel-pi/infra-git';
import { createSupervisor } from '@parallel-pi/infra-platform';
import { createEngine } from '@parallel-pi/infra-pi';
import type { Harness } from '@parallel-pi/application';

const fixture = fileURLToPath(new URL('../probes/fixture-extension.mjs', import.meta.url));
async function until(predicate: () => boolean, description: string) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${description}`);
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'parallel-harness-'));
  const directory = join(root, 'repository');
  mkdirSync(directory);
  const gitCommand = (...args: string[]) =>
    execFileSync('git', ['-C', directory, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  gitCommand('init', '-b', 'main');
  gitCommand('config', 'user.name', 'Test');
  gitCommand('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(directory, 'code'), 'committed');
  gitCommand('add', '.');
  gitCommand('commit', '-m', 'initial');
  gitCommand('branch', 'other');
  writeFileSync(join(directory, 'code'), 'dirty');
  const store = openStore(join(root, 'data'));
  const supervisor = createSupervisor(join(root, 'supervision'));
  const engine = createEngine({
    supervisor,
    sessionRoot: join(root, 'sessions'),
    agentDirectory: join(root, 'agent'),
    extraArgs: ['--no-extensions', '--no-skills', '--no-prompt-templates', '-e', fixture],
  });
  const deps = {
    store,
    supervisor,
    engine,
    memory: createMemoryAccess(supervisor, join(root, 'memory-inputs')),
    handoffs: createHandoffStore(join(root, 'handoffs')),
    attachments: createAttachmentStore(join(root, 'attachments')),
    git: createGit(supervisor),
    runtime: {
      id: randomUUID,
      now: Date.now,
      worktreePath: (id: string) => join(root, 'worktrees', id),
    },
  };
  const app = createHarness(deps);
  return { root, directory, store, app, deps };
}
function state(app: Harness, id: string) {
  return app.snapshot().state.runs.find((run) => run.id === id)!;
}
const model = { provider: 'parallel-probe', model: 'probe-a' };

test(
  'application persists a real pi run, image and events without duplicate sends, and deduplicates project aliases',
  { timeout: 30000 },
  async (t) => {
    const { root, directory, app, store } = setup();
    t.after(async () => {
      await app.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await app.initialize();
    const project = await app.addProject(directory);
    symlinkSync(directory, join(root, 'alias'));
    assert.equal((await app.addProject(join(root, 'alias'))).id, project.id);
    const branch = app.snapshot().state.lanes.find((lane) => lane.ref === 'refs/heads/main')!;
    const session = await app.createSession(branch.id, 'First session', model);
    const attachment = app.upload({
      mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=',
    });
    const savedDraft = app.saveDraft(session.id, 0, 'first draft', []);
    assert.equal(savedDraft.revision, 1);
    assert.throws(() => app.saveDraft(session.id, 0, 'stale overwrite', []), /Draft conflict/);
    assert.equal(
      app.snapshot().state.drafts.find((draft) => draft.sessionId === session.id)?.text,
      'first draft',
    );
    const input = {
      requestId: 'one',
      sessionId: session.id,
      text: 'hello image',
      attachmentIds: [attachment.id],
    };
    const run = app.enqueue(input);
    assert.equal(app.enqueue(input).id, run.id);
    assert.throws(() => app.enqueue({ ...input, text: 'changed' }), /different content/);
    app.setSessionModel(session.id, { ...model, model: 'probe-b' });
    assert.equal(state(app, run.id).model.model, 'probe-a');
    await until(
      () => state(app, run.id).state === 'succeeded',
      JSON.stringify(app.snapshot().state.runs),
    );
    const messages = app.snapshot().state.sessions.find((item) => item.id === session.id)!.messages;
    assert.equal(messages.filter((message) => message.role === 'user').length, 1);
    assert.equal(messages[0]?.images.length, 1);
    assert.equal(readFileSync(join(directory, 'code'), 'utf8'), 'dirty');
    const cursor = app.snapshot().cursor;
    assert.ok(app.events(0).length > 0);
    assert.deepEqual(app.events(cursor), []);
  },
);

test(
  'same branch stays serial, other branch runs concurrently, stop pauses queue and explicit resume continues it',
  { timeout: 30000 },
  async (t) => {
    const { root, directory, app, store } = setup();
    t.after(async () => {
      await app.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await app.initialize();
    await app.addProject(directory);
    const main = app.snapshot().state.lanes.find((lane) => lane.ref === 'refs/heads/main')!;
    const other = app.snapshot().state.lanes.find((lane) => lane.ref === 'refs/heads/other')!;
    const a = await app.createSession(main.id, 'A', model);
    const b = await app.createSession(other.id, 'B', model);
    const slow = app.enqueue({
      requestId: 'slow',
      sessionId: a.id,
      text: 'probe-slow-tool',
      attachmentIds: [],
    });
    const queued = app.enqueue({
      requestId: 'queued',
      sessionId: a.id,
      text: 'next',
      attachmentIds: [],
    });
    const parallel = app.enqueue({
      requestId: 'parallel',
      sessionId: b.id,
      text: 'other branch',
      attachmentIds: [],
    });
    await until(
      () =>
        state(app, parallel.id).state === 'succeeded' && state(app, slow.id).state === 'running',
      'parallel execution',
    );
    assert.equal(state(app, queued.id).state, 'queued');
    await app.stop(slow.id);
    assert.equal(state(app, slow.id).state, 'cancelled');
    assert.equal(app.snapshot().state.lanes.find((lane) => lane.id === main.id)!.state, 'paused');
    assert.equal(state(app, queued.id).state, 'queued');
    await app.resume(main.id);
    await until(() => state(app, queued.id).state === 'succeeded', 'resumed queue');
    assert.equal(readFileSync(join(directory, 'code'), 'utf8'), 'dirty');
    assert.equal(
      readFileSync(
        join(app.snapshot().state.lanes.find((lane) => lane.id === other.id)!.directory!, 'code'),
        'utf8',
      ),
      'committed',
    );
  },
);

test(
  'waiting input retains capacity and a restart reconciles native session intent without replay',
  { timeout: 30000 },
  async (t) => {
    const { root, directory, app, store, deps } = setup();
    let current = app;
    t.after(async () => {
      await current.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await app.initialize();
    await app.addProject(directory);
    const main = app.snapshot().state.lanes.find((lane) => lane.ref === 'refs/heads/main')!;
    const session = await app.createSession(main.id, 'Question', model);
    const run = app.enqueue({
      requestId: 'question',
      sessionId: session.id,
      text: 'probe-question-tool',
      attachmentIds: [],
    });
    await until(() => state(app, run.id).state === 'waiting_input', 'question');
    assert.ok(state(app, run.id).question);
    app.answer(run.id, state(app, run.id).question!.id, 'continue');
    await until(() => state(app, run.id).state === 'succeeded', 'answered execution');
    await app.close();
    const messages = app.snapshot().state.sessions[0]!.messages;
    store.transaction((tx) => {
      tx.state.operations[0]!.state = 'pending';
      tx.state.sessions[0]!.state = 'creating';
    });
    current = createHarness(deps);
    await current.initialize();
    assert.equal(current.snapshot().state.sessions[0]!.state, 'ready');
    assert.equal(
      current.snapshot().state.lanes.find((lane) => lane.id === main.id)!.state,
      'paused',
    );
    assert.deepEqual(current.snapshot().state.sessions[0]!.messages, messages);
    assert.equal(current.snapshot().state.runs.length, 1);
  },
);

test(
  'handoff failure pauses the lane, restart retries only storage, and explicit continuation is durable',
  { timeout: 30000 },
  async (t) => {
    const { root, directory, app, store, deps } = setup();
    let current = app;
    t.after(async () => {
      await current.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await app.initialize();
    await app.addProject(directory);
    const lane = app.snapshot().state.lanes[0]!;
    const session = await app.createSession(lane.id, 'Handoff', model);
    writeFileSync(join(root, 'handoffs'), 'blocks the record directory');
    const run = app.enqueue({
      requestId: 'save-fails',
      sessionId: session.id,
      text: 'preserve my outcome',
      attachmentIds: [],
    });
    const queued = app.enqueue({
      requestId: 'waiting-save',
      sessionId: session.id,
      text: 'only after resume',
      attachmentIds: [],
    });
    await until(() => state(app, run.id).handoff?.state === 'failed', 'failed save');
    assert.equal(state(app, run.id).state, 'succeeded');
    assert.equal(state(app, queued.id).state, 'queued');
    assert.equal(app.snapshot().state.lanes[0]!.state, 'paused');
    await assert.rejects(app.resume(lane.id), /pending handoff/);
    const content = state(app, run.id).handoff!.content;
    assert.ok(content.observedAssistant.includes('preserve my outcome'));
    await app.close();
    rmSync(join(root, 'handoffs'));
    // Reproduce the publication/ack crash window: the file exists but SQLite still says failed.
    deps.handoffs.put(content);
    const path = join(root, 'handoffs', `${run.id}.json`);
    const before = readFileSync(path, 'utf8');
    current = createHarness(deps);
    await current.initialize();
    assert.equal(state(current, run.id).handoff!.state, 'failed');
    await current.retryHandoff(run.id);
    await current.retryHandoff(run.id);
    assert.equal(state(current, run.id).handoff!.state, 'saved');
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(
      current.snapshot().state.sessions[0]!.messages.filter((m) => m.role === 'user').length,
      1,
    );
    // A conflicting file is preserved; the failed content stays in the persisted save intent.
    rmSync(join(root, 'handoffs'), { recursive: true });
    writeFileSync(join(root, 'handoffs'), 'fail again');
    await current.resume(lane.id);
    await until(() => state(current, queued.id).handoff?.state === 'failed', 'second failed save');
    await current.continueWithoutHandoff(queued.id);
    assert.equal(state(current, queued.id).handoff!.state, 'continued');
    assert.equal(state(current, queued.id).state, 'succeeded');
    await current.resume(lane.id);
    assert.equal(current.snapshot().state.lanes[0]!.state, 'ready');
    assert.equal(current.events(0).filter((e) => e.type === 'handoff.continued').length, 1);
  },
);

test(
  'native MWF failures pause the lane and retry the same receipt across restart without rerunning pi',
  { timeout: 30000 },
  async (t) => {
    const { root, directory, app, store, deps } = setup();
    let current = app;
    t.after(async () => {
      await current.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await app.initialize();
    await app.addProject(directory);
    const lane = app.snapshot().state.lanes[0]!;
    const session = await app.createSession(lane.id, 'Memory source', model);
    const input = {
      requestId: 'remember-one',
      sessionId: session.id,
      content: {
        type: 'knowledge' as const,
        title: 'Verified fixture',
        summary: 'Use the existing fixture',
        body: 'This test verifies native save replay, not model reasoning.',
        candidate: false,
        scope: { paths: ['code'] },
      },
    };
    const failed = await app.saveMemory(input);
    assert.equal(failed.state, 'failed');
    assert.equal(app.snapshot().state.lanes[0]!.state, 'paused');
    await assert.rejects(app.resume(lane.id), /pending memory/);
    assert.equal((await app.saveMemory(input)).id, failed.id);
    await assert.rejects(
      app.saveMemory({ ...input, content: { ...input.content, summary: 'changed' } }),
      /conflicts/,
    );
    // Explicit native initialization only in this disposable test repository.
    const cli = fileURLToPath(
      new URL('../probes/.cache/mwf-source/packages/mwf/dist/cli.js', import.meta.url),
    );
    execFileSync(process.execPath, [cli, 'init', '--root', directory, '--git-mode', 'ignore']);
    const saved = await app.retryMemory(failed.id);
    assert.equal(saved.state, 'saved');
    assert.equal(saved.receipt!.replayed, false);
    const recordPath = join(directory, saved.receipt!.path);
    const body = readFileSync(recordPath, 'utf8');
    assert.ok(body.includes(session.id));
    await app.close();
    // Native commit completed but the application acknowledgement was lost.
    store.transaction((tx) => {
      const operation = tx.state.operations
        .filter((item) => item.memorySaveId === failed.id)
        .at(-1)!;
      operation.state = 'pending';
      tx.state.memorySaves[0]!.state = 'pending';
      tx.state.memorySaves[0]!.receipt = null;
    });
    current = createHarness(deps);
    await current.initialize();
    assert.equal(current.snapshot().state.memorySaves[0]!.state, 'failed');
    const replayed = await current.retryMemory(failed.id);
    assert.equal(replayed.state, 'saved');
    assert.equal(replayed.receipt!.id, saved.receipt!.id);
    assert.equal(replayed.receipt!.replayed, true);
    assert.equal(readFileSync(recordPath, 'utf8'), body);
    assert.equal(current.snapshot().state.runs.length, 0);
    await current.resume(lane.id);
    const candidate = await current.saveMemory({
      ...input,
      requestId: 'candidate',
      content: { ...input.content, title: 'Unverified assumption', candidate: true },
    });
    assert.equal(candidate.receipt!.status, 'candidate');
    assert.match(candidate.receipt!.path, /candidates/);
    assert.equal(
      JSON.parse(readFileSync(join(directory, '.mwf/config.json'), 'utf8')).git_mode,
      'ignore',
    );
    // A second worktree must not inherit untracked knowledge or silently initialize memory.
    const other = current.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/other')!;
    const otherSession = await current.createSession(other.id, 'Other', model);
    const otherSave = await current.saveMemory({
      ...input,
      requestId: 'other-memory',
      sessionId: otherSession.id,
    });
    assert.equal(otherSave.state, 'failed');
    await current.continueWithoutMemory(otherSave.id);
    await current.resume(other.id);
    assert.equal(
      current.snapshot().state.memorySaves.find((item) => item.id === otherSave.id)!.state,
      'continued',
    );
  },
);

test(
  'stopping a real extension question clears the wait and pauses the next run until explicit resume',
  { timeout: 30000 },
  async (t) => {
    const { root, directory, app, store } = setup();
    t.after(async () => {
      await app.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await app.initialize();
    await app.addProject(directory);
    const lane = app.snapshot().state.lanes[0]!;
    const session = await app.createSession(lane.id, 'Stop question', model);
    const run = app.enqueue({
      requestId: 'stop-question',
      sessionId: session.id,
      text: 'probe-question-tool',
      attachmentIds: [],
    });
    const next = app.enqueue({
      requestId: 'after-question',
      sessionId: session.id,
      text: 'only after explicit resume',
      attachmentIds: [],
    });
    await until(() => state(app, run.id).state === 'waiting_input', 'question waiting');
    const questionId = state(app, run.id).question!.id;
    await app.stop(run.id);
    assert.equal(state(app, run.id).state, 'cancelled');
    assert.equal(state(app, run.id).question, null);
    assert.equal(state(app, next.id).state, 'queued');
    assert.equal(app.snapshot().state.lanes[0]!.state, 'paused');
    assert.throws(() => app.answer(run.id, questionId, 'late answer'), /no longer waiting/);
    await app.resume(lane.id);
    await until(() => state(app, next.id).state === 'succeeded', 'next run after stopped question');
  },
);
