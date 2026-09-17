import { createMemoryAccess } from '@parallel-pi/infra-mwf';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarness } from '@parallel-pi/application';
import { openStore, createAttachmentStore, createHandoffStore } from '@parallel-pi/infra-storage';
import { createGit } from '@parallel-pi/infra-git';
import { createSupervisor } from '@parallel-pi/infra-platform';
import { createEngine, createConfigurationAccess } from '@parallel-pi/infra-pi';
import type { Harness, ImageInput } from '@parallel-pi/application';

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
    configuration: createConfigurationAccess(join(root, 'agent')),
    store,
    supervisor,
    engine,
    memory: createMemoryAccess(supervisor, join(root, 'memory-inputs')),
    handoffs: createHandoffStore(join(root, 'handoffs')),
    attachments: createAttachmentStore(join(root, 'attachments')),
    git: createGit(supervisor, join(root, 'git-transactions')),
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
      tx.state.operations.find((item) => item.kind === 'create-session')!.state = 'pending';
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
    // Initialization must remain available to repair a failed save to an uninitialized workspace.
    const initialized = await app.changeMemory({
      laneId: lane.id,
      requestId: 'repair-missing-memory',
      change: { kind: 'init', gitMode: 'ignore' },
    });
    assert.equal(initialized.state, 'saved');
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

test(
  'continuation keeps a stable path and source relation but starts empty, including creation recovery and changed-model retries',
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
    const lane = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/main')!;
    const parent = await app.createSession(lane.id, 'Parent', model, 'parent-create');
    const run = app.enqueue({
      requestId: 'parent-prompt',
      sessionId: parent.id,
      text: 'parent-only-context',
      attachmentIds: [],
    });
    await until(() => state(app, run.id).state === 'succeeded', 'parent result');
    app.setSessionModel(parent.id, { ...model, model: 'probe-b' });
    assert.equal(
      (await app.createSession(lane.id, 'Parent', model, 'parent-create')).id,
      parent.id,
    );
    await assert.rejects(
      app.createSession(lane.id, 'Parent', { ...model, model: 'probe-b' }, 'parent-create'),
      /conflicts/,
    );
    const child = await app.createSession(
      lane.id,
      'Continuation',
      model,
      'continue-create',
      parent.id,
    );
    assert.deepEqual(child.origin, { kind: 'continue', sessionId: parent.id });
    assert.equal(child.pathId, parent.pathId);
    assert.deepEqual(child.messages, []);
    assert.equal(app.snapshot().state.runs.length, 1);
    const independent = await app.createSession(lane.id, 'Independent', model, 'root-create');
    assert.notEqual(independent.pathId, child.pathId);
    assert.equal(independent.origin, undefined);
    const other = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/other')!;
    await assert.rejects(
      app.createSession(
        other.id,
        'Invalid cross-branch continuation',
        model,
        'invalid-continue',
        parent.id,
      ),
      /same Git branch/,
    );
    await app.close();
    store.transaction((tx) => {
      tx.state.operations.find((operation) => operation.sessionId === child.id)!.state = 'pending';
      tx.state.sessions.find((session) => session.id === child.id)!.state = 'creating';
    });
    current = createHarness(deps);
    await current.initialize();
    const recovered = current.snapshot().state.sessions.find((session) => session.id === child.id)!;
    assert.equal(recovered.state, 'ready');
    assert.deepEqual(recovered.origin, child.origin);
    assert.equal(recovered.pathId, parent.pathId);
    assert.equal(
      (await current.createSession(lane.id, 'Continuation', model, 'continue-create', parent.id))
        .id,
      child.id,
    );
    await current.resume(lane.id);
    const next = current.enqueue({
      requestId: 'child-prompt',
      sessionId: child.id,
      text: 'new empty context',
      attachmentIds: [],
    });
    await until(() => state(current, next.id).state === 'succeeded', 'continued session result');
    const messages = current
      .snapshot()
      .state.sessions.find((session) => session.id === child.id)!.messages;
    assert.equal(messages.filter((message) => message.role === 'user').length, 1);
    assert.equal(JSON.stringify(messages).includes('parent-only-context'), false);
    assert.equal(readFileSync(join(directory, 'code'), 'utf8'), 'dirty');
  },
);

test(
  'branch intentions preserve dirty work, fetch selected remote tips, retain stale caches and reconcile completed writes',
  { timeout: 30000 },
  async (t) => {
    const { root, directory, app, store, deps } = setup();
    let current = app;
    t.after(async () => {
      await current.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', directory, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const remote = join(root, 'remote.git');
    execFileSync('git', ['clone', '--bare', directory, remote], { stdio: 'pipe' });
    const remoteGit = (...args: string[]) =>
      execFileSync('git', ['-C', remote, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    remoteGit('update-ref', 'refs/heads/topic', git('rev-parse', 'HEAD'));
    git('remote', 'add', 'origin', remote);
    await app.initialize();
    const project = await app.addProject(directory);
    const lane = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/main')!;
    const input = {
      requestId: 'new-branch',
      laneId: lane.id,
      name: 'bad name',
      startRef: lane.ref,
      track: false,
    };
    const writes = () =>
      app.snapshot().state.operations.filter((item) => item.kind !== 'inspect-repository').length;
    const count = writes();
    await assert.rejects(app.createBranch(input));
    assert.equal(writes(), count);
    const created = await app.createBranch({ ...input, name: 'feature' });
    assert.equal(created.ref, 'refs/heads/feature');
    assert.deepEqual(await app.createBranch({ ...input, name: 'feature' }), created);
    await assert.rejects(app.createBranch({ ...input, name: 'different' }), /conflicts/);
    assert.equal(
      app.snapshot().state.lanes.find((item) => item.ref === created.ref)!.directory,
      null,
    );
    assert.equal(readFileSync(join(directory, 'code'), 'utf8'), 'dirty');
    assert.equal(git('symbolic-ref', 'HEAD'), lane.ref);
    await app.refreshRemotes(lane.id);
    assert.ok(
      app
        .snapshot()
        .state.projects[0]!.remoteBranches!.some(
          (branch) => branch.ref === 'refs/remotes/origin/topic',
        ),
    );
    const tree = remoteGit('rev-parse', 'HEAD^{tree}');
    const old = remoteGit('rev-parse', 'refs/heads/topic');
    const tip = remoteGit(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit-tree',
      tree,
      '-p',
      old,
      '-m',
      'remote advance',
    );
    remoteGit('update-ref', 'refs/heads/topic', tip);
    await app.createBranch({
      requestId: 'import-topic',
      laneId: lane.id,
      name: 'local-topic',
      startRef: 'refs/remotes/origin/topic',
      track: true,
    });
    assert.equal(git('rev-parse', 'refs/heads/local-topic'), tip);
    assert.equal(
      git('for-each-ref', '--format=%(upstream)', 'refs/heads/local-topic'),
      'refs/remotes/origin/topic',
    );
    assert.equal(
      app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/local-topic')!.upstream,
      'refs/remotes/origin/topic',
    );
    const cache = app.snapshot().state.projects[0]!.remoteBranches;
    git('remote', 'set-url', 'origin', join(root, 'missing.git'));
    await assert.rejects(app.refreshRemotes(lane.id));
    assert.deepEqual(app.snapshot().state.projects[0]!.remoteBranches, cache);
    assert.ok(app.snapshot().state.projects[0]!.remoteError);
    assert.equal(app.snapshot().state.lanes.find((item) => item.id === lane.id)!.state, 'ready');
    await app.close();
    store.transaction((tx) => {
      tx.state.operations.find((operation) => operation.requestId === 'new-branch')!.state =
        'pending';
      tx.state.lanes = tx.state.lanes.filter((item) => item.ref !== created.ref);
    });
    current = createHarness(deps);
    await current.initialize();
    assert.equal(
      current.snapshot().state.lanes.filter((item) => item.ref === created.ref).length,
      1,
    );
    assert.equal(
      current.snapshot().state.operations.find((operation) => operation.requestId === 'new-branch')!
        .state,
      'completed',
    );
    assert.equal(
      current.snapshot().state.lanes.find((item) => item.id === lane.id)!.state,
      'paused',
    );
    assert.equal(current.snapshot().state.projects[0]!.id, project.id);
    assert.equal(readFileSync(join(directory, 'code'), 'utf8'), 'dirty');
  },
);

test(
  'fork uses an immutable native point, keeps image drafts unexecuted and reconciles a lost confirmation',
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
    const lane = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/main')!;
    const source = await app.createSession(lane.id, 'Source', model);
    const image: ImageInput = {
      mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=',
    };
    const attachment = app.upload(image);
    for (const text of ['first image', 'second point']) {
      const run = app.enqueue({
        sessionId: source.id,
        requestId: text.replaceAll(' ', '-'),
        text,
        attachmentIds: [attachment.id],
      });
      await until(() => state(app, run.id).state === 'succeeded', text);
    }
    const messages = app.snapshot().state.sessions.find((item) => item.id === source.id)!.messages;
    const first = messages.find((item) => item.role === 'user')!;
    const second = messages.filter((item) => item.role === 'user')[1]!;
    app.setSessionModel(source.id, { ...model, model: 'probe-b' });
    const child = await app.forkSession(source.id, first.id, 'First fork', 'fork-first');
    assert.deepEqual(child.messages, []);
    assert.notEqual(child.pathId, source.pathId);
    assert.deepEqual(child.origin, { kind: 'fork', sessionId: source.id, entryId: first.id });
    assert.equal(child.model.model, 'probe-b');
    assert.equal(
      (await app.forkSession(source.id, first.id, 'First fork', 'fork-first')).id,
      child.id,
    );
    await assert.rejects(
      app.forkSession(source.id, second.id, 'First fork', 'fork-first'),
      /conflicts/,
    );
    await assert.rejects(
      app.forkSession(
        source.id,
        messages.find((item) => item.role === 'assistant')!.id,
        '',
        'invalid',
      ),
      /fork point/,
    );
    const draft = app.snapshot().state.drafts.find((item) => item.sessionId === child.id)!;
    assert.equal(draft.text, first.text);
    assert.deepEqual(app.attachment(draft.attachmentIds[0]!), image);
    assert.equal(app.snapshot().state.runs.length, 2);
    await app.close();
    current = createHarness({
      ...deps,
      engine: {
        ...deps.engine,
        async fork(input) {
          await deps.engine.fork(input);
          throw new Error('injected lost application confirmation');
        },
      },
    });
    await current.initialize();
    await assert.rejects(
      current.forkSession(source.id, second.id, 'Recovered fork', 'fork-second'),
      /lost application/,
    );
    const pending = current
      .snapshot()
      .state.sessions.find((item) => item.creationRequestId === 'fork-second')!;
    assert.equal(pending.state, 'creating');
    assert.equal(
      current.snapshot().state.lanes.find((item) => item.id === lane.id)!.state,
      'recovering',
    );
    await current.close();
    current = createHarness(deps);
    await current.initialize();
    const restored = current.snapshot().state.sessions.find((item) => item.id === pending.id)!;
    assert.equal(restored.state, 'ready');
    assert.deepEqual(
      restored.messages,
      messages.slice(
        0,
        messages.findIndex((item) => item.id === second.id),
      ),
    );
    assert.equal(current.snapshot().state.runs.length, 2);
    assert.equal(
      current.snapshot().state.lanes.find((item) => item.id === lane.id)!.state,
      'paused',
    );
    assert.equal(
      current.snapshot().state.drafts.filter((item) => item.sessionId === restored.id).length,
      1,
    );
    await current.resume(lane.id);
    const next = current.enqueue({
      sessionId: restored.id,
      requestId: 'child-run',
      text: 'child next',
      attachmentIds: [],
    });
    await until(() => state(current, next.id).state === 'succeeded', 'fork child execution');
    const childMessages = current
      .snapshot()
      .state.sessions.find((item) => item.id === restored.id)!.messages;
    assert.ok(!childMessages.some((item) => item.role === 'user' && item.id === second.id));
    assert.deepEqual(
      current.snapshot().state.sessions.find((item) => item.id === source.id)!.messages,
      messages,
    );
    assert.equal(readFileSync(join(directory, 'code'), 'utf8'), 'dirty');
  },
);

test('history pages keep stable entry cursors when newer messages arrive and snapshots contain only the recent page', async (t) => {
  const { root, directory, app, store } = setup();
  t.after(async () => {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await app.initialize();
  await app.addProject(directory);
  const lane = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/main')!;
  const session = await app.createSession(lane.id, 'Paged cache', model);
  // Application-cache fixture: native history/fork compatibility has separate real-engine coverage.
  const messages = Array.from({ length: 95 }, (_, index) => ({
    id: `entry-${index}`,
    role: 'user' as const,
    text: `message ${index}`,
    images: [],
    forkable: true,
  }));
  store.transaction((tx) => {
    tx.state.sessions.find((item) => item.id === session.id)!.messages = messages;
  });
  const recent = app.history(session.id);
  assert.equal(recent.messages.length, 40);
  assert.equal(recent.messages[0]!.id, 'entry-55');
  store.transaction((tx) => {
    tx.state.sessions
      .find((item) => item.id === session.id)!
      .messages.push({ ...messages[0]!, id: 'new-entry' });
  });
  const older = app.history(session.id, recent.messages[0]!.id);
  assert.deepEqual(
    older.messages.map((message) => message.id),
    messages.slice(15, 55).map((message) => message.id),
  );
  assert.equal(older.total, 96);
  const first = app.history(session.id, older.messages[0]!.id);
  assert.equal(first.messages.length, 15);
  assert.equal(first.more, false);
  assert.throws(() => app.history(session.id, 'unknown'), /cursor/);
  assert.throws(() => app.history(session.id, undefined, 101), /page size/);
  const { projectSnapshot } = await import('../packages/transport/src/workspace.ts');
  const wire = projectSnapshot(app).sessions.find((item) => item.id === session.id)!;
  assert.equal(wire.messageCount, 96);
  assert.equal(wire.messages.length, 40);
  assert.equal(wire.messages.at(-1)!.id, 'new-entry');
});

test(
  'native configuration inspections hold the branch, persist recovery intent and shutdown waits for explicit recovery',
  { timeout: 20000 },
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
    const lane = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/main')!;
    const inspection = app.projectConfiguration(lane.id);
    await assert.rejects(app.createSession(lane.id, 'must wait', model), /occupied/);
    await inspection;
    const operation = app
      .snapshot()
      .state.operations.find((item) => item.kind === 'inspect-config')!;
    assert.equal(operation.state, 'completed');
    assert.equal(app.snapshot().state.sessions.length, 0);
    assert.equal(app.snapshot().state.runs.length, 0);
    // A published result with a lost app confirmation must not reload extensions on restart.
    store.transaction((tx) => {
      tx.state.operations.find((item) => item.id === operation.id)!.state = 'pending';
    });
    await app.close();
    let inspections = 0;
    current = createHarness({
      ...deps,
      engine: {
        ...deps.engine,
        inspectConfiguration: async (input) => {
          inspections++;
          return deps.engine.inspectConfiguration(input);
        },
      },
    });
    await current.initialize();
    assert.equal(inspections, 0);
    assert.equal(
      current.snapshot().state.operations.find((item) => item.id === operation.id)!.state,
      'failed',
    );
    assert.equal(
      current.snapshot().state.lanes.find((item) => item.id === lane.id)!.state,
      'paused',
    );
    mkdirSync(join(directory, '.pi'));
    writeFileSync(join(directory, '.pi/settings.json'), '{broken');
    await assert.rejects(current.projectConfiguration(lane.id), /configuration is invalid/);
    assert.equal(
      current.snapshot().state.lanes.find((item) => item.id === lane.id)!.state,
      'paused',
    );
    writeFileSync(join(directory, '.pi/settings.json'), '{}');
    await current.projectConfiguration(lane.id);
    assert.equal(
      current.snapshot().state.lanes.find((item) => item.id === lane.id)!.state,
      'paused',
    );
    await current.close();
    let release!: (value: { settled: boolean; exitCode: number | null; reason: string }) => void;
    const proof = new Promise<{ settled: boolean; exitCode: number | null; reason: string }>(
      (resolve) => {
        release = resolve;
      },
    );
    current = createHarness({
      ...deps,
      supervisor: {
        ...deps.supervisor,
        recover: (id) => (id === operation.id ? proof : deps.supervisor.recover(id)),
      },
    });
    await current.initialize();
    store.transaction((tx) => {
      tx.state.operations.find((item) => item.id === operation.id)!.state = 'pending';
    });
    const recovering = current.recoverLane(lane.id);
    let closed = false;
    const closing = current.close().then(() => {
      closed = true;
    });
    await delay(25);
    assert.equal(closed, false, 'shutdown must not close storage during recovery');
    release({ settled: true, exitCode: 0, reason: 'verified-fixture' });
    await recovering;
    await closing;
    assert.equal(closed, true);
  },
);

test(
  'memory corrections persist intent, pause failures and reconcile committed native transactions after restart',
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
    const lane = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/main')!;
    assert.equal((await app.inspectMemory(lane.id)).initialized, false);
    const init = await app.changeMemory({
      laneId: lane.id,
      requestId: 'initialize-memory',
      change: { kind: 'init', gitMode: 'track' },
    });
    assert.equal(init.state, 'saved');
    assert.equal(
      (
        await app.changeMemory({
          laneId: lane.id,
          requestId: 'initialize-memory',
          change: { kind: 'init', gitMode: 'track' },
        })
      ).id,
      init.id,
    );
    const session = await app.createSession(lane.id, 'Memory corrections', model);
    const saved = await app.saveMemory({
      requestId: 'source-record',
      sessionId: session.id,
      content: {
        type: 'decision',
        title: 'Architecture decision',
        summary: 'Initial decision',
        body: 'Observed evidence',
        scope: {},
        candidate: false,
      },
    });
    const recordId = saved.receipt!.id;
    const view = await app.inspectMemory(lane.id, { recordId });
    const input = {
      laneId: lane.id,
      requestId: 'correct-record',
      change: {
        kind: 'update' as const,
        id: recordId,
        revision: view.record!.revision,
        status: 'superseded',
        summary: 'Replaced decision',
        body: 'Replaced after new evidence. Source: original session.',
        scope: { paths: ['code'] },
      },
    };
    const job = await app.changeMemory(input);
    assert.equal(job.state, 'saved');
    const recordPath = join(directory, job.receipt!.path!);
    const bytes = readFileSync(recordPath, 'utf8');
    await app.close();
    store.transaction((tx) => {
      tx.state.operations.find((item) => item.memoryChangeId === job.id)!.state = 'pending';
      const pending = tx.state.memoryChanges.find((item) => item.id === job.id)!;
      pending.state = 'pending';
      pending.receipt = null;
      // Accepted intent before the first child operation exists: no live owner.
      tx.state.memoryChanges.push({
        ...job,
        id: 'unstarted-change',
        requestId: 'unstarted-change-request',
        state: 'pending',
        receipt: null,
      });
      tx.state.memorySaves.push({
        ...saved,
        id: 'unstarted-add',
        requestId: 'unstarted-add-request',
        state: 'pending',
        receipt: null,
      });
    });
    current = createHarness(deps);
    await current.initialize();
    assert.equal(
      current.snapshot().state.memoryChanges.find((item) => item.id === job.id)!.state,
      'failed',
    );
    assert.equal(
      current.snapshot().state.lanes.find((item) => item.id === lane.id)!.state,
      'paused',
    );
    await assert.rejects(current.resume(lane.id), /pending memory/);
    assert.equal(
      current.snapshot().state.memoryChanges.find((item) => item.id === 'unstarted-change')!.state,
      'failed',
    );
    assert.equal(
      current.snapshot().state.memorySaves.find((item) => item.id === 'unstarted-add')!.state,
      'failed',
    );
    assert.equal(
      current
        .snapshot()
        .state.operations.some(
          (item) =>
            item.memoryChangeId === 'unstarted-change' || item.memorySaveId === 'unstarted-add',
        ),
      false,
      'startup does not replay orphaned intents',
    );
    await current.continueWithoutMemoryChange('unstarted-change');
    await current.continueWithoutMemory('unstarted-add');
    const replayed = await current.retryMemoryChange(job.id);
    assert.equal(replayed.state, 'saved');
    assert.equal(replayed.receipt!.replayed, true);
    assert.equal(readFileSync(recordPath, 'utf8'), bytes);
    assert.equal(current.snapshot().state.runs.length, 0);
    const conflict = await current.changeMemory({ ...input, requestId: 'outdated-change' });
    assert.equal(conflict.state, 'failed');
    assert.match(conflict.error!, /changed; reload/);
    await assert.rejects(current.resume(lane.id), /pending memory/);
    await assert.rejects(
      current.changeMemory({ ...input, requestId: 'another-outdated-change' }),
      /pending memory/,
    );
    await current.continueWithoutMemoryChange(conflict.id);
    await current.resume(lane.id);
    assert.equal((await current.inspectMemory(lane.id, { query: { path: 'code' } })).total, 0);
    const inspect = deps.memory.inspect;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    deps.memory.inspect = async (request) => {
      await wait;
      return inspect(request);
    };
    const reading = current.inspectMemory(lane.id);
    await until(
      () =>
        current
          .snapshot()
          .state.operations.some(
            (item) => item.kind === 'inspect-memory' && item.state === 'pending',
          ),
      'memory inspection owns branch',
    );
    await assert.rejects(current.createSession(lane.id, 'Must wait', model), /occupied/);
    release();
    await reading;
    deps.memory.inspect = inspect;
    assert.equal(readFileSync(join(directory, 'code'), 'utf8'), 'dirty');
  },
);

test(
  'Git preview holds branch maintenance and interrupted reads recover without replay',
  { timeout: 30000 },
  async (t) => {
    const { root, directory, store, deps } = setup();
    let app = createHarness(deps);
    t.after(async () => {
      await app.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await app.initialize();
    await app.addProject(directory);
    const lane = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/main')!;
    const session = await app.createSession(lane.id, 'Git maintenance', model);
    const inspect = deps.git.inspectChanges.bind(deps.git);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    deps.git.inspectChanges = async (directory, operationId) => {
      await gate;
      return inspect(directory, operationId);
    };
    const reading = app.inspectGit(lane.id);
    await until(
      () =>
        app
          .snapshot()
          .state.operations.some((item) => item.kind === 'inspect-git' && item.state === 'pending'),
      'Git read intent',
    );
    const run = app.enqueue({
      requestId: 'after-git-preview',
      sessionId: session.id,
      text: 'after preview',
      attachmentIds: [],
    });
    assert.equal(state(app, run.id).state, 'queued');
    await assert.rejects(app.inspectGit(lane.id), /occupied/);
    release();
    const view = await reading;
    assert.match(view.files.find((file) => file.path === 'code')!.workingDiff, /dirty/);
    assert.equal(readFileSync(join(directory, 'code'), 'utf8'), 'dirty');
    await until(() => state(app, run.id).state === 'succeeded', 'queued run after preview');
    assert.equal(
      app.snapshot().state.operations.find((item) => item.kind === 'inspect-git')!.state,
      'completed',
    );
    await app.close();
    const interrupted = randomUUID();
    store.transaction((tx) => {
      tx.state.operations.push({
        id: interrupted,
        laneId: lane.id,
        kind: 'inspect-git',
        target: directory,
        state: 'pending',
        error: null,
        createdAt: Date.now(),
      });
    });
    deps.git.inspectChanges = async () => {
      throw new Error('Interrupted preview must not replay');
    };
    app = createHarness(deps);
    await app.initialize();
    assert.equal(
      app.snapshot().state.operations.find((item) => item.id === interrupted)!.state,
      'failed',
    );
    assert.equal(app.snapshot().state.lanes.find((item) => item.id === lane.id)!.state, 'paused');
  },
);

test(
  'application commits hold the branch, persist hook progress and deduplicate the explicit request',
  { timeout: 30000 },
  async (t) => {
    const { root, directory, store, app } = setup();
    t.after(async () => {
      await app.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await app.initialize();
    await app.addProject(directory);
    const lane = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/main')!;
    const session = await app.createSession(lane.id, 'After commit', model);
    writeFileSync(
      join(directory, '.git/hooks/pre-commit'),
      `#!/bin/sh\nprintf once >>'${join(root, 'hooks')}'; while [ ! -f '${join(root, 'release')}' ]; do sleep 0.1; done\n`,
      { mode: 0o700 },
    );
    const view = await app.inspectGit(lane.id),
      preview = await app.previewGitCommit(lane.id, view.revision, ['code']);
    assert.match(preview.diff, /dirty/);
    const input = {
      laneId: lane.id,
      requestId: 'application-commit',
      revision: preview.revision,
      tree: preview.tree,
      paths: preview.paths,
      message: 'Explicit whole-file commit',
    };
    const committing = app.commitGit(input);
    await until(() => app.snapshot().state.gitCommits[0]?.phase === 'hook', 'native hook progress');
    assert.equal(app.snapshot().state.gitCommits[0]!.hook, 'pre-commit');
    const duplicate = await app.commitGit(input);
    assert.equal(duplicate.state, 'pending');
    assert.equal(app.snapshot().state.gitCommits.length, 1);
    await assert.rejects(app.commitGit({ ...input, message: 'different' }), /conflicts/);
    await assert.rejects(app.inspectGit(lane.id), /occupied/);
    const run = app.enqueue({
      requestId: 'queued-after-commit',
      sessionId: session.id,
      text: 'after commit',
      attachmentIds: [],
    });
    assert.equal(state(app, run.id).state, 'queued');
    await assert.rejects(app.resume(lane.id), /pending Git commit/);
    writeFileSync(join(root, 'release'), 'continue');
    const result = await committing;
    assert.equal(result.state, 'committed', result.error ?? '');
    assert.equal(
      result.commit,
      execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    );
    assert.deepEqual(await app.commitGit(input), result);
    assert.equal(readFileSync(join(root, 'hooks'), 'utf8'), 'once');
    await until(() => state(app, run.id).state === 'succeeded', 'queued task after commit');
    assert.ok(app.events(0).some((event) => event.type === 'git.commit-hook'));
  },
);

test(
  'a lost Git commit confirmation recovers after restart only after all old workers are proven stopped',
  { timeout: 30000 },
  async (t) => {
    const { root, directory, store, deps } = setup();
    let app = createHarness(deps);
    t.after(async () => {
      await app.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await app.initialize();
    await app.addProject(directory);
    const lane = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/main')!;
    writeFileSync(
      join(directory, '.git/hooks/pre-commit'),
      `#!/bin/sh\nprintf once >>'${join(root, 'hooks')}'\n`,
      { mode: 0o700 },
    );
    const commit = deps.git.commitFiles.bind(deps.git),
      recover = deps.git.recoverCommit.bind(deps.git);
    deps.git.commitFiles = async (input, progress) => {
      await commit(input, progress);
      throw new Error('Lost acknowledgement');
    };
    deps.git.recoverCommit = async () => {
      throw new Error('Recovery temporarily unavailable');
    };
    const view = await app.inspectGit(lane.id),
      preview = await app.previewGitCommit(lane.id, view.revision, ['code']);
    const job = await app.commitGit({
      laneId: lane.id,
      requestId: 'lost-git-ack',
      revision: preview.revision,
      tree: preview.tree,
      paths: ['code'],
      message: 'Recover this commit',
    });
    assert.equal(job.state, 'uncertain');
    const head = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    await assert.rejects(app.resume(lane.id), /recovery/);
    await app.close();
    const oldRecovery = app
      .snapshot()
      .state.operations.find(
        (item) => item.gitCommitId === job.id && item.kind === 'recover-git-commit',
      )!;
    const proof = deps.supervisor.recover.bind(deps.supervisor);
    deps.supervisor.recover = async (id) =>
      id === oldRecovery.id
        ? { settled: false, exitCode: null, reason: 'Old recovery worker is not yet verified' }
        : proof(id);
    let recoverCalls = 0;
    deps.git.recoverCommit = async (input) => {
      recoverCalls++;
      return recover(input);
    };
    deps.git.commitFiles = async () => {
      throw new Error('Commit must never replay on recovery');
    };
    app = createHarness(deps);
    await app.initialize();
    assert.equal(recoverCalls, 0, 'a prior recovery worker blocks a second index writer');
    assert.equal(
      app.snapshot().state.lanes.find((item) => item.id === lane.id)!.state,
      'recovering',
    );
    deps.supervisor.recover = proof;
    const restored = await app.reconcileGitCommit(job.id);
    assert.equal(restored.state, 'committed', restored.error ?? '');
    assert.equal(restored.commit, head);
    assert.equal(recoverCalls, 1);
    assert.equal(readFileSync(join(root, 'hooks'), 'utf8'), 'once');
    assert.equal(app.snapshot().state.lanes.find((item) => item.id === lane.id)!.state, 'paused');
  },
);

test(
  'explicit external Git review keeps a moved ref and index, records the prior uncertainty and leaves the lane paused',
  { timeout: 30000 },
  async (t) => {
    const { root, directory, store, app } = setup();
    t.after(async () => {
      await app.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await app.initialize();
    await app.addProject(directory);
    const lane = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/main')!;
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
    const head = git('rev-parse', 'HEAD'),
      index = readFileSync(join(directory, '.git/index'));
    writeFileSync(
      join(directory, '.git/hooks/post-commit'),
      '#!/bin/sh\ngit update-ref refs/heads/main "$(git rev-parse HEAD^)"\n',
      { mode: 0o700 },
    );
    const view = await app.inspectGit(lane.id),
      preview = await app.previewGitCommit(lane.id, view.revision, ['code']);
    const job = await app.commitGit({
      laneId: lane.id,
      requestId: 'external-review',
      revision: preview.revision,
      tree: preview.tree,
      paths: ['code'],
      message: 'Created before external ref movement',
    });
    assert.equal(job.state, 'uncertain');
    assert.ok(job.commit);
    assert.equal(git('rev-parse', 'HEAD'), head);
    const result = await app.reconcileGitCommit(job.id, true);
    assert.equal(result.state, 'reviewed', result.error ?? '');
    assert.equal(result.commit, job.commit);
    assert.match(result.error!, /branch moved/);
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.deepEqual(readFileSync(join(directory, '.git/index')), index);
    assert.equal(readFileSync(join(directory, 'code'), 'utf8'), 'dirty');
    assert.ok(app.events(0).some((event) => event.type === 'git.commit-reviewed'));
    assert.equal(app.snapshot().state.lanes.find((item) => item.id === lane.id)!.state, 'paused');
    await app.resume(lane.id);
    assert.equal(app.snapshot().state.lanes.find((item) => item.id === lane.id)!.state, 'ready');
  },
);

test(
  'project inspections remain owned across concurrent adds and backend close waits for native hooks',
  { timeout: 20000 },
  async (t) => {
    const { root, directory, app, store } = setup();
    const release = join(root, 'release-metadata');
    t.after(async () => {
      writeFileSync(release, 'release');
      await app.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    const other = join(root, 'other-repository');
    execFileSync('git', ['clone', directory, other], { stdio: 'pipe' });
    const hook = join(root, 'metadata-hook');
    const entered = join(root, 'metadata-entered');
    writeFileSync(
      hook,
      `#!/usr/bin/env python3\nimport os,time\nopen(${JSON.stringify(entered)}, 'w').close()\nwhile not os.path.exists(${JSON.stringify(release)}): time.sleep(.01)\nos.write(1, b'token\\0/\\0')\n`,
      { mode: 0o700 },
    );
    execFileSync('git', ['-C', directory, 'config', 'core.fsmonitor', hook]);
    await app.initialize();
    const first = app.addProject(directory);
    await until(() => {
      try {
        readFileSync(entered);
        return true;
      } catch {
        return false;
      }
    }, 'native fsmonitor entered');
    const operation = app
      .snapshot()
      .state.operations.find(
        (item) => item.kind === 'inspect-repository' && item.state === 'pending',
      )!;
    assert.ok(operation);
    await app.addProject(other);
    assert.equal(
      app.snapshot().state.operations.find((item) => item.id === operation.id)!.state,
      'pending',
    );
    await assert.rejects(app.addProject(directory), /being added/);
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await delay(50);
    assert.equal(
      closed,
      false,
      'close must retain store ownership until the accepted project check finishes',
    );
    writeFileSync(release, 'release');
    await first;
    await closing;
    assert.equal(app.snapshot().state.projects.length, 2);
    assert.equal(
      app.snapshot().state.operations.find((item) => item.id === operation.id)!.state,
      'completed',
    );
  },
);

test('unbound metadata recovery does not replay Git hooks and explicit add retries cleanup before inspecting', async (t) => {
  const { root, directory, app, store, deps } = setup();
  t.after(async () => {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const recover = deps.supervisor.recover.bind(deps.supervisor);
  let settled = false,
    inspections = 0;
  deps.supervisor.recover = async (id) =>
    id === 'interrupted-metadata'
      ? { settled, exitCode: null, reason: 'injected cleanup evidence' }
      : recover(id);
  const inspect = deps.git.inspect.bind(deps.git);
  deps.git.inspect = async (...args) => {
    inspections++;
    return inspect(...args);
  };
  store.transaction((tx) =>
    tx.state.operations.push({
      id: 'interrupted-metadata',
      laneId: null,
      kind: 'inspect-repository',
      target: directory,
      state: 'pending',
      error: null,
      createdAt: 1,
    }),
  );
  await app.initialize();
  assert.equal(inspections, 0);
  await assert.rejects(app.addProject(directory), /重试添加项目/);
  assert.equal(inspections, 0);
  settled = true;
  const owner = await app.addProject(directory);
  assert.equal(inspections, 1);
  assert.equal(
    app.snapshot().state.operations.find((item) => item.id === 'interrupted-metadata')!.state,
    'failed',
  );
  // Registration and initial branch discovery can straddle a backend crash.
  store.transaction((tx) => {
    tx.state.lanes.length = 0;
  });
  await app.refreshProject(owner.id);
  assert.equal(app.snapshot().state.lanes.length, 2);
});

test(
  'failed and cancelled native turns survive restart, fork and explicit recovery',
  { timeout: 30000 },
  async (t) => {
    const { root, directory, app, store, deps } = setup();
    let current = app;
    t.after(async () => {
      await current.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await current.initialize();
    await current.addProject(directory);
    const lane = current.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/main')!;
    const session = await current.createSession(lane.id, 'Failed history', model);
    const run = current.enqueue({
      requestId: 'failed-history',
      sessionId: session.id,
      text: 'probe-failed-turn',
      attachmentIds: [],
    });
    await until(() => state(current, run.id).state === 'failed', 'failed native turn');
    const native = readFileSync(deps.engine.sessionPath(session.id), 'utf8');
    assert.match(native, /probe-failed-turn/);
    assert.match(native, /partial before failure/);
    let history = current.history(session.id).messages;
    assert.equal(history.find((item) => item.role === 'user')?.text, 'probe-failed-turn');
    assert.equal(history.find((item) => item.role === 'assistant')?.text, 'partial before failure');
    await current.close();
    current = createHarness(deps);
    await current.initialize();
    assert.deepEqual(current.history(session.id).messages, history);
    assert.equal(readFileSync(deps.engine.sessionPath(session.id), 'utf8'), native);

    await current.resume(lane.id);
    const cancelled = current.enqueue({
      requestId: 'cancelled-history',
      sessionId: session.id,
      text: 'probe-slow-tool',
      attachmentIds: [],
    });
    await until(() => existsSync(join(directory, 'tool.pid')), 'cancelled turn tool started');
    await current.stop(cancelled.id);
    assert.equal(state(current, cancelled.id).state, 'cancelled');
    history = current.history(session.id).messages;
    const cancelledInput = history.find(
      (item) => item.role === 'user' && item.text === 'probe-slow-tool',
    )!;
    assert.ok(cancelledInput?.forkable);
    assert.ok(history.some((item) => item.role === 'assistant' && item.text.includes('tool.pid')));
    const settledNative = readFileSync(deps.engine.sessionPath(session.id), 'utf8');
    await current.close();
    // Simulate a cache written by the previous application version.
    store.transaction((tx) => {
      tx.state.sessions.find((item) => item.id === session.id)!.messages = [];
    });
    current = createHarness(deps);
    await current.initialize();
    assert.deepEqual(current.history(session.id).messages, history);
    assert.equal(readFileSync(deps.engine.sessionPath(session.id), 'utf8'), settledNative);
    const child = await current.forkSession(
      session.id,
      cancelledInput.id,
      'Cancelled fork',
      'cancelled-fork',
    );
    assert.equal(
      current.snapshot().state.drafts.find((item) => item.sessionId === child.id)?.text,
      'probe-slow-tool',
    );
    assert.ok(
      current.history(child.id).messages.some((item) => item.text === 'partial before failure'),
    );
    assert.ok(!current.history(child.id).messages.some((item) => item.id === cancelledInput.id));

    await current.close();
    writeFileSync(deps.engine.sessionPath(session.id), 'invalid header\n');
    current = createHarness(deps);
    await current.initialize();
    assert.deepEqual(
      current.history(session.id).messages,
      history,
      'read failure preserves the existing cache',
    );
    assert.equal(
      current.snapshot().state.lanes.find((item) => item.id === lane.id)?.state,
      'recovering',
    );
    await assert.rejects(current.resume(lane.id), /recovery/);
    writeFileSync(deps.engine.sessionPath(session.id), settledNative);
    assert.equal(await current.recoverLane(lane.id), true);
    assert.equal(
      current.snapshot().state.lanes.find((item) => item.id === lane.id)?.state,
      'paused',
    );
    await current.resume(lane.id);
    const continued = current.enqueue({
      requestId: 'continue-history',
      sessionId: session.id,
      text: 'after cancellation',
      attachmentIds: [],
    });
    await until(
      () => state(current, continued.id).state === 'succeeded',
      'continued recovered session',
    );
    const last = current.history(session.id).messages.at(-1)!;
    assert.match(last.text, /probe-failed-turn/);
    assert.match(last.text, /probe-slow-tool/);
    assert.match(last.text, /after cancellation/);
  },
);

test(
  'application upgrade opens, continues and forks a real pi 0.84.1 session with existing MWF',
  { timeout: 45000 },
  async (t) => {
    const { root, directory, app, store, deps } = setup();
    let current = app;
    let currentStore = store;
    t.after(async () => {
      await current.close();
      currentStore.close();
      rmSync(root, { recursive: true, force: true });
    });
    await current.initialize();
    await current.addProject(directory);
    const lane = current.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/main')!;
    const session = await current.createSession(lane.id, 'Existing old session', model);
    assert.equal(
      (
        await current.changeMemory({
          laneId: lane.id,
          requestId: 'upgrade-memory-init',
          change: { kind: 'init', gitMode: 'ignore' },
        })
      ).state,
      'saved',
    );
    const content = {
      type: 'knowledge' as const,
      title: 'Upgrade contract',
      summary: 'Existing memory survives kernel upgrade',
      body: 'Keep the original worktree and history.',
      candidate: false,
      scope: { paths: ['code'] },
    };
    const beforeMemory = await current.saveMemory({
      requestId: 'memory-before-upgrade',
      sessionId: session.id,
      content,
    });
    assert.equal(beforeMemory.state, 'saved');
    const memoryBytes = readFileSync(join(directory, beforeMemory.receipt!.path));
    await current.close();
    currentStore.close();

    const bytes = readFileSync(
      new URL('../probes/fixtures/pi-0.84.1-session.jsonl', import.meta.url),
    );
    const meta = JSON.parse(
      readFileSync(
        new URL('../probes/fixtures/pi-0.84.1-session.meta.json', import.meta.url),
        'utf8',
      ),
    );
    assert.equal(meta.version, '0.84.1');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), meta.sha256);
    // Relocate only the real old kernel's header. Historical message bytes stay exact.
    const newline = bytes.indexOf(10);
    const header = JSON.parse(bytes.subarray(0, newline).toString());
    const relocated = Buffer.concat([
      Buffer.from(JSON.stringify({ ...header, cwd: directory }) + '\n'),
      bytes.subarray(newline + 1),
    ]);
    const path = deps.engine.sessionPath(session.id);
    writeFileSync(path, relocated);
    currentStore = openStore(join(root, 'data'));
    current = createHarness({ ...deps, store: currentStore });
    await current.initialize();
    const oldHistory = current.history(session.id).messages;
    assert.deepEqual(
      oldHistory.map((item) => item.text),
      ['old-first', 'answer:old-first', 'old-fork-point', 'answer:old-fork-point'],
    );
    assert.deepEqual(readFileSync(path), relocated, 'opening history must not rewrite the old log');
    assert.equal(current.snapshot().state.runs.length, 0, 'opening must not execute a prompt');
    const recalled = await current.inspectMemory(lane.id, { query: { path: 'code' } });
    assert.ok(recalled.records.some((item) => item.id === beforeMemory.receipt!.id));
    assert.deepEqual(readFileSync(join(directory, beforeMemory.receipt!.path)), memoryBytes);

    const continued = current.enqueue({
      requestId: 'upgrade-continue',
      sessionId: session.id,
      text: 'continued after upgrade',
      attachmentIds: [],
    });
    await until(
      () => ['succeeded', 'failed', 'interrupted'].includes(state(current, continued.id).state),
      'old session continuation',
    );
    assert.equal(
      state(current, continued.id).state,
      'succeeded',
      state(current, continued.id).error ?? 'failed',
    );
    const afterHistory = current.history(session.id).messages;
    assert.deepEqual(afterHistory.slice(0, oldHistory.length), oldHistory);
    assert.match(afterHistory.at(-1)!.text, /old-first/);
    assert.match(afterHistory.at(-1)!.text, /old-fork-point/);
    assert.match(afterHistory.at(-1)!.text, /continued after upgrade/);
    const sourceBytes = readFileSync(path);
    const point = oldHistory.find((item) => item.text === 'old-fork-point')!;
    const child = await current.forkSession(
      session.id,
      point.id,
      'Old session fork',
      'upgrade-fork',
    );
    assert.deepEqual(current.history(child.id).messages, oldHistory.slice(0, 2));
    assert.equal(
      current.snapshot().state.drafts.find((item) => item.sessionId === child.id)?.text,
      'old-fork-point',
    );
    assert.deepEqual(child.origin, { kind: 'fork', sessionId: session.id, entryId: point.id });
    const forkRun = current.enqueue({
      requestId: 'upgrade-fork-run',
      sessionId: child.id,
      text: 'fork continued after upgrade',
      attachmentIds: [],
    });
    await until(
      () => ['succeeded', 'failed', 'interrupted'].includes(state(current, forkRun.id).state),
      'old session fork continuation',
    );
    assert.equal(
      state(current, forkRun.id).state,
      'succeeded',
      state(current, forkRun.id).error ?? 'failed',
    );
    const forkReply = current.history(child.id).messages.at(-1)!.text;
    assert.match(forkReply, /old-first/);
    assert.match(forkReply, /fork continued after upgrade/);
    assert.doesNotMatch(forkReply, /old-fork-point/);
    assert.deepEqual(
      readFileSync(path),
      sourceBytes,
      'fork execution must not change its source log',
    );

    const afterMemory = await current.saveMemory({
      requestId: 'memory-after-upgrade',
      sessionId: child.id,
      runId: forkRun.id,
      content: { ...content, title: 'After upgrade', summary: 'New memory remains writable' },
    });
    assert.equal(afterMemory.state, 'saved');
    const afterRecall = await current.inspectMemory(lane.id, { query: { path: 'code' } });
    assert.deepEqual(
      new Set(afterRecall.records.map((item) => item.id)),
      new Set([beforeMemory.receipt!.id, afterMemory.receipt!.id]),
    );
    assert.match(
      readFileSync(join(directory, afterMemory.receipt!.path), 'utf8'),
      new RegExp(child.id),
    );
    assert.equal(readFileSync(join(directory, 'code'), 'utf8'), 'dirty');
  },
);

test(
  'waiting runs retain global slots across concurrency changes and failure pauses only its own lane',
  { timeout: 45000 },
  async (t) => {
    const { root, directory, app, store } = setup();
    t.after(async () => {
      await app.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await app.initialize();
    await app.addProject(directory);
    const main = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/main')!;
    const other = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/other')!;
    await app.createBranch({
      laneId: main.id,
      requestId: 'third-lane',
      name: 'third',
      startRef: main.ref,
      track: false,
    });
    const third = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/third')!;
    const a = await app.createSession(main.id, 'Waiting A', model);
    const b = await app.createSession(other.id, 'Waiting B', model);
    const c = await app.createSession(third.id, 'Later failure', model);
    const d = await app.createSession(main.id, 'Serial after A', model);
    const enqueue = (sessionId: string, text: string) =>
      app.enqueue({ requestId: randomUUID(), sessionId, text, attachmentIds: [] });
    assert.equal(app.status().concurrency, 2);
    const first = enqueue(a.id, 'probe-question-tool');
    const second = enqueue(b.id, 'probe-question-tool');
    const failure = enqueue(c.id, 'probe-failed-turn');
    const serial = enqueue(d.id, 'same branch after waiting');
    await until(
      () =>
        state(app, first.id).state === 'waiting_input' &&
        state(app, second.id).state === 'waiting_input',
      'two occupied question slots',
    );
    assert.equal(state(app, failure.id).state, 'queued');
    assert.equal(state(app, serial.id).state, 'queued');
    app.setConcurrency(1);
    assert.equal(state(app, first.id).state, 'waiting_input');
    assert.equal(
      state(app, second.id).state,
      'waiting_input',
      'reducing the limit must not cancel existing runs',
    );
    app.answer(second.id, state(app, second.id).question!.id, 'continue');
    await until(() => state(app, second.id).state === 'succeeded', 'second question answered');
    assert.equal(
      state(app, failure.id).state,
      'queued',
      'one waiting run consumes the remaining slot',
    );
    assert.equal(
      state(app, serial.id).state,
      'queued',
      'another session cannot overlap the waiting lane',
    );
    app.setConcurrency(2);
    await until(
      () => state(app, failure.id).state === 'failed',
      'third lane executes after capacity increases',
    );
    assert.equal(app.snapshot().state.lanes.find((item) => item.id === third.id)!.state, 'paused');
    assert.equal(state(app, first.id).state, 'waiting_input');
    assert.equal(app.snapshot().state.lanes.find((item) => item.id === main.id)!.state, 'ready');
    assert.equal(state(app, serial.id).state, 'queued');
    app.answer(first.id, state(app, first.id).question!.id, 'continue');
    await until(
      () => state(app, serial.id).state === 'succeeded',
      'unrelated lane continues after failure',
    );
    assert.equal(state(app, first.id).state, 'succeeded');
    assert.equal(readFileSync(join(directory, 'code'), 'utf8'), 'dirty');
  },
);

test(
  'a text-only native model rejects images before prompt while retaining the accepted attachment',
  { timeout: 30000 },
  async (t) => {
    const { root, directory, app, store, deps } = setup();
    t.after(async () => {
      await app.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await app.initialize();
    await app.addProject(directory);
    const lane = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/main')!;
    const session = await app.createSession(lane.id, 'Text only', {
      ...model,
      model: 'probe-text-only',
    });
    const data = readFileSync(
      new URL('../probes/fixtures/red-square.png', import.meta.url),
    ).toString('base64');
    const attachment = app.upload({ mimeType: 'image/png', data });
    const run = app.enqueue({
      requestId: 'image-refused',
      sessionId: session.id,
      text: 'must-not-reach-model',
      attachmentIds: [attachment.id],
    });
    await until(() => state(app, run.id).state === 'failed', 'native image capability rejection');
    assert.match(state(app, run.id).error!, /does not support images/);
    assert.equal(state(app, run.id).model.model, 'probe-text-only');
    assert.deepEqual(state(app, run.id).attachmentIds, [attachment.id]);
    assert.equal(deps.attachments.get(attachment.id).data, data);
    assert.equal(app.history(session.id).messages.length, 0);
    assert.doesNotMatch(
      readFileSync(deps.engine.sessionPath(session.id), 'utf8'),
      /must-not-reach-model/,
    );
    assert.equal(app.snapshot().state.lanes.find((item) => item.id === lane.id)!.state, 'paused');
    app.setSessionModel(session.id, model);
    await app.resume(lane.id);
    const retry = app.enqueue({
      requestId: 'image-explicit-retry',
      sessionId: session.id,
      text: 'explicit image retry',
      attachmentIds: [attachment.id],
    });
    await until(
      () => state(app, retry.id).state === 'succeeded',
      'explicit retry with a supported model',
    );
    assert.equal(state(app, run.id).state, 'failed', 'the rejected run remains unchanged');
    assert.equal(app.history(session.id).messages[0]?.images[0]?.data, data);
  },
);
