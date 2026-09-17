import { validateConfigurationRevision, validateDefaultModel } from './configuration.ts';
import type { ConfigurationAccess } from './configuration.ts';
import { createMemoryService, memoryBlocked } from './memory.ts';
import { activeStates, concurrency, resolveModel, schedule, transition } from '@parallel-pi/domain';
import type { ModelSelection, RunState } from '@parallel-pi/domain';
import type {
  AppStore,
  MemoryAccess,
  HandoffStore,
  RunHandoff,
  AttachmentStore,
  Engine,
  ForkInput,
  ForkResult,
  EngineConnection,
  EngineEvent,
  ImageInput,
  Lane,
  Operation,
  ProcessSupervisor,
  Project,
  RepositoryFacts,
  Run,
  Runtime,
  Session,
  WorkspaceAccess,
} from './ports.ts';

export function createHarness(deps: {
  configuration?: ConfigurationAccess;
  store: AppStore;
  attachments: AttachmentStore;
  handoffs: HandoffStore;
  memory: MemoryAccess;
  git: WorkspaceAccess;
  engine: Engine;
  supervisor: ProcessSupervisor;
  runtime: Runtime;
}) {
  const { store, git, engine, supervisor, runtime, attachments, handoffs } = deps;
  const maintenance = new Set<string>();
  const maintenanceDone = new Set<Promise<void>>();
  const active = new Map<
    string,
    { laneId: string; connection: EngineConnection | null; cancelled: boolean; done: Promise<void> }
  >();
  let ready = false,
    closing = false;
  const snapshot = () => store.snapshot();
  function requireReady() {
    if (!ready || closing) throw new Error('Application is recovering or shutting down');
  }
  function lane(id: string): Lane {
    const value = snapshot().state.lanes.find((item) => item.id === id);
    if (!value) throw new Error('Branch not found');
    return value;
  }
  function project(id: string): Project {
    const value = snapshot().state.projects.find((item) => item.id === id);
    if (!value) throw new Error('Project not found');
    return value;
  }
  function session(id: string): Session {
    const value = snapshot().state.sessions.find((item) => item.id === id);
    if (!value) throw new Error('Session not found');
    return value;
  }
  function setLane(id: string, state: Lane['state'], reason: string | null) {
    store.transaction((tx) => {
      const value = tx.state.lanes.find((item) => item.id === id)!;
      value.state = state;
      value.reason = reason;
      tx.emit('lane.changed', { laneId: id });
    });
  }
  function runState(id: string, next: RunState, error: string | null = null) {
    store.transaction((tx) => {
      const run = tx.state.runs.find((item) => item.id === id)!;
      run.state = transition(run.state, next);
      run.error = error;
      if (!activeStates.includes(next)) run.endedAt = runtime.now();
      tx.emit('run.changed', { runId: id });
    });
  }
  function syncBranches(projectId: string, facts: RepositoryFacts) {
    store.transaction((tx) => {
      tx.state.projects.find((item) => item.id === projectId)!.remoteBranches =
        facts.remoteBranches;
      for (const branch of facts.branches) {
        const existing = tx.state.lanes.find(
          (item) => item.projectId === projectId && item.ref === branch.ref,
        );
        const checked = facts.worktrees.find((item) => item.ref === branch.ref && !item.locked);
        if (existing) existing.upstream = branch.upstream;
        if (!existing)
          tx.state.lanes.push({
            id: runtime.id(),
            projectId,
            ref: branch.ref,
            upstream: branch.upstream,
            directory: checked?.directory ?? null,
            state: 'ready',
            reason: null,
            lastServed: 0,
          });
      }
      tx.emit('project.changed', { projectId });
    });
  }
  function holdMaintenance(laneId: string) {
    maintenance.add(laneId);
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    maintenanceDone.add(done);
    return () => {
      maintenance.delete(laneId);
      maintenanceDone.delete(done);
      release();
    };
  }
  async function withLane<T>(laneId: string, work: () => Promise<T>) {
    requireReady();
    if (maintenance.has(laneId) || [...active.values()].some((item) => item.laneId === laneId))
      throw new Error('Branch is occupied; wait for its current operation');
    if (lane(laneId).state === 'recovering')
      throw new Error('Branch requires recovery before changing its workspace');
    const release = holdMaintenance(laneId);
    try {
      return await work();
    } finally {
      release();
      pump();
    }
  }
  function forkInput(operation: Operation): ForkInput {
    const child = session(operation.sessionId!);
    if (child.origin?.kind !== 'fork') throw new Error('Fork origin is missing');
    return {
      operationId: operation.id,
      directory: lane(operation.laneId).directory!,
      sourceRef: session(child.origin.sessionId).nativeRef,
      targetRef: operation.target,
      entryId: child.origin.entryId,
    };
  }
  function finishFork(operation: Operation, result: ForkResult | null) {
    const images = result?.draft.images.map((image) => attachments.put(image)) ?? [];
    store.transaction((tx) => {
      const child = tx.state.sessions.find((item) => item.id === operation.sessionId)!;
      child.state = result ? 'ready' : 'error';
      if (result) {
        child.messages = result.messages;
        tx.state.attachments.push(...images);
        tx.state.drafts.push({
          sessionId: child.id,
          revision: 1,
          text: result.draft.text,
          attachmentIds: images.map((image) => image.id),
        });
      }
      tx.state.operations.find((item) => item.id === operation.id)!.state = result
        ? 'completed'
        : 'failed';
      tx.emit('session.forked', { sessionId: child.id, restored: Boolean(result) });
    });
  }
  function beginOperation(
    laneId: string,
    kind: Operation['kind'],
    target: string,
    sessionId?: string,
    initialSession?: Session,
  ) {
    const operation: Operation = {
      id: runtime.id(),
      laneId,
      kind,
      target,
      sessionId,
      state: 'pending',
      error: null,
      createdAt: runtime.now(),
    };
    store.transaction((tx) => {
      if (
        tx.state.operations.some(
          (item) => item.laneId === laneId && ['pending', 'uncertain'].includes(item.state),
        )
      )
        throw new Error('Branch has an unresolved operation');
      tx.state.operations.push(operation);
      if (initialSession) tx.state.sessions.push(initialSession);
      tx.emit('operation.started', { operationId: operation.id });
    });
    return operation;
  }
  async function prepare(laneId: string): Promise<string> {
    const current = lane(laneId),
      owner = project(current.projectId);
    if (current.directory) {
      await git.validate({
        repository: owner.repository,
        ref: current.ref,
        directory: current.directory,
      });
      return current.directory;
    }
    const facts = await git.inspect(owner.directory);
    const existing = facts.worktrees.find((item) => item.ref === current.ref && !item.locked);
    if (existing) {
      await git.validate({
        repository: owner.repository,
        ref: current.ref,
        directory: existing.directory,
      });
      store.transaction((tx) => {
        tx.state.lanes.find((item) => item.id === laneId)!.directory = existing.directory;
        tx.emit('lane.changed', { laneId });
      });
      return existing.directory;
    }
    const target = runtime.worktreePath(laneId);
    const operation = beginOperation(laneId, 'prepare-worktree', target);
    try {
      await git.prepareWorktree(owner.directory, current.ref, target, operation.id);
      const bound = await git.reconcileWorktree(owner.repository, current.ref, target);
      if (!bound) throw new Error('Created worktree cannot be found');
      store.transaction((tx) => {
        tx.state.lanes.find((item) => item.id === laneId)!.directory = bound;
        tx.state.operations.find((item) => item.id === operation.id)!.state = 'completed';
        tx.emit('operation.completed', { operationId: operation.id });
      });
      return bound;
    } catch (error) {
      setLane(
        laneId,
        'recovering',
        error instanceof Error ? error.message : 'Worktree preparation needs reconciliation',
      );
      throw error;
    }
  }
  function emit(runId: string, event: EngineEvent) {
    if (event.type !== 'question') {
      store.append('run.output', { runId, event });
      return;
    }
    store.transaction((tx) => {
      const run = tx.state.runs.find((item) => item.id === runId)!;
      if (event.type === 'question') {
        run.question = event.question;
        if (run.state === 'running') run.state = transition(run.state, 'waiting_input');
      }
      tx.emit('run.output', { runId, event });
    });
  }
  function handoffContent(run: Run): RunHandoff {
    const through = snapshot().cursor;
    let cursor = run.eventStart ?? 0;
    let observedAssistant = '',
      truncated = false;
    // ponytail: bounded pages scan the shared journal; add a run index when measured history warrants it.
    while (cursor < through) {
      const events = store.events(cursor);
      if (!events.length) break;
      for (const event of events) {
        if (event.cursor > through) break;
        cursor = event.cursor;
        const data = event.data as { runId?: string; event?: EngineEvent };
        if (event.type === 'run.output' && data.runId === run.id && data.event?.type === 'text') {
          const remaining = 20000 - observedAssistant.length;
          observedAssistant += data.event.text.slice(0, remaining);
          if (data.event.text.length > remaining) truncated = true;
        }
      }
    }
    return {
      version: 1,
      runId: run.id,
      sessionId: run.sessionId,
      laneId: run.laneId,
      ref: lane(run.laneId).ref,
      nativeSession: session(run.sessionId).nativeRef,
      request: run.text,
      attachmentIds: [...run.attachmentIds],
      outcome: run.state,
      error: run.error,
      endedAt: run.endedAt!,
      observedAssistant,
      truncated,
      eventRange: { after: run.eventStart ?? 0, through },
    };
  }
  function saveHandoff(runId: string) {
    const run = snapshot().state.runs.find((item) => item.id === runId)!;
    if (!run.handoff || ['saved', 'continued'].includes(run.handoff.state)) return;
    let failure: string | null = null;
    try {
      handoffs.put(run.handoff.content);
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Handoff save failed';
    }
    store.transaction((tx) => {
      const record = tx.state.runs.find((item) => item.id === runId)!;
      record.handoff!.state = failure ? 'failed' : 'saved';
      record.handoff!.error = failure;
      if (failure) {
        const branch = tx.state.lanes.find((item) => item.id === run.laneId)!;
        if (branch.state !== 'recovering') {
          branch.state = 'paused';
          branch.reason =
            '执行结果已保留，交接记录尚未保存。请重试保存，或明确暂不保存后恢复队列。';
        }
      }
      tx.emit('handoff.changed', { runId });
    });
  }
  async function execute(runId: string) {
    const entry = active.get(runId)!;
    const run = snapshot().state.runs.find((item) => item.id === runId)!;
    let result: 'succeeded' | 'failed' | 'cancelled' | 'interrupted' = 'succeeded';
    let error: string | null = null;
    try {
      const directory = await prepare(run.laneId);
      if (entry.cancelled) throw new Error('Cancelled before launch');
      const target = session(run.sessionId);
      entry.connection = await engine.open(
        { operationId: run.id, directory, sessionRef: target.nativeRef },
        (event) => emit(run.id, event),
      );
      if (entry.cancelled) throw new Error('Cancelled before prompt');
      await entry.connection.select(run.model);
      const models = await entry.connection.models();
      if (
        run.attachmentIds.length &&
        !models.find(
          (item) => item.provider === run.model.provider && item.model === run.model.model,
        )?.images
      )
        throw new Error('The selected model does not support images');
      runState(run.id, 'running');
      await entry.connection.execute(
        run.text,
        run.attachmentIds.map((id) => attachments.get(id)),
      );
      await git.validate({
        repository: project(lane(run.laneId).projectId).repository,
        ref: lane(run.laneId).ref,
        directory,
      });
      const messages = await entry.connection.messages();
      store.transaction((tx) => {
        tx.state.sessions.find((item) => item.id === run.sessionId)!.messages = messages;
        tx.emit('session.changed', { sessionId: run.sessionId });
      });
    } catch (cause) {
      result = entry.cancelled
        ? 'cancelled'
        : cause instanceof Error && cause.message === 'pi process exited'
          ? 'interrupted'
          : 'failed';
      error = cause instanceof Error ? cause.message : 'Execution failed';
    } finally {
      const proof = entry.connection
        ? await entry.connection.close()
        : await supervisor.recover(run.id);
      if (!proof.settled) {
        result = 'interrupted';
        error = proof.reason;
      } else if (entry.cancelled) result = 'cancelled';
      const current = snapshot().state.runs.find((item) => item.id === run.id)!;
      if (current.state === 'stopping' && result !== 'interrupted') result = 'cancelled';
      const endedAt = runtime.now();
      const content = handoffContent({ ...current, state: result, error, endedAt });
      store.transaction((tx) => {
        const record = tx.state.runs.find((item) => item.id === run.id)!;
        const branch = tx.state.lanes.find((item) => item.id === run.laneId)!;
        record.state = transition(record.state, result);
        record.error = error;
        record.endedAt = endedAt;
        record.question = null;
        record.handoff = { state: 'pending', content, error: null };
        if (!proof.settled || branch.state === 'recovering') {
          branch.state = 'recovering';
          branch.reason = error ?? 'Pending operation requires reconciliation';
        } else if (result !== 'succeeded') {
          branch.state = 'paused';
          branch.reason = error ?? 'Stopped by user';
        }
        tx.emit('run.finished', { runId: run.id, laneId: run.laneId });
      });
      saveHandoff(run.id);
      active.delete(run.id);
      pump();
    }
  }
  function pump() {
    if (!ready || closing) return;
    const { state } = snapshot();
    const lanes = state.lanes.filter(
      (item) =>
        !maintenance.has(item.id) &&
        !memoryBlocked(state, item.id) &&
        !state.runs.some(
          (run) =>
            run.laneId === item.id &&
            run.handoff &&
            ['pending', 'failed'].includes(run.handoff.state),
        ) &&
        !state.operations.some(
          (operation) =>
            operation.laneId === item.id && ['pending', 'uncertain'].includes(operation.state),
        ),
    );
    const selected = schedule(
      lanes,
      state.runs.filter((run) => run.state === 'queued'),
      [...active.values()].map((item) => ({
        laneId: item.laneId,
        directory: lane(item.laneId).directory,
      })),
      state.concurrency,
    );
    for (const id of selected) {
      const run = state.runs.find((item) => item.id === id)!;
      store.transaction((tx) => {
        const record = tx.state.runs.find((item) => item.id === id)!;
        record.state = transition(record.state, 'starting');
        tx.state.lanes.find((item) => item.id === run.laneId)!.lastServed =
          Math.max(0, ...tx.state.lanes.map((item) => item.lastServed)) + 1;
        tx.emit('run.changed', { runId: id });
      });
      const entry = {
        laneId: run.laneId,
        connection: null as EngineConnection | null,
        cancelled: false,
        done: Promise.resolve(),
      };
      active.set(id, entry);
      entry.done = execute(id);
    }
  }
  async function recoverLane(laneId: string) {
    if (closing) throw new Error('Application is shutting down');
    if ([...active.values()].some((item) => item.laneId === laneId) || maintenance.has(laneId))
      throw new Error('Branch is still occupied');
    const release = holdMaintenance(laneId);
    try {
      let safe = true;
      for (const run of snapshot().state.runs.filter(
        (item) => item.laneId === laneId && item.state === 'interrupted',
      )) {
        const proof = await supervisor.recover(run.id);
        if (!proof.settled) {
          safe = false;
          setLane(laneId, 'recovering', proof.reason);
        }
      }
      for (const operation of snapshot().state.operations.filter(
        (item) => item.laneId === laneId && ['pending', 'uncertain'].includes(item.state),
      )) {
        const proof = await supervisor.recover(operation.id);
        if (!proof.settled) {
          safe = false;
          setLane(laneId, 'recovering', proof.reason);
          continue;
        }
        try {
          if (operation.kind === 'inspect-config') {
            store.transaction((tx) => {
              tx.state.operations.find((item) => item.id === operation.id)!.state = 'failed';
              tx.emit('configuration.interrupted', { laneId });
            });
            continue;
          }
          if (operation.kind === 'create-branch' || operation.kind === 'fetch-remotes') {
            const owner = project(lane(laneId).projectId);
            let found = false;
            if (operation.kind === 'create-branch') {
              const facts = await git.inspect(owner.directory);
              const branch = facts.branches.find((item) => item.ref === operation.target);
              if (
                branch &&
                (branch.head !== operation.expectedHead ||
                  (operation.upstream && branch.upstream !== operation.upstream))
              )
                throw new Error(
                  'Created branch differs from its recorded intent; inspect without overwriting it',
                );
              found = Boolean(branch);
              syncBranches(owner.id, facts);
            }
            store.transaction((tx) => {
              tx.state.operations.find((item) => item.id === operation.id)!.state = found
                ? 'completed'
                : 'failed';
              if (operation.kind === 'fetch-remotes')
                tx.state.projects.find((item) => item.id === owner.id)!.remoteError =
                  '远端刷新被中断；列表可能过期，请明确重试刷新。';
              tx.emit('operation.reconciled', { operationId: operation.id, found });
            });
            continue;
          }
          if (operation.kind === 'fork-session') {
            finishFork(operation, await engine.reconcileFork(forkInput(operation)));
            continue;
          }
          if (operation.kind === 'save-memory') {
            store.transaction((tx) => {
              tx.state.operations.find((item) => item.id === operation.id)!.state = 'failed';
              const job = tx.state.memorySaves.find((item) => item.id === operation.memorySaveId)!;
              job.state = 'failed';
              job.error = '保存结果尚未确认。重试将核对原请求回执，不会重复添加记录。';
              tx.emit('memory.reconciled', { saveId: job.id });
            });
            continue;
          }
          const current = lane(laneId),
            owner = project(current.projectId);
          const found =
            operation.kind === 'prepare-worktree'
              ? await git.reconcileWorktree(owner.repository, current.ref, operation.target)
              : await engine.reconcileSession(operation.target, current.directory!);
          store.transaction((tx) => {
            const record = tx.state.operations.find((item) => item.id === operation.id)!;
            record.state = found ? 'completed' : 'failed';
            if (operation.kind === 'prepare-worktree' && typeof found === 'string')
              tx.state.lanes.find((item) => item.id === laneId)!.directory = found;
            if (operation.kind === 'create-session')
              tx.state.sessions.find((item) => item.id === operation.sessionId)!.state = found
                ? 'ready'
                : 'error';
            tx.emit('operation.reconciled', { operationId: operation.id, found: Boolean(found) });
          });
        } catch (cause) {
          safe = false;
          setLane(
            laneId,
            'recovering',
            cause instanceof Error ? cause.message : 'Operation could not be reconciled',
          );
        }
      }
      if (safe)
        setLane(
          laneId,
          'paused',
          'Recovery verified; inspect the workspace and explicitly resume queued work',
        );
      return safe;
    } finally {
      release();
    }
  }
  async function refreshRemoteRefs(laneId: string, directory: string, remote?: string) {
    const owner = project(lane(laneId).projectId);
    const operation = beginOperation(laneId, 'fetch-remotes', directory);
    try {
      await git.fetchRemotes(directory, operation.id, remote);
      syncBranches(owner.id, await git.inspect(directory));
      store.transaction((tx) => {
        tx.state.operations.find((item) => item.id === operation.id)!.state = 'completed';
        const project = tx.state.projects.find((item) => item.id === owner.id)!;
        project.remoteFetchedAt = runtime.now();
        project.remoteError = null;
        tx.emit('project.remotes', { projectId: owner.id });
      });
    } catch (error) {
      const proof = await supervisor.recover(operation.id);
      store.transaction((tx) => {
        const record = tx.state.operations.find((item) => item.id === operation.id)!;
        record.state = proof.settled ? 'failed' : 'uncertain';
        record.error = error instanceof Error ? error.message : 'Remote refresh failed';
        tx.state.projects.find((item) => item.id === owner.id)!.remoteError = record.error;
        if (!proof.settled) {
          const branch = tx.state.lanes.find((item) => item.id === laneId)!;
          branch.state = 'recovering';
          branch.reason = proof.reason;
        }
        tx.emit('project.remotes', { projectId: owner.id });
      });
      throw error;
    }
  }
  async function inspectConfiguration(laneId: string, directory: string) {
    if (!deps.configuration) throw new Error('Native configuration is unavailable');
    const operation = beginOperation(laneId, 'inspect-config', directory);
    try {
      const actual = await engine.inspectConfiguration({ operationId: operation.id, directory });
      const stored = deps.configuration.project(directory);
      store.transaction((tx) => {
        tx.state.operations.find((item) => item.id === operation.id)!.state = 'completed';
        tx.emit('configuration.inspected', { laneId });
      });
      return {
        ...stored,
        ...actual,
        trustSource: stored.trusted === actual.trusted ? stored.trustSource : 'native',
      };
    } catch (cause) {
      const proof = await supervisor.recover(operation.id);
      store.transaction((tx) => {
        const record = tx.state.operations.find((item) => item.id === operation.id)!;
        record.state = proof.settled ? 'failed' : 'uncertain';
        record.error = 'Native configuration inspection failed; inspect settings and extensions';
        tx.emit('configuration.failed', { laneId });
      });
      setLane(
        laneId,
        proof.settled ? 'paused' : 'recovering',
        proof.settled ? '配置检查失败；请修复后明确恢复队列。' : proof.reason,
      );
      throw cause;
    }
  }
  const memoryService = createMemoryService({
    store,
    memory: deps.memory,
    supervisor,
    runtime,
    withLane,
    prepare,
  });
  return {
    ...memoryService,
    async projectConfiguration(laneId: string) {
      if (!deps.configuration) throw new Error('Native configuration is unavailable');
      // Native trust hooks can execute code. Hold the lane until supervised cleanup.
      return withLane(laneId, async () => inspectConfiguration(laneId, await prepare(laneId)));
    },
    async updateProjectConfiguration(
      laneId: string,
      input:
        | { kind: 'defaults'; revision: string; model: unknown }
        | { kind: 'trust'; revision: string; decision: boolean | null },
    ) {
      if (!deps.configuration) throw new Error('Native configuration is unavailable');
      const access = deps.configuration;
      validateConfigurationRevision(input.revision);
      if (input.kind === 'trust' && input.decision !== null && typeof input.decision !== 'boolean')
        throw new Error('Choose a trust decision');
      const model = input.kind === 'defaults' ? validateDefaultModel(input.model) : null;
      return withLane(laneId, async () => {
        const directory = await prepare(laneId);
        if (input.kind === 'defaults') access.projectDefaults(directory, input.revision, model);
        else access.trust(directory, input.revision, input.decision);
        store.append('configuration.changed', { laneId, kind: input.kind });
        return inspectConfiguration(laneId, directory);
      });
    },
    snapshot,
    history(sessionId: string, before?: string, limit = 40) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error('History page size must be between 1 and 100');
      const messages = session(sessionId).messages;
      const end =
        before === undefined
          ? messages.length
          : messages.findIndex((message) => message.id === before);
      if (end < 0) throw new Error('History cursor no longer exists; reload this session');
      const start = Math.max(0, end - limit);
      return { messages: messages.slice(start, end), total: messages.length, more: start > 0 };
    },
    events: (after: number) => store.events(after),
    status: () => ({ concurrency: snapshot().state.concurrency }),
    async initialize() {
      store.transaction((tx) => {
        for (const run of tx.state.runs.filter((item) => activeStates.includes(item.state))) {
          run.state = 'interrupted';
          run.error = 'Backend restarted; input will not be replayed';
          run.endedAt = runtime.now();
          const branch = tx.state.lanes.find((item) => item.id === run.laneId)!;
          branch.state = 'recovering';
          branch.reason = run.error;
        }
        for (const operation of tx.state.operations.filter((item) =>
          ['pending', 'uncertain'].includes(item.state),
        ))
          tx.state.lanes.find((item) => item.id === operation.laneId)!.state = 'recovering';
        tx.emit('application.recovering', {});
      });
      for (const branch of snapshot().state.lanes.filter((item) => item.state === 'recovering'))
        await recoverLane(branch.id);
      for (const run of snapshot().state.runs) {
        if (run.state === 'interrupted' && !run.handoff) {
          const content = handoffContent(run);
          store.transaction((tx) => {
            tx.state.runs.find((item) => item.id === run.id)!.handoff = {
              state: 'pending',
              content,
              error: null,
            };
            tx.emit('handoff.pending', { runId: run.id });
          });
        }
        const pending = snapshot().state.runs.find((item) => item.id === run.id)!.handoff;
        if (
          pending &&
          ['pending', 'failed'].includes(pending.state) &&
          lane(run.laneId).state !== 'recovering'
        )
          setLane(
            run.laneId,
            'paused',
            '交接记录需要核对保存。请重试保存，或明确暂不保存后恢复队列。',
          );
      }
      for (const branch of snapshot().state.lanes) {
        if (branch.state !== 'recovering' && memoryBlocked(snapshot().state, branch.id))
          setLane(branch.id, 'paused', '长期记忆保存尚未完成。请重试或明确暂不保存。');
      }
      ready = true;
      pump();
    },
    async addProject(directory: string) {
      requireReady();
      const facts = await git.inspect(directory);
      const owner = store.transaction((tx) => {
        const existing = tx.state.projects.find((item) => item.repository === facts.repository);
        if (existing) return existing;
        const value: Project = {
          id: runtime.id(),
          repository: facts.repository,
          directory: facts.directory,
          title: facts.directory.split('/').filter(Boolean).at(-1) ?? facts.directory,
          createdAt: runtime.now(),
        };
        tx.state.projects.push(value);
        tx.emit('project.added', { projectId: value.id });
        return value;
      });
      syncBranches(owner.id, facts);
      return owner;
    },
    async refreshProject(id: string) {
      requireReady();
      const owner = project(id);
      syncBranches(id, await git.inspect(owner.directory));
    },
    async createBranch(input: {
      requestId: string;
      laneId: string;
      name: string;
      startRef: string;
      track: boolean;
    }) {
      const fingerprint = JSON.stringify([input.laneId, input.name, input.startRef, input.track]);
      const previous = snapshot().state.operations.find(
        (operation) => operation.requestId === input.requestId,
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new Error('Branch request ID conflicts with earlier content');
        if (previous.state !== 'completed')
          throw new Error('Previous branch creation needs reconciliation before another attempt');
        return { ref: previous.target };
      }
      return withLane(input.laneId, async () => {
        const owner = project(lane(input.laneId).projectId);
        const directory = await prepare(input.laneId);
        await git.checkBranchName(directory, input.name);
        let facts = await git.inspect(directory);
        if (facts.branches.some((branch) => branch.ref === `refs/heads/${input.name}`))
          throw new Error('Branch already exists; choose another name or use the existing branch');
        if (input.track) {
          const remote = facts.remoteBranches.find(
            (branch) => branch.ref === input.startRef,
          )?.remote;
          if (!remote) throw new Error('Remote branch no longer exists; refresh the list');
          await refreshRemoteRefs(input.laneId, directory, remote);
          facts = await git.inspect(directory);
        }
        const start = input.track
          ? facts.remoteBranches.find((branch) => branch.ref === input.startRef)
          : facts.branches.find((branch) => branch.ref === input.startRef);
        if (!start) throw new Error('Starting branch no longer exists; refresh the list');
        const operation: Operation = {
          id: runtime.id(),
          laneId: input.laneId,
          kind: 'create-branch',
          target: `refs/heads/${input.name}`,
          requestId: input.requestId,
          fingerprint,
          expectedHead: start.head,
          ...(input.track ? { upstream: start.ref } : {}),
          state: 'pending',
          error: null,
          createdAt: runtime.now(),
        };
        store.transaction((tx) => {
          tx.state.operations.push(operation);
          tx.emit('operation.started', { operationId: operation.id });
        });
        try {
          await git.createBranch(
            directory,
            input.name,
            input.track ? start.ref : start.head,
            operation.id,
            input.track,
          );
          const after = await git.inspect(directory);
          const created = after.branches.find((branch) => branch.ref === operation.target);
          if (
            !created ||
            created.head !== start.head ||
            (input.track && created.upstream !== start.ref)
          )
            throw new Error('New branch does not match its creation intent');
          syncBranches(owner.id, after);
          store.transaction((tx) => {
            tx.state.operations.find((item) => item.id === operation.id)!.state = 'completed';
            tx.emit('operation.completed', { operationId: operation.id });
          });
          return { ref: operation.target };
        } catch (error) {
          setLane(
            input.laneId,
            'recovering',
            error instanceof Error ? error.message : 'Branch creation needs reconciliation',
          );
          throw error;
        }
      });
    },
    async refreshRemotes(laneId: string) {
      return withLane(laneId, async () => refreshRemoteRefs(laneId, await prepare(laneId)));
    },
    async createSession(
      laneId: string,
      title: string,
      model: ModelSelection,
      requestId?: string,
      parentSessionId?: string,
    ) {
      const fixedModel = resolveModel(model);
      const fingerprint = JSON.stringify([
        laneId,
        title.trim() || '新会话',
        fixedModel.provider,
        fixedModel.model,
        parentSessionId ?? null,
      ]);
      if (requestId) {
        const existing = snapshot().state.sessions.find(
          (item) => item.creationRequestId === requestId,
        );
        if (existing) {
          const original =
            existing.creationFingerprint ??
            JSON.stringify([
              existing.laneId,
              existing.title,
              existing.model.provider,
              existing.model.model,
              existing.origin?.sessionId ?? null,
            ]);
          if (original !== fingerprint)
            throw new Error('Session request ID conflicts with earlier content');
          return existing;
        }
      }
      const parent = parentSessionId ? session(parentSessionId) : undefined;
      if (parent && (parent.laneId !== laneId || parent.state !== 'ready'))
        throw new Error('Continuation source must be a ready session on the same Git branch');
      return withLane(laneId, async () => {
        const directory = await prepare(laneId);
        const id = runtime.id(),
          nativeRef = engine.sessionPath(id);
        const initial: Session = {
          id,
          laneId,
          title: title.trim() || '新会话',
          nativeRef,
          model: fixedModel,
          state: 'creating',
          creationRequestId: requestId,
          creationFingerprint: fingerprint,
          pathId: parent ? (parent.pathId ?? parent.id) : runtime.id(),
          ...(parent ? { origin: { kind: 'continue' as const, sessionId: parent.id } } : {}),
          createdAt: runtime.now(),
          messages: [],
        };
        const operation = beginOperation(laneId, 'create-session', nativeRef, id, initial);
        let connection: EngineConnection | null = null;
        try {
          connection = await engine.open(
            { operationId: operation.id, directory, sessionRef: nativeRef, create: true },
            () => {},
          );
          const proof = await connection.close();
          if (!proof.settled) throw new Error(proof.reason);
          if (!(await engine.reconcileSession(nativeRef, directory)))
            throw new Error('Native session was not persisted');
          store.transaction((tx) => {
            tx.state.sessions.find((item) => item.id === id)!.state = 'ready';
            tx.state.operations.find((item) => item.id === operation.id)!.state = 'completed';
            tx.emit('session.changed', { sessionId: id });
          });
          return session(id);
        } catch (cause) {
          if (connection) await connection.close();
          setLane(
            laneId,
            'recovering',
            cause instanceof Error ? cause.message : 'Session creation interrupted',
          );
          throw cause;
        }
      });
    },
    async forkSession(sourceId: string, entryId: string, title: string, requestId: string) {
      const fingerprint = JSON.stringify(['fork', sourceId, entryId, title.trim() || '分叉会话']);
      const existing = snapshot().state.sessions.find(
        (item) => item.creationRequestId === requestId,
      );
      if (existing) {
        if (existing.creationFingerprint !== fingerprint)
          throw new Error('Session request ID conflicts with earlier content');
        return existing;
      }
      const source = session(sourceId);
      if (source.state !== 'ready') throw new Error('Fork source must be ready');
      const point = source.messages.find((message) => message.id === entryId);
      if (!point?.forkable) throw new Error('Choose an available native fork point');
      return withLane(source.laneId, async () => {
        await prepare(source.laneId);
        const id = runtime.id(),
          nativeRef = engine.sessionPath(id);
        const initial: Session = {
          id,
          laneId: source.laneId,
          title: title.trim() || '分叉会话',
          nativeRef,
          creationRequestId: requestId,
          creationFingerprint: fingerprint,
          pathId: runtime.id(),
          origin: { kind: 'fork', sessionId: source.id, entryId },
          state: 'creating',
          model: { ...source.model },
          createdAt: runtime.now(),
          messages: [],
        };
        const operation = beginOperation(source.laneId, 'fork-session', nativeRef, id, initial);
        try {
          finishFork(operation, await engine.fork(forkInput(operation)));
          return session(id);
        } catch (cause) {
          setLane(
            source.laneId,
            'recovering',
            cause instanceof Error ? cause.message : 'Fork interrupted',
          );
          throw cause;
        }
      });
    },
    saveDraft(sessionId: string, revision: number, text: string, attachmentIds: string[]) {
      requireReady();
      session(sessionId);
      return store.transaction((tx) => {
        const existing = tx.state.drafts.find((item) => item.sessionId === sessionId);
        if ((existing?.revision ?? 0) !== revision)
          throw new Error('Draft conflict: another tab saved a newer version');
        if (attachmentIds.some((id) => !tx.state.attachments.some((item) => item.id === id)))
          throw new Error('Attachment is missing');
        const next = { sessionId, revision: revision + 1, text, attachmentIds: [...attachmentIds] };
        if (existing) Object.assign(existing, next);
        else tx.state.drafts.push(next);
        tx.emit('draft.saved', { sessionId, revision: next.revision });
        return next;
      });
    },
    attachment(id: string) {
      if (!snapshot().state.attachments.some((item) => item.id === id))
        throw new Error('Attachment not found');
      return attachments.get(id);
    },
    upload(image: ImageInput) {
      requireReady();
      const attachment = attachments.put(image);
      store.transaction((tx) => {
        tx.state.attachments.push(attachment);
        tx.emit('attachment.added', { attachmentId: attachment.id });
      });
      return attachment;
    },
    enqueue(input: {
      requestId: string;
      sessionId: string;
      text: string;
      attachmentIds: string[];
    }) {
      requireReady();
      if (
        !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId) ||
        (!input.text.trim() && !input.attachmentIds.length)
      )
        throw new Error('Provide a request ID and a message or image');
      const fingerprint = JSON.stringify([input.sessionId, input.text, input.attachmentIds]);
      const record = store.transaction((tx) => {
        const existing = tx.state.runs.find((item) => item.requestId === input.requestId);
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            throw new Error('Request ID was already used for different content');
          return existing;
        }
        const target = tx.state.sessions.find((item) => item.id === input.sessionId);
        if (!target || target.state !== 'ready') throw new Error('Session is not ready');
        if (input.attachmentIds.some((id) => !tx.state.attachments.some((item) => item.id === id)))
          throw new Error('Attachment is missing');
        const bytes = input.attachmentIds.reduce(
          (total, id) => total + tx.state.attachments.find((item) => item.id === id)!.size,
          0,
        );
        if (bytes > 12 * 1024 * 1024)
          throw new Error('Images in one message must total at most 12 MiB');
        const value: Run = {
          id: runtime.id(),
          requestId: input.requestId,
          fingerprint,
          sessionId: target.id,
          laneId: target.laneId,
          text: input.text,
          attachmentIds: [...input.attachmentIds],
          model: resolveModel(target.model),
          state: 'queued',
          sequence: tx.state.runs.length + 1,
          createdAt: runtime.now(),
          endedAt: null,
          error: null,
          question: null,
          eventStart: snapshot().cursor,
        };
        tx.state.runs.push(value);
        tx.emit('run.accepted', { runId: value.id });
        return value;
      });
      pump();
      return record;
    },
    async stop(runId: string) {
      requireReady();
      const current = snapshot().state.runs.find((item) => item.id === runId);
      if (!current) throw new Error('Run not found');
      const entry = active.get(runId);
      if (!entry) {
        if (current.state === 'queued') runState(runId, 'cancelled');
        return;
      }
      entry.cancelled = true;
      if (current.state !== 'stopping') runState(runId, 'stopping');
      if (entry.connection) {
        try {
          await entry.connection.cancel();
        } catch {
          /* Force cleanup follows protocol cancellation. */
        }
        await entry.connection.close();
      }
      await entry.done;
    },
    answer(runId: string, questionId: string, value: string | boolean | null) {
      const entry = active.get(runId);
      if (!entry?.connection) throw new Error('Run is no longer waiting');
      entry.connection.answer(questionId, value);
      store.transaction((tx) => {
        const run = tx.state.runs.find((item) => item.id === runId)!;
        run.question = null;
        if (run.state === 'waiting_input') run.state = transition(run.state, 'running');
        tx.emit('run.changed', { runId });
      });
    },
    recoverLane,
    async retryHandoff(runId: string) {
      const run = snapshot().state.runs.find((item) => item.id === runId);
      if (!run?.handoff) throw new Error('Run has no handoff save');
      return withLane(run.laneId, async () => {
        if (run.handoff!.state === 'continued') throw new Error('Handoff was explicitly skipped');
        saveHandoff(runId);
        const saved = snapshot().state.runs.find((item) => item.id === runId)!.handoff!;
        if (saved.state === 'failed') throw new Error(saved.error!);
      });
    },
    async continueWithoutHandoff(runId: string) {
      const run = snapshot().state.runs.find((item) => item.id === runId);
      if (!run?.handoff) throw new Error('Run has no handoff save');
      return withLane(run.laneId, async () => {
        store.transaction((tx) => {
          const save = tx.state.runs.find((item) => item.id === runId)!.handoff!;
          if (save.state === 'saved' || save.state === 'continued') return;
          save.state = 'continued';
          tx.emit('handoff.continued', { runId });
        });
      });
    },
    async resume(laneId: string) {
      requireReady();
      if (lane(laneId).state === 'recovering') throw new Error('Verify recovery before resuming');
      if (memoryBlocked(snapshot().state, laneId))
        throw new Error('Resolve the pending memory save before resuming');
      if (
        snapshot().state.runs.some(
          (run) =>
            run.laneId === laneId &&
            run.handoff &&
            ['pending', 'failed'].includes(run.handoff.state),
        )
      )
        throw new Error(
          'Save the pending handoff or explicitly continue without it before resuming',
        );
      await withLane(laneId, async () => {
        await prepare(laneId);
        setLane(laneId, 'ready', null);
      });
    },
    setSessionModel(sessionId: string, model: ModelSelection) {
      requireReady();
      const fixed = resolveModel(model);
      store.transaction((tx) => {
        const target = tx.state.sessions.find((item) => item.id === sessionId);
        if (!target) throw new Error('Session not found');
        target.model = fixed;
        tx.emit('session.changed', { sessionId });
      });
    },
    setConcurrency(value: number) {
      const limit = concurrency(value);
      store.transaction((tx) => {
        tx.state.concurrency = limit;
        tx.emit('configuration.changed', {});
      });
      pump();
    },
    async close() {
      closing = true;
      for (const [id, item] of active) {
        const current = snapshot().state.runs.find((run) => run.id === id)!;
        if (current.state !== 'stopping') runState(id, 'stopping');
        item.cancelled = true;
        if (item.connection) await item.connection.close();
      }
      await Promise.all([...active.values()].map((item) => item.done));
      await Promise.all(maintenanceDone);
    },
  };
}
export type Harness = ReturnType<typeof createHarness>;
