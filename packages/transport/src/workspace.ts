import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Harness, MemoryInput } from '@parallel-pi/application';
import type { WorkspaceSnapshot, WorkspaceEvent } from '@parallel-pi/contracts';

export function projectSnapshot(app: Harness): WorkspaceSnapshot {
  const { state, cursor } = app.snapshot();
  return {
    cursor,
    concurrency: state.concurrency,
    drafts: state.drafts,
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
    projects: state.projects.map(({ id, directory, title, model }) => ({
      id,
      directory,
      title,
      model,
    })),
    lanes: state.lanes.map(({ id, projectId, ref, directory, state, reason }) => ({
      id,
      projectId,
      ref,
      directory,
      state,
      reason,
    })),
    sessions: state.sessions.map(({ id, laneId, title, state, model, messages }) => ({
      id,
      laneId,
      title,
      state,
      model,
      messages,
    })),
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
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
export async function command(app: Harness, input: Record<string, unknown>): Promise<unknown> {
  switch (input.type) {
    case 'project.add': {
      const value = await app.addProject(string(input.directory));
      return { id: value.id };
    }
    case 'project.refresh':
      await app.refreshProject(id(input.projectId));
      return {};
    case 'session.create': {
      const value = await app.createSession(
        id(input.laneId),
        typeof input.title === 'string' ? input.title.slice(0, 200) : '',
        model(input.model),
        input.requestId === undefined ? undefined : id(input.requestId),
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
