import type { LaneState, RunState, ModelSelection } from '@parallel-pi/domain';

export interface Project {
  id: string;
  repository: string;
  directory: string;
  title: string;
  createdAt: number;
  model?: ModelSelection;
}
export interface Lane {
  id: string;
  projectId: string;
  ref: string;
  directory: string | null;
  state: LaneState;
  reason: string | null;
  lastServed: number;
}
export interface Operation {
  id: string;
  laneId: string;
  kind: 'prepare-worktree' | 'create-session' | 'save-memory';
  memorySaveId?: string;
  sessionId?: string;
  target: string;
  state: 'pending' | 'completed' | 'failed' | 'uncertain';
  error: string | null;
  createdAt: number;
}
export interface AppState {
  projects: Project[];
  lanes: Lane[];
  operations: Operation[];
  sessions: Session[];
  runs: Run[];
  attachments: Attachment[];
  concurrency: number;
  drafts: Draft[];
  memorySaves: MemorySave[];
}
export interface AppEvent {
  cursor: number;
  version: 1;
  type: string;
  at: number;
  data: unknown;
}
export interface Transaction {
  state: AppState;
  emit(type: string, data: unknown): void;
}
/** Synchronous transaction: metadata and emitted events either both commit or neither does. */
export interface AppStore {
  snapshot(): { state: AppState; cursor: number };
  transaction<T>(update: (transaction: Transaction) => T): T;
  events(after: number, limit?: number): AppEvent[];
  append(type: string, data: unknown): void;
  close(): void;
}
export interface RepositoryFacts {
  repository: string;
  directory: string;
  ref: string;
  head: string;
  dirty: boolean;
  branches: { ref: string; head: string; upstream: string | null }[];
  worktrees: { directory: string; ref: string | null; head: string; locked: boolean }[];
}
export interface WorkspaceAccess {
  inspect(directory: string): Promise<RepositoryFacts>;
  validate(binding: { repository: string; ref: string; directory: string }): Promise<void>;
  createBranch(directory: string, name: string, startRef: string): Promise<void>;
  prepareWorktree(
    directory: string,
    ref: string,
    target: string,
    operationId?: string,
  ): Promise<void>;
  /** null means absent; a different/ambiguous binding throws, never silently replaces it. */
  reconcileWorktree(repository: string, ref: string, target: string): Promise<string | null>;
}
export interface Runtime {
  id(): string;
  now(): number;
  worktreePath(laneId: string): string;
}

export interface ProcessSpec {
  id: string;
  directory: string;
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
}
export interface ReapEvidence {
  settled: boolean;
  exitCode: number | null;
  reason: string;
}
export interface SupervisedProcess {
  write(data: string): void;
  onOutput(listener: (data: string) => void): () => void;
  onErrorOutput(listener: (data: string) => void): () => void;
  completion: Promise<ReapEvidence>;
  stop(): Promise<ReapEvidence>;
}
export interface ProcessSupervisor {
  start(spec: ProcessSpec): SupervisedProcess;
  recover(id: string): Promise<ReapEvidence>;
}

export interface ImageInput {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: string;
}
export interface AvailableModel {
  provider: string;
  model: string;
  name: string;
  images: boolean;
}
export interface EngineMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  images: ImageInput[];
}
export interface EngineQuestion {
  id: string;
  kind: 'input' | 'editor' | 'select' | 'confirm';
  title: string;
  options?: string[];
  prefill?: string;
}
export type EngineEvent =
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      phase: 'start' | 'update' | 'end';
      text: string;
      failed?: boolean;
    }
  | { type: 'question'; question: EngineQuestion }
  | { type: 'notice'; text: string };
export interface EngineConnection {
  sessionRef: string;
  models(): Promise<AvailableModel[]>;
  select(model: ModelSelection): Promise<void>;
  messages(): Promise<EngineMessage[]>;
  execute(text: string, images: ImageInput[]): Promise<void>;
  answer(id: string, value: string | boolean | null): void;
  cancel(): Promise<void>;
  close(): Promise<ReapEvidence>;
}
export interface Engine {
  open(
    input: { operationId: string; directory: string; sessionRef: string; create?: boolean },
    emit: (event: EngineEvent) => void,
  ): Promise<EngineConnection>;
  sessionPath(id: string): string;
  reconcileSession(path: string, directory: string): Promise<boolean>;
}

export interface Session {
  id: string;
  laneId: string;
  title: string;
  nativeRef: string;
  creationRequestId?: string;
  state: 'creating' | 'ready' | 'error';
  model: ModelSelection;
  createdAt: number;
  messages: EngineMessage[];
}
export interface Run {
  id: string;
  requestId: string;
  fingerprint: string;
  sessionId: string;
  laneId: string;
  text: string;
  attachmentIds: string[];
  model: ModelSelection;
  state: RunState;
  sequence: number;
  createdAt: number;
  endedAt: number | null;
  error: string | null;
  question: EngineQuestion | null;
  eventStart?: number;
  handoff?: HandoffSave;
}
export interface Attachment {
  id: string;
  mimeType: ImageInput['mimeType'];
  size: number;
}
export interface AttachmentStore {
  put(image: ImageInput): Attachment;
  get(id: string): ImageInput;
}

export interface Draft {
  sessionId: string;
  revision: number;
  text: string;
  attachmentIds: string[];
}

/** Application-owned evidence; never treated as a MWF knowledge record. */
export interface RunHandoff {
  version: 1;
  runId: string;
  sessionId: string;
  laneId: string;
  ref: string;
  nativeSession: string;
  request: string;
  attachmentIds: string[];
  outcome: RunState;
  error: string | null;
  endedAt: number;
  observedAssistant: string;
  truncated: boolean;
  eventRange: { after: number; through: number };
}
export interface HandoffSave {
  state: 'pending' | 'saved' | 'failed' | 'continued';
  content: RunHandoff;
  error: string | null;
}
export interface HandoffStore {
  /** Same ID/content is replayable; different contents must never overwrite a record. */
  put(content: RunHandoff): void;
}

export interface MemoryInput {
  type: 'preference' | 'decision' | 'knowledge' | 'incident' | 'task';
  title: string;
  summary: string;
  body: string;
  candidate: boolean;
  scope: Partial<
    Record<
      'paths' | 'file_types' | 'components' | 'tools' | 'operations' | 'phases' | 'keywords',
      string[]
    >
  >;
}
export interface MemoryReceipt {
  id: string;
  path: string;
  status: string;
  replayed: boolean;
}
export interface MemoryAccess {
  add(input: {
    directory: string;
    operationId: string;
    requestId: string;
    content: MemoryInput;
    source: { sessionId: string; runId?: string };
  }): Promise<MemoryReceipt>;
}
export interface MemorySave {
  id: string;
  requestId: string;
  sessionId: string;
  runId?: string;
  laneId: string;
  directory: string;
  content: MemoryInput;
  state: 'pending' | 'saved' | 'failed' | 'continued';
  error: string | null;
  receipt: MemoryReceipt | null;
  createdAt: number;
}
