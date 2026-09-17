import type { LaneState, RunState, ModelSelection } from '@parallel-pi/domain';

export interface Project {
  id: string;
  repository: string;
  directory: string;
  title: string;
  createdAt: number;
  model?: ModelSelection;
  remoteBranches?: { ref: string; name: string; remote: string; head: string }[];
  remoteFetchedAt?: number;
  remoteError?: string | null;
}
export interface Lane {
  id: string;
  projectId: string;
  ref: string;
  upstream?: string | null;
  directory: string | null;
  state: LaneState;
  reason: string | null;
  lastServed: number;
}
export interface Operation {
  id: string;
  laneId: string;
  kind:
    | 'prepare-worktree'
    | 'create-session'
    | 'save-memory'
    | 'create-branch'
    | 'fetch-remotes'
    | 'fork-session'
    | 'inspect-config'
    | 'inspect-memory'
    | 'change-memory'
    | 'inspect-git'
    | 'preview-git-commit'
    | 'commit-git'
    | 'recover-git-commit'
    | 'review-git-commit';
  gitCommitId?: string;
  memorySaveId?: string;
  memoryChangeId?: string;
  requestId?: string;
  fingerprint?: string;
  expectedHead?: string;
  upstream?: string;
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
  memoryChanges: MemoryChangeJob[];
  gitCommits: GitCommitJob[];
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
  remoteBranches: { ref: string; name: string; remote: string; head: string }[];
  worktrees: { directory: string; ref: string | null; head: string; locked: boolean }[];
}
export interface GitCommitPreview {
  revision: string;
  head: string;
  ref: string;
  tree: string;
  paths: string[];
  diff: string;
}
export interface GitCommitJob {
  id: string;
  requestId: string;
  laneId: string;
  directory: string;
  revision: string;
  tree: string;
  paths: string[];
  message: string;
  state: 'pending' | 'committed' | 'failed' | 'uncertain' | 'reviewed';
  phase: 'preparing' | 'hook' | 'committing' | 'reconciling' | 'done';
  hook: string | null;
  commit: string | null;
  error: string | null;
  createdAt: number;
}
export interface GitCommitResult {
  state: 'committed' | 'failed' | 'uncertain' | 'reviewed';
  commit: string | null;
  error: string | null;
}
export interface GitHookEvent {
  name: string;
  phase: 'started' | 'finished';
  exitCode?: number | null;
}
export interface WorkspaceAccess {
  previewCommit(input: {
    binding?: { repository: string; ref: string };
    directory: string;
    operationId: string;
    revision: string;
    paths: string[];
  }): Promise<GitCommitPreview>;
  commitFiles(
    input: {
      directory: string;
      operationId: string;
      jobId: string;
      tree: string;
      revision: string;
      paths: string[];
      message: string;
    },
    progress: (event: GitHookEvent) => void,
  ): Promise<GitCommitResult>;
  reviewCommit(input: {
    binding?: { repository: string; ref: string };
    directory: string;
    operationId: string;
    jobId: string;
  }): Promise<GitCommitResult>;
  recoverCommit(input: {
    binding?: { repository: string; ref: string };
    directory: string;
    operationId: string;
    jobId: string;
  }): Promise<GitCommitResult>;
  inspectChanges(directory: string, operationId: string): Promise<GitChangesView>;
  inspect(directory: string): Promise<RepositoryFacts>;
  validate(binding: { repository: string; ref: string; directory: string }): Promise<void>;
  checkBranchName(directory: string, name: string): Promise<void>;
  createBranch(
    directory: string,
    name: string,
    startRef: string,
    operationId?: string,
    track?: boolean,
  ): Promise<void>;
  fetchRemotes(directory: string, operationId: string, remote?: string): Promise<void>;
  prepareWorktree(
    directory: string,
    ref: string,
    target: string,
    operationId?: string,
  ): Promise<void>;
  /** null means absent; a different/ambiguous binding throws, never silently replaces it. */
  reconcileWorktree(repository: string, ref: string, target: string): Promise<string | null>;
}
export interface GitFileChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  partial: boolean;
  unsupported: string | null;
  stagedDiff: string;
  workingDiff: string;
}
export interface GitChangesView {
  directory: string;
  ref: string;
  head: string;
  revision: string;
  files: GitFileChange[];
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
  forkable?: boolean;
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
export interface ForkInput {
  operationId: string;
  directory: string;
  sourceRef: string;
  targetRef: string;
  entryId: string;
}
export interface ForkResult {
  messages: EngineMessage[];
  draft: { text: string; images: ImageInput[] };
}
export interface Engine {
  inspectConfiguration(input: {
    operationId: string;
    directory: string;
  }): Promise<{ trusted: boolean; effective: { provider?: string; model?: string } }>;
  fork(input: ForkInput): Promise<ForkResult>;
  reconcileFork(input: ForkInput): Promise<ForkResult | null>;
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
  creationFingerprint?: string;
  pathId?: string;
  origin?:
    { kind: 'continue'; sessionId: string } | { kind: 'fork'; sessionId: string; entryId: string };
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
export interface MemoryQuery {
  query?: string;
  path?: string;
  file_type?: string[];
  component?: string[];
  tool?: string[];
  operation?: string[];
  phase?: string[];
}
export interface MemoryRecordView {
  id: string;
  type: MemoryInput['type'];
  status: string;
  title: string;
  summary: string;
  scope: MemoryInput['scope'];
  path: string;
  revision: string;
  statuses: string[];
  reasons: string[];
}
export interface MemoryView {
  initialized: boolean;
  gitMode: 'track' | 'ignore' | null;
  records: MemoryRecordView[];
  total: number;
  record: (MemoryRecordView & { body: string; boundaries: Record<string, string> }) | null;
}
export type MemoryChange =
  | { kind: 'init'; gitMode: 'track' | 'ignore' }
  | {
      kind: 'update';
      id: string;
      revision: string;
      status: string;
      summary: string;
      body: string;
      scope: MemoryInput['scope'];
    };
export interface MemoryChangeReceipt {
  kind: 'init' | 'update';
  gitMode?: 'track' | 'ignore';
  id?: string;
  path?: string;
  revision?: string;
  replayed: boolean;
}
export interface MemoryAccess {
  inspect(input: {
    directory: string;
    operationId: string;
    query?: MemoryQuery;
    recordId?: string;
    offset?: number;
  }): Promise<MemoryView>;
  modify(input: {
    directory: string;
    operationId: string;
    requestId: string;
    change: MemoryChange;
  }): Promise<MemoryChangeReceipt>;
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

export interface MemoryChangeJob {
  id: string;
  requestId: string;
  laneId: string;
  directory: string;
  change: MemoryChange;
  state: 'pending' | 'saved' | 'failed' | 'continued';
  error: string | null;
  receipt: MemoryChangeReceipt | null;
  createdAt: number;
}
