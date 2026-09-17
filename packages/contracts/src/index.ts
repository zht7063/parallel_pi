/** Public wire DTOs. No native pi events or database rows cross this boundary. */
export interface ServiceStatus {
  service: 'parallel_pi';
  protocolVersion: 1;
  concurrency: number;
}
export interface ApiError {
  error: { code: string; message: string };
}

export interface ModelChoice {
  provider: string;
  model: string;
}
export interface WorkspaceSnapshot {
  cursor: number;
  drafts: { sessionId: string; revision: number; text: string; attachmentIds: string[] }[];
  concurrency: number;
  memorySaves: {
    id: string;
    sessionId: string;
    runId?: string;
    laneId: string;
    title: string;
    state: 'pending' | 'saved' | 'failed' | 'continued';
    error: string | null;
    recordId: string | null;
  }[];
  projects: {
    id: string;
    directory: string;
    title: string;
    model?: ModelChoice;
    remoteBranches: { ref: string; name: string; remote: string; head: string }[];
    remoteFetchedAt: number | null;
    remoteError: string | null;
  }[];
  lanes: {
    id: string;
    projectId: string;
    ref: string;
    upstream: string | null;
    directory: string | null;
    state: 'ready' | 'paused' | 'recovering';
    reason: string | null;
  }[];
  sessions: {
    id: string;
    pathId: string;
    createdAt: number;
    lastActivityAt: number;
    origin?:
      | { kind: 'continue'; sessionId: string }
      | { kind: 'fork'; sessionId: string; entryId: string };
    laneId: string;
    title: string;
    state: 'creating' | 'ready' | 'error';
    model: ModelChoice;
    messageCount: number;
    messages: {
      id: string;
      role: 'user' | 'assistant' | 'tool';
      text: string;
      images: { mimeType: string; data: string }[];
      forkable?: boolean;
    }[];
  }[];
  runs: {
    id: string;
    sessionId: string;
    laneId: string;
    text: string;
    attachmentIds: string[];
    model: ModelChoice;
    state:
      | 'queued'
      | 'starting'
      | 'running'
      | 'waiting_input'
      | 'stopping'
      | 'succeeded'
      | 'failed'
      | 'cancelled'
      | 'interrupted';
    error: string | null;
    handoff?: { state: 'pending' | 'saved' | 'failed' | 'continued'; error: string | null };
    question: {
      id: string;
      kind: 'input' | 'editor' | 'select' | 'confirm';
      title: string;
      options?: string[];
      prefill?: string;
    } | null;
  }[];
  attachments: { id: string; mimeType: string; size: number }[];
}
/** SSE invalidation is durable and ordered. Full state is fetched without resubmitting commands. */
export interface WorkspaceEvent {
  cursor: number;
  type: 'changed';
  reason: string;
}

export interface RunActivity {
  cursor: number;
  runId: string;
  kind: 'text' | 'tool' | 'question' | 'notice';
  text: string;
  phase?: string;
  name?: string;
}

export interface HistoryPage {
  messages: WorkspaceSnapshot['sessions'][number]['messages'];
  total: number;
  more: boolean;
}

export interface ConfigurationSnapshot {
  settingsRevision: string;
  credentialsRevision: string;
  defaults: { provider?: string; model?: string };
  credentials: { provider: string; type: string }[];
}

export interface ProjectConfigurationSnapshot {
  directory: string;
  settingsRevision: string;
  trustRevision: string;
  defaults: { provider?: string; model?: string };
  globalDefaults: { provider?: string; model?: string };
  effective: { provider?: string; model?: string };
  trusted: boolean;
  trustSource: string;
  decisionSource: string;
  decision: boolean | null;
}

export interface CatalogModel {
  provider: string;
  model: string;
  name: string;
  images: boolean;
  available: boolean;
}
