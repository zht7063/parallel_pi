import { concurrency, DEFAULT_CONCURRENCY } from '@parallel-pi/domain';

export function createApplication(options: { concurrency?: number } = {}) {
  const limit = concurrency(options.concurrency ?? DEFAULT_CONCURRENCY);
  return {
    status() {
      return { concurrency: limit };
    },
  };
}
export type Application = ReturnType<typeof createApplication>;

export type {
  AppStore,
  AppState,
  AppEvent,
  Transaction,
  Project,
  Lane,
  Operation,
  RepositoryFacts,
  WorkspaceAccess,
  Runtime,
} from './ports.ts';
export type { ProcessSpec, ReapEvidence, SupervisedProcess, ProcessSupervisor } from './ports.ts';
export type {
  ImageInput,
  AvailableModel,
  EngineMessage,
  EngineQuestion,
  EngineEvent,
  EngineConnection,
  Engine,
} from './ports.ts';

export type { Session, Run, Attachment, AttachmentStore } from './ports.ts';
export { createHarness } from './harness.ts';
export type { Harness } from './harness.ts';

export type { Draft } from './ports.ts';

export type { RunHandoff, HandoffSave, HandoffStore } from './ports.ts';

export type { MemoryInput, MemoryReceipt, MemoryAccess, MemorySave } from './ports.ts';
