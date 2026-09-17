import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  Harness,
  MemoryInput,
  MemoryChange,
  MemoryQuery,
  GitCommitJob,
} from '@parallel-pi/application';
import type { WorkspaceSnapshot, WorkspaceEvent, GitCommitSnapshot } from '@parallel-pi/contracts';

function projectGitCommit({
  id,
  requestId,
  laneId,
  paths,
  message,
  state,
  phase,
  hook,
  commit,
  error,
}: GitCommitJob): GitCommitSnapshot {
  return { id, requestId, laneId, paths, message, state, phase, hook, commit, error };
}

export function projectSnapshot(app: Harness): WorkspaceSnapshot {
  const { state, cursor } = app.snapshot();
  const lastActivity = new Map<string, number>();
  for (const run of state.runs)
    lastActivity.set(
      run.sessionId,
      Math.max(lastActivity.get(run.sessionId) ?? 0, run.createdAt, run.endedAt ?? 0),
    );
  return {
    repositoryRecovery: state.operations
      .filter(
        (item) =>
          item.laneId === null && item.state === 'uncertain' && item.kind === 'inspect-repository',
      )
      .map((item) => ({ id: item.id, directory: item.target, reason: item.error })),
    gitCommits: state.gitCommits.map(projectGitCommit),
    cursor,
    concurrency: state.concurrency,
    drafts: state.drafts,
    memoryChanges: state.memoryChanges.map((job) => ({
      id: job.id,
      laneId: job.laneId,
      kind: job.change.kind,
      recordId: job.change.kind === 'update' ? job.change.id : null,
      summary: job.change.kind === 'update' ? job.change.summary : `初始化 ${job.change.gitMode}`,
      state: job.state,
      error: job.error,
    })),
    memorySaves: state.memorySaves.map((job) => ({
      id: job.id,
      sessionId: job.sessionId,
      runId: job.runId,
      laneId: job.laneId,
      title: job.content.title,
      state: job.state,
      error: job.error,
      recordId: job.receipt?.id ?? null,
    })),
    projects: state.projects.map(
      ({ id, directory, title, model, remoteBranches, remoteFetchedAt, remoteError }) => ({
        id,
        directory,
        title,
        model,
        remoteBranches: remoteBranches ?? [],
        remoteFetchedAt: remoteFetchedAt ?? null,
        remoteError: remoteError ?? null,
      }),
    ),
    lanes: state.lanes.map(({ id, projectId, ref, upstream, directory, state, reason }) => ({
      id,
      projectId,
      ref,
      upstream: upstream ?? null,
      directory,
      state,
      reason,
    })),
    sessions: state.sessions.map(
      ({ id, laneId, title, state, model, messages, pathId, origin, createdAt }) => ({
        id,
        laneId,
        title,
        state,
        model,
        messages: messages.slice(-40),
        messageCount: messages.length,
        pathId: pathId ?? id,
        createdAt,
        lastActivityAt: lastActivity.get(id) ?? createdAt,
        origin,
      }),
    ),
    runs: state.runs.map(
      ({ id, sessionId, laneId, text, attachmentIds, model, state, error, question, handoff }) => ({
        id,
        sessionId,
        laneId,
        text,
        attachmentIds,
        model,
        state,
        error,
        question,
        handoff: handoff ? { state: handoff.state, error: handoff.error } : undefined,
      }),
    ),
    attachments: state.attachments,
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0'))
    throw new Error('Invalid or missing text field');
  return value;
}
function model(value: unknown) {
  const fields = object(value);
  return { provider: string(fields.provider, 128), model: string(fields.model, 256) };
}
function id(value: unknown) {
  const result = string(value, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error('Invalid ID');
  return result;
}
function memoryContent(value: unknown): MemoryInput {
  const fields = object(value);
  const type = string(fields.type);
  if (
    !['preference', 'decision', 'knowledge', 'incident', 'task'].includes(type) ||
    typeof fields.candidate !== 'boolean'
  )
    throw new Error('Invalid memory type or candidate state');
  const scope = object(fields.scope);
  const keys = ['paths', 'file_types', 'components', 'tools', 'operations', 'phases', 'keywords'];
  if (Object.keys(scope).some((key) => !keys.includes(key)))
    throw new Error('Unknown memory scope field');
  const normalized: MemoryInput['scope'] = {};
  for (const key of keys) {
    const entries = scope[key];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.length > 100) throw new Error('Invalid memory scope');
    normalized[key as keyof MemoryInput['scope']] = entries.map((entry) => string(entry, 500));
  }
  return {
    type: type as MemoryInput['type'],
    title: string(fields.title, 500),
    summary: string(fields.summary, 4000),
    body: string(fields.body, 200000),
    candidate: fields.candidate,
    scope: normalized,
  };
}
export async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw new Error('Expected application/json');
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16 * 1024 * 1024) throw new Error('Request exceeds 16 MiB');
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON request');
  }
  return object(parsed);
}
export async function command(app: Harness, input: Record<string, unknown>): Promise<unknown> {
  switch (input.type) {
    case 'project.configuration':
      return app.projectConfiguration(id(input.laneId));
    case 'project.defaults':
      return app.updateProjectConfiguration(id(input.laneId), {
        kind: 'defaults',
        revision: string(input.revision),
        model: input.model,
      });
    case 'project.trust':
      if (input.decision !== null && typeof input.decision !== 'boolean')
        throw new Error('Choose a trust decision');
      return app.updateProjectConfiguration(id(input.laneId), {
        kind: 'trust',
        revision: string(input.revision),
        decision: input.decision,
      });
    case 'project.add': {
      const value = await app.addProject(string(input.directory));
      return { id: value.id };
    }
    case 'project.refresh':
      await app.refreshProject(id(input.projectId));
      return {};
    case 'branch.create':
      if (typeof input.track !== 'boolean')
        throw new Error('Choose local or remote branch creation');
      return app.createBranch({
        requestId: id(input.requestId),
        laneId: id(input.laneId),
        name: string(input.name, 256),
        startRef: string(input.startRef, 1024),
        track: input.track,
      });
    case 'project.fetch':
      await app.refreshRemotes(id(input.laneId));
      return {};
    case 'session.create': {
      const value = await app.createSession(
        id(input.laneId),
        typeof input.title === 'string' ? input.title.slice(0, 200) : '',
        model(input.model),
        input.requestId === undefined ? undefined : id(input.requestId),
        input.parentSessionId === undefined ? undefined : id(input.parentSessionId),
      );
      return { id: value.id };
    }
    case 'session.fork': {
      const value = await app.forkSession(
        id(input.sessionId),
        id(input.entryId),
        typeof input.title === 'string' ? input.title.slice(0, 200) : '',
        id(input.requestId),
      );
      return { id: value.id };
    }
    case 'session.model':
      app.setSessionModel(id(input.sessionId), model(input.model));
      return {};
    case 'draft.save': {
      if (
        !Number.isSafeInteger(input.revision) ||
        Number(input.revision) < 0 ||
        typeof input.text !== 'string' ||
        input.text.length > 100000 ||
        !Array.isArray(input.attachmentIds) ||
        input.attachmentIds.length > 10
      )
        throw new Error('Invalid draft');
      return app.saveDraft(
        id(input.sessionId),
        Number(input.revision),
        input.text,
        input.attachmentIds.map(id),
      );
    }
    case 'attachment.upload': {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(input.mimeType)))
        throw new Error('Select PNG, JPEG or WebP');
      return app.upload({
        mimeType: input.mimeType as 'image/png' | 'image/jpeg' | 'image/webp',
        data: string(input.data, 14 * 1024 * 1024),
      });
    }
    case 'run.enqueue': {
      if (!Array.isArray(input.attachmentIds) || input.attachmentIds.length > 10)
        throw new Error('At most 10 attachments per message');
      if (typeof input.text !== 'string' || input.text.length > 100000 || input.text.includes('\0'))
        throw new Error('Invalid message');
      const run = app.enqueue({
        requestId: id(input.requestId),
        sessionId: id(input.sessionId),
        text: input.text,
        attachmentIds: input.attachmentIds.map(id),
      });
      return { id: run.id, state: run.state };
    }
    case 'git.preview-commit':
    case 'git.commit': {
      if (!Array.isArray(input.paths)) throw new Error('Select whole files');
      const paths = input.paths.map((path) => string(path, 8192));
      const laneId = id(input.laneId),
        revision = string(input.revision, 128);
      return input.type === 'git.preview-commit'
        ? app.previewGitCommit(laneId, revision, paths)
        : app
            .commitGit({
              laneId,
              revision,
              paths,
              requestId: id(input.requestId),
              tree: string(input.tree, 128),
              message: string(input.message, 65536),
            })
            .then(projectGitCommit);
    }
    case 'git.review':
      if (input.confirmed !== true)
        throw new Error('Confirm external Git inspection before continuing');
      return app.reconcileGitCommit(id(input.jobId), true).then(projectGitCommit);
    case 'git.reconcile':
      return app.reconcileGitCommit(id(input.jobId)).then(projectGitCommit);
    case 'git.inspect':
      return app.inspectGit(id(input.laneId));
    case 'memory.inspect': {
      let query: MemoryQuery | undefined;
      if (input.query !== undefined) {
        const fields = object(input.query);
        query = {};
        for (const key of ['query', 'path'] as const)
          if (fields[key] !== undefined) {
            if (fields[key] === '') query[key] = '';
            else query[key] = string(fields[key], 20000);
          }
        for (const key of ['file_type', 'component', 'tool', 'operation', 'phase'] as const)
          if (fields[key] !== undefined) {
            const items = fields[key];
            if (!Array.isArray(items) || items.length > 100)
              throw new Error('Invalid memory query');
            query[key] = items.map((value) => string(value, 500));
          }
      }
      if (
        input.offset !== undefined &&
        (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0)
      )
        throw new Error('Invalid memory offset');
      return app.inspectMemory(id(input.laneId), {
        query,
        recordId: input.recordId === undefined ? undefined : string(input.recordId, 128),
        offset: input.offset as number | undefined,
      });
    }
    case 'memory.change': {
      const fields = object(input.change);
      let change: MemoryChange;
      if (fields.kind === 'init' && (fields.gitMode === 'track' || fields.gitMode === 'ignore'))
        change = { kind: 'init', gitMode: fields.gitMode };
      else if (fields.kind === 'update') {
        const content = memoryContent({
          ...fields,
          type: 'knowledge',
          title: 'Correction',
          candidate: false,
        });
        const revision = string(fields.revision, 64);
        if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid memory revision');
        change = {
          kind: 'update',
          id: string(fields.id, 128),
          revision,
          status: string(fields.status, 64),
          summary: content.summary,
          body: content.body,
          scope: content.scope,
        };
      } else throw new Error('Invalid memory change');
      const job = await app.changeMemory({
        laneId: id(input.laneId),
        requestId: id(input.requestId),
        change,
      });
      return { id: job.id, state: job.state, error: job.error };
    }
    case 'memory.change.retry': {
      const job = await app.retryMemoryChange(id(input.changeId));
      return { id: job.id, state: job.state, error: job.error };
    }
    case 'memory.change.continue':
      await app.continueWithoutMemoryChange(id(input.changeId));
      return {};
    case 'memory.save': {
      const job = await app.saveMemory({
        requestId: id(input.requestId),
        sessionId: id(input.sessionId),
        runId: input.runId === undefined ? undefined : id(input.runId),
        content: memoryContent(input.content),
      });
      return { id: job.id, state: job.state };
    }
    case 'memory.retry': {
      const job = await app.retryMemory(id(input.saveId));
      return { id: job.id, state: job.state };
    }
    case 'memory.continue':
      await app.continueWithoutMemory(id(input.saveId));
      return {};
    case 'handoff.retry':
      await app.retryHandoff(id(input.runId));
      return {};
    case 'handoff.continue':
      await app.continueWithoutHandoff(id(input.runId));
      return {};
    case 'run.stop':
      await app.stop(id(input.runId));
      return {};
    case 'run.answer': {
      if (
        input.value !== null &&
        typeof input.value !== 'boolean' &&
        typeof input.value !== 'string'
      )
        throw new Error('Invalid answer');
      if (typeof input.value === 'string' && input.value.length > 100000)
        throw new Error('Answer is too long');
      app.answer(id(input.runId), id(input.questionId), input.value);
      return {};
    }
    case 'lane.recover':
      return { settled: await app.recoverLane(id(input.laneId)) };
    case 'lane.resume':
      await app.resume(id(input.laneId));
      return {};
    case 'concurrency.set': {
      if (typeof input.value !== 'number') throw new Error('Invalid concurrency');
      app.setConcurrency(input.value);
      return {};
    }
    default:
      throw new Error('Unknown command');
  }
}
export function subscribe(
  app: Harness,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  const after = Number(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
  if (!Number.isSafeInteger(after) || after < 0 || after > app.snapshot().cursor)
    throw new Error('Invalid event cursor; refresh the snapshot');
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  response.write(': connected\n\n');
  let cursor = after;
  const timer = setInterval(() => {
    try {
      for (const event of app.events(cursor)) {
        const wire: WorkspaceEvent = { cursor: event.cursor, type: 'changed', reason: event.type };
        response.write(`id: ${event.cursor}\ndata: ${JSON.stringify(wire)}\n\n`);
        cursor = event.cursor;
      }
      if (response.writableLength > 1024 * 1024) response.destroy();
    } catch {
      response.end();
    }
  }, 250);
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
  response.once('close', () => {
    clearInterval(timer);
    clearInterval(heartbeat);
  });
}
