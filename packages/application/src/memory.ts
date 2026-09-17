import type {
  AppStore,
  MemoryAccess,
  MemoryInput,
  MemorySave,
  ProcessSupervisor,
  Runtime,
} from './ports.ts';

export function memoryBlocked(state: ReturnType<AppStore['snapshot']>['state'], laneId: string) {
  return state.memorySaves.some(
    (job) => job.laneId === laneId && ['pending', 'failed'].includes(job.state),
  );
}
export function createMemoryService(deps: {
  store: AppStore;
  memory: MemoryAccess;
  supervisor: ProcessSupervisor;
  runtime: Runtime;
  withLane<T>(laneId: string, work: () => Promise<T>): Promise<T>;
  prepare(laneId: string): Promise<string>;
}) {
  const { store, memory, supervisor, runtime, withLane, prepare } = deps;
  const state = () => store.snapshot().state;
  const find = (id: string) => {
    const job = state().memorySaves.find((item) => item.id === id);
    if (!job) throw new Error('Memory save not found');
    return job;
  };
  async function attempt(job: MemorySave) {
    if (job.state === 'saved' || job.state === 'continued') return job;
    let operationId: string | null = null;
    try {
      const directory = await prepare(job.laneId);
      if (directory !== job.directory)
        throw new Error('Memory save worktree changed; preserve the original save intent');
      operationId = runtime.id();
      const id = operationId;
      store.transaction((tx) => {
        tx.state.operations.push({
          id,
          laneId: job.laneId,
          kind: 'save-memory',
          memorySaveId: job.id,
          target: directory,
          state: 'pending',
          error: null,
          createdAt: runtime.now(),
        });
        tx.state.memorySaves.find((item) => item.id === job.id)!.state = 'pending';
        tx.emit('memory.saving', { saveId: job.id });
      });
      const receipt = await memory.add({
        directory,
        operationId,
        requestId: `parallel-pi:${job.id}`,
        content: job.content,
        source: { sessionId: job.sessionId, runId: job.runId },
      });
      store.transaction((tx) => {
        const saved = tx.state.memorySaves.find((item) => item.id === job.id)!;
        saved.state = 'saved';
        saved.error = null;
        saved.receipt = receipt;
        tx.state.operations.find((item) => item.id === operationId)!.state = 'completed';
        tx.emit('memory.saved', { saveId: job.id, recordId: receipt.id });
      });
    } catch (cause) {
      const proof = operationId
        ? await supervisor.recover(operationId)
        : { settled: true, reason: 'Not started' };
      const error = cause instanceof Error ? cause.message : 'Memory save failed';
      store.transaction((tx) => {
        const saved = tx.state.memorySaves.find((item) => item.id === job.id)!;
        saved.state = 'failed';
        saved.error = error;
        const operation = tx.state.operations.find((item) => item.id === operationId);
        if (operation) {
          operation.state = proof.settled ? 'failed' : 'uncertain';
          operation.error = error;
        }
        const branch = tx.state.lanes.find((item) => item.id === job.laneId)!;
        const settled = proof.settled && branch.state !== 'recovering';
        branch.state = settled ? 'paused' : 'recovering';
        branch.reason = settled
          ? '长期记忆保存失败。可重试保存，或明确暂不保存后恢复队列。'
          : proof.reason;
        tx.emit('memory.failed', { saveId: job.id });
      });
    }
    return find(job.id);
  }
  return {
    async saveMemory(input: {
      requestId: string;
      sessionId: string;
      runId?: string;
      content: MemoryInput;
    }) {
      const session = state().sessions.find((item) => item.id === input.sessionId);
      if (!session || session.state !== 'ready') throw new Error('Session is not ready');
      if (
        input.runId &&
        !state().runs.some((run) => run.id === input.runId && run.sessionId === session.id)
      )
        throw new Error('Memory source run does not belong to this session');
      const existing = state().memorySaves.find((job) => job.requestId === input.requestId);
      if (existing) {
        if (
          existing.sessionId !== input.sessionId ||
          existing.runId !== input.runId ||
          JSON.stringify(existing.content) !== JSON.stringify(input.content)
        )
          throw new Error('Memory request ID conflicts with earlier content');
        return existing;
      }
      return withLane(session.laneId, async () => {
        const directory = await prepare(session.laneId);
        const job: MemorySave = {
          id: runtime.id(),
          requestId: input.requestId,
          sessionId: session.id,
          runId: input.runId,
          laneId: session.laneId,
          directory,
          content: input.content,
          state: 'pending',
          error: null,
          receipt: null,
          createdAt: runtime.now(),
        };
        store.transaction((tx) => {
          tx.state.memorySaves.push(job);
          tx.emit('memory.accepted', { saveId: job.id });
        });
        return attempt(job);
      });
    },
    async retryMemory(id: string) {
      const job = find(id);
      return withLane(job.laneId, () => attempt(job));
    },
    async continueWithoutMemory(id: string) {
      const job = find(id);
      return withLane(job.laneId, async () => {
        store.transaction((tx) => {
          const saved = tx.state.memorySaves.find((item) => item.id === id)!;
          if (saved.state === 'saved' || saved.state === 'continued') return;
          saved.state = 'continued';
          tx.emit('memory.continued', { saveId: id });
        });
        return find(id);
      });
    },
  };
}
