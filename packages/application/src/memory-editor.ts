import type {
  AppStore,
  MemoryAccess,
  MemoryChange,
  MemoryChangeJob,
  MemoryQuery,
  ProcessSupervisor,
  Runtime,
} from './ports.ts';
import { memoryBlocked } from './memory.ts';

export function createMemoryEditor(deps: {
  store: AppStore;
  memory: MemoryAccess;
  supervisor: ProcessSupervisor;
  runtime: Runtime;
  withLane<T>(laneId: string, work: () => Promise<T>): Promise<T>;
  prepare(laneId: string): Promise<string>;
}) {
  const { store, memory, supervisor, runtime, withLane, prepare } = deps;
  const state = () => store.snapshot().state;
  function find(id: string) {
    const job = state().memoryChanges.find((item) => item.id === id);
    if (!job) throw new Error('Memory change not found');
    return job;
  }
  async function attempt(job: MemoryChangeJob) {
    if (job.state === 'saved' || job.state === 'continued') return job;
    let operationId: string | undefined;
    try {
      const directory = await prepare(job.laneId);
      if (directory !== job.directory)
        throw new Error('Memory workspace changed; preserve the original intent');
      operationId = runtime.id();
      const id = operationId;
      store.transaction((tx) => {
        tx.state.operations.push({
          id,
          laneId: job.laneId,
          kind: 'change-memory',
          memoryChangeId: job.id,
          target: directory,
          state: 'pending',
          error: null,
          createdAt: runtime.now(),
        });
        tx.state.memoryChanges.find((item) => item.id === job.id)!.state = 'pending';
        tx.emit('memory.change-started', { changeId: job.id });
      });
      const receipt = await memory.modify({
        directory,
        operationId,
        requestId: job.id,
        change: job.change,
      });
      store.transaction((tx) => {
        const saved = tx.state.memoryChanges.find((item) => item.id === job.id)!;
        saved.state = 'saved';
        saved.error = null;
        saved.receipt = receipt;
        tx.state.operations.find((item) => item.id === operationId)!.state = 'completed';
        tx.emit('memory.change-saved', { changeId: job.id });
      });
    } catch (cause) {
      const proof = operationId
        ? await supervisor.recover(operationId)
        : { settled: true, reason: 'Not started' };
      const error = cause instanceof Error ? cause.message : 'Memory change failed';
      store.transaction((tx) => {
        const saved = tx.state.memoryChanges.find((item) => item.id === job.id)!;
        saved.state = 'failed';
        saved.error = error;
        const operation = tx.state.operations.find((item) => item.id === operationId);
        if (operation) {
          operation.state = proof.settled ? 'failed' : 'uncertain';
          operation.error = error;
        }
        const lane = tx.state.lanes.find((item) => item.id === job.laneId)!;
        const settled = proof.settled && lane.state !== 'recovering';
        lane.state = settled ? 'paused' : 'recovering';
        lane.reason = settled
          ? '记忆修改尚未确认。请重试原修改，或明确暂不保存后重新读取。'
          : proof.reason;
        tx.emit('memory.change-failed', { changeId: job.id });
      });
    }
    return find(job.id);
  }
  return {
    async inspectMemory(
      laneId: string,
      input: { query?: MemoryQuery; recordId?: string; offset?: number } = {},
    ) {
      return withLane(laneId, async () => {
        const directory = await prepare(laneId);
        const operationId = runtime.id();
        store.transaction((tx) => {
          tx.state.operations.push({
            id: operationId,
            laneId,
            kind: 'inspect-memory',
            target: directory,
            state: 'pending',
            error: null,
            createdAt: runtime.now(),
          });
          tx.emit('memory.inspecting', { laneId });
        });
        try {
          const view = await memory.inspect({ directory, operationId, ...input });
          store.transaction((tx) => {
            tx.state.operations.find((item) => item.id === operationId)!.state = 'completed';
            tx.emit('memory.inspected', { laneId });
          });
          return view;
        } catch (cause) {
          const proof = await supervisor.recover(operationId);
          store.transaction((tx) => {
            tx.state.operations.find((item) => item.id === operationId)!.state = proof.settled
              ? 'failed'
              : 'uncertain';
            const lane = tx.state.lanes.find((item) => item.id === laneId)!;
            lane.state = proof.settled ? 'paused' : 'recovering';
            lane.reason = proof.settled ? '记忆读取失败；请检查后重试。' : proof.reason;
            tx.emit('memory.inspection-failed', { laneId });
          });
          throw cause;
        }
      });
    },
    async changeMemory(input: { laneId: string; requestId: string; change: MemoryChange }) {
      const existing = state().memoryChanges.find((job) => job.requestId === input.requestId);
      if (existing) {
        if (
          existing.laneId !== input.laneId ||
          JSON.stringify(existing.change) !== JSON.stringify(input.change)
        )
          throw new Error('Memory request ID conflicts with earlier content');
        return existing;
      }
      return withLane(input.laneId, async () => {
        if (
          input.change.kind === 'init'
            ? state().memoryChanges.some(
                (job) => job.laneId === input.laneId && ['pending', 'failed'].includes(job.state),
              )
            : memoryBlocked(state(), input.laneId)
        )
          throw new Error('Resolve the pending memory write before starting another change');
        const directory = await prepare(input.laneId);
        const job: MemoryChangeJob = {
          id: runtime.id(),
          requestId: input.requestId,
          laneId: input.laneId,
          directory,
          change: input.change,
          state: 'pending',
          error: null,
          receipt: null,
          createdAt: runtime.now(),
        };
        store.transaction((tx) => {
          tx.state.memoryChanges.push(job);
          tx.emit('memory.change-accepted', { changeId: job.id });
        });
        return attempt(job);
      });
    },
    async retryMemoryChange(id: string) {
      const job = find(id);
      return withLane(job.laneId, () => attempt(job));
    },
    async continueWithoutMemoryChange(id: string) {
      const job = find(id);
      return withLane(job.laneId, async () => {
        store.transaction((tx) => {
          const saved = tx.state.memoryChanges.find((item) => item.id === id)!;
          if (saved.state === 'saved' || saved.state === 'continued') return;
          saved.state = 'continued';
          tx.emit('memory.change-continued', { changeId: id });
        });
        return find(id);
      });
    },
  };
}
