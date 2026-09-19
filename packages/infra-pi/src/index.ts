import {
  parseSessionEntries,
  SessionManager,
} from '../../../vendor/pi/packages/coding-agent/dist/core/session-manager.js';
import { getAgentDir } from '../../../vendor/pi/packages/coding-agent/dist/config.js';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  openSync,
  fsyncSync,
  closeSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Engine,
  EngineEvent,
  EngineQuestion,
  EngineConnection,
  EngineMessage,
  AvailableModel,
  ProcessSupervisor,
  SupervisedProcess,
  ImageInput,
  ForkInput,
  ForkResult,
} from '@parallel-pi/application';

// All native JSON shapes remain inside this fixed-version adapter.
type Json = Record<string, any>;
const entry = fileURLToPath(
  new URL('../../../vendor/pi/packages/coding-agent/dist/rpc-entry.js', import.meta.url),
);
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            part?.type === 'text'
              ? part.text
              : part?.type === 'toolCall'
                ? `${part.name}: ${JSON.stringify(part.arguments)}`
                : '',
          )
          .filter(Boolean)
          .join('\n')
      : '';

function messageOf(entry: Json, forkable = false): EngineMessage {
  return {
    id: String(entry.id),
    role: entry.message.role === 'toolResult' ? 'tool' : entry.message.role,
    text: textOf(entry.message.content),
    images: Array.isArray(entry.message.content)
      ? entry.message.content
          .filter((part: Json) => part.type === 'image')
          .map((part: Json) => ({ mimeType: part.mimeType, data: part.data }))
      : [],
    forkable,
  };
}
function nativeMessages(entries: Json[], points?: Set<string>): EngineMessage[] {
  return entries
    .filter(
      (entry) =>
        entry.type === 'message' &&
        ['user', 'assistant', 'toolResult'].includes(entry.message?.role),
    )
    .map((entry) =>
      messageOf(
        entry,
        points
          ? points.has(entry.id)
          : entry.message.role === 'user' && Boolean(textOf(entry.message.content)),
      ),
    );
}

class Rpc {
  readonly process: SupervisedProcess;
  private buffer = '';
  private sequence = 0;
  private pending = new Map<
    string,
    {
      resolve(value: Json): void;
      reject(error: Error): void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private failure: Error | null = null;
  private ended = false;
  private runFailure: Error | null = null;
  private waiting: { resolve(): void; reject(error: Error): void } | null = null;
  readonly questions = new Map<string, EngineQuestion>();
  constructor(process: SupervisedProcess, emit: (event: EngineEvent) => void) {
    this.process = process;
    process.onOutput((chunk) => {
      try {
        this.buffer += chunk;
        if (this.buffer.length > 24 * 1024 * 1024)
          throw new Error('pi RPC output exceeded the message limit');
        let at: number;
        while ((at = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, at);
          this.buffer = this.buffer.slice(at + 1);
          if (!line.trim()) continue;
          const event: Json = JSON.parse(line);
          if (event.type === 'response') {
            const request = this.pending.get(event.id);
            if (request) {
              this.pending.delete(event.id);
              clearTimeout(request.timer);
              if (event.success) request.resolve(event.data ?? {});
              else request.reject(new Error(String(event.error ?? 'pi command failed')));
            }
          } else if (
            event.type === 'message_update' &&
            event.assistantMessageEvent?.type === 'text_delta'
          ) {
            emit({ type: 'text', text: String(event.assistantMessageEvent.delta) });
          } else if (
            event.type === 'message_end' &&
            event.message?.role === 'assistant' &&
            ['error', 'aborted'].includes(event.message.stopReason)
          ) {
            this.runFailure = new Error(
              event.message.errorMessage || `pi execution ${event.message.stopReason}`,
            );
          } else if (
            event.type === 'message_end' &&
            event.message?.role === 'custom' &&
            event.message.display === true
          ) {
            emit({ type: 'notice', text: textOf(event.message.content) });
          } else if (event.type === 'agent_end') {
            this.ended = true;
            if (this.runFailure) this.waiting?.reject(this.runFailure);
            else this.waiting?.resolve();
            this.waiting = null;
          } else if (
            ['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(
              event.type,
            )
          ) {
            emit({
              type: 'tool',
              id: String(event.toolCallId),
              name: String(event.toolName),
              phase:
                event.type === 'tool_execution_start'
                  ? 'start'
                  : event.type === 'tool_execution_update'
                    ? 'update'
                    : 'end',
              text:
                event.type === 'tool_execution_start'
                  ? JSON.stringify(event.args ?? {})
                  : textOf((event.result ?? event.partialResult)?.content),
              failed: Boolean(event.isError),
            });
          } else if (event.type === 'extension_ui_request') {
            if (['input', 'editor', 'select', 'confirm'].includes(event.method)) {
              const question: EngineQuestion = {
                id: String(event.id),
                kind: event.method,
                title: String(event.title ?? event.message ?? 'pi question'),
                ...(event.message !== undefined ? { message: String(event.message) } : {}),
                ...(event.options ? { options: event.options.map(String) } : {}),
                ...(event.prefill ? { prefill: String(event.prefill) } : {}),
              };
              this.questions.set(question.id, question);
              emit({ type: 'question', question });
            } else if (event.method === 'notify')
              emit({ type: 'notice', text: String(event.message) });
          }
        }
      } catch (cause) {
        this.fail(cause instanceof Error ? cause : new Error('Invalid pi output'));
        void process.stop();
      }
    });
    void process.completion.then((proof) =>
      this.fail(new Error(proof.settled ? 'pi process exited' : proof.reason)),
    );
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.waiting?.reject(error);
    this.waiting = null;
  }
  command(type: string, args: Json = {}, timeout = 30000): Promise<Json> {
    if (this.failure) return Promise.reject(this.failure);
    const id = `rpc-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = timeout
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`pi ${type} timed out`));
          }, timeout)
        : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.process.write(JSON.stringify({ ...args, type, id }) + '\n');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async execute(text: string, images: ImageInput[]) {
    this.ended = false;
    this.runFailure = null;
    await this.command(
      'prompt',
      { message: text, images: images.map((image) => ({ type: 'image', ...image })) },
      0,
    );
    if (this.failure) throw this.failure;
    if (!this.ended) {
      const state = await this.command('get_state');
      if (state.isStreaming || state.isCompacting)
        await new Promise<void>((resolve, reject) => {
          // Events may finish while get_state is in flight.
          if (this.ended) {
            if (this.runFailure) reject(this.runFailure);
            else resolve();
          } else this.waiting = { resolve, reject };
        });
    }
    if (this.runFailure) throw this.runFailure;
  }
  answer(id: string, value: string | boolean | null) {
    const question = this.questions.get(id);
    if (!question) throw new Error('Question expired or belongs to another run');
    if (value !== null && question.kind === 'confirm' && typeof value !== 'boolean')
      throw new Error('Confirmation expects a boolean');
    if (value !== null && question.kind !== 'confirm' && typeof value !== 'string')
      throw new Error('Question expects text');
    if (value !== null && question.kind === 'select' && !question.options?.includes(String(value)))
      throw new Error('Choose one of the available options');
    this.process.write(
      JSON.stringify({
        type: 'extension_ui_response',
        id,
        ...(value === null
          ? { cancelled: true }
          : question.kind === 'confirm'
            ? { confirmed: value }
            : { value }),
      }) + '\n',
    );
    this.questions.delete(id);
  }
  async cancel() {
    // Abort and question dismissal must be concurrent: abort can await the pending extension.
    const abort = this.command('abort', {}, 3000);
    for (const id of this.questions.keys()) this.answer(id, null);
    await abort;
  }
}

function sameDirectory(left: unknown, right: string): boolean {
  if (typeof left !== 'string') return false;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

export function createEngine(options: {
  supervisor: ProcessSupervisor;
  sessionRoot: string;
  agentDirectory?: string;
  extraArgs?: string[];
  env?: Record<string, string | undefined>;
}): Engine {
  mkdirSync(options.sessionRoot, { recursive: true, mode: 0o700 });
  const sessionRoot = realpathSync(options.sessionRoot);
  const agentDirectory = resolve(options.agentDirectory ?? getAgentDir());
  function forkPaths(input: ForkInput) {
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.operationId) ||
      !sameDirectory(dirname(input.sourceRef), sessionRoot) ||
      !sameDirectory(dirname(input.targetRef), sessionRoot) ||
      input.sourceRef === input.targetRef
    )
      throw new Error('Invalid application fork paths');
    const directory = join(sessionRoot, '.forks');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return {
      receipt: join(directory, `${input.operationId}.json`),
      scratch: join(directory, input.operationId),
    };
  }
  async function reconcileFork(input: ForkInput): Promise<ForkResult | null> {
    const { receipt } = forkPaths(input);
    if (!existsSync(receipt)) {
      if (existsSync(input.targetRef)) throw new Error('Fork target has no matching receipt');
      return null;
    }
    const saved = JSON.parse(readFileSync(receipt, 'utf8'));
    if (saved.version !== 1 || JSON.stringify(saved.input) !== JSON.stringify(input))
      throw new Error('Fork receipt differs from the pending intent');
    const entries: Json[] = saved.nativeContent
      .trim()
      .split('\n')
      .map((line: string) => JSON.parse(line));
    const header = entries[0];
    if (
      header?.type !== 'session' ||
      header.version !== 3 ||
      header.parentSession !== input.sourceRef ||
      !sameDirectory(header.cwd, input.directory) ||
      entries.some((entry) => entry.id === input.entryId)
    )
      throw new Error('Fork snapshot differs from its native boundary');
    if (existsSync(input.targetRef)) {
      if (readFileSync(input.targetRef, 'utf8') !== saved.nativeContent)
        throw new Error('Fork target differs from its receipt; preserve it for inspection');
    } else {
      const temporary = `${input.targetRef}.pending`;
      // A crash may leave a fully or partially written temporary. The receipt is
      // authoritative and immutable; only this unpublished private file is replaced.
      const fd = openSync(temporary, 'w', 0o600);
      try {
        writeFileSync(fd, saved.nativeContent);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      linkSync(temporary, input.targetRef);
      unlinkSync(temporary);
    }
    for (const path of [input.targetRef, sessionRoot]) {
      const fd = openSync(path, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    const selected = messageOf({
      id: input.entryId,
      message: { role: 'user', content: saved.draft },
    });
    return {
      messages: nativeMessages(entries),
      draft: { text: selected.text, images: selected.images },
    };
  }
  return {
    async inspectConfiguration(input) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.operationId))
        throw new Error('Invalid configuration inspection ID');
      const root = join(sessionRoot, '.configuration');
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const output = join(root, `${input.operationId}.json`);
      const child = options.supervisor.start({
        id: input.operationId,
        directory: input.directory,
        command: process.execPath,
        args: [
          fileURLToPath(new URL('./configuration-worker.mjs', import.meta.url)),
          input.directory,
          agentDirectory,
          output,
          JSON.stringify(options.extraArgs ?? []),
        ],
        env: {
          ...process.env,
          ...options.env,
          PI_OFFLINE: '1',
          PI_CODING_AGENT_DIR: agentDirectory,
        },
      });
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        void child.stop();
      }, 25000);
      try {
        const proof = await child.completion;
        if (!proof.settled || proof.exitCode !== 0 || expired)
          throw new Error(
            'Native project configuration could not be loaded; check settings and extensions',
          );
        const value = JSON.parse(readFileSync(output, 'utf8'));
        if (
          typeof value.trusted !== 'boolean' ||
          !value.effective ||
          [value.effective.provider, value.effective.model].some(
            (item) => item !== undefined && typeof item !== 'string',
          )
        )
          throw new Error('Invalid native configuration result');
        return value;
      } finally {
        clearTimeout(timer);
      }
    },
    reconcileFork,
    async fork(input) {
      const paths = forkPaths(input);
      if (existsSync(paths.receipt) || existsSync(input.targetRef))
        throw new Error('Fork already has artifacts; reconcile the existing operation');
      const child = options.supervisor.start({
        id: input.operationId,
        directory: input.directory,
        command: process.execPath,
        args: [
          fileURLToPath(new URL('./fork-worker.mjs', import.meta.url)),
          JSON.stringify(input),
          paths.receipt,
          paths.scratch,
        ],
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void child.stop();
      }, 30000);
      try {
        const proof = await child.completion;
        if (!proof.settled) throw new Error(proof.reason);
        if (timedOut || proof.exitCode !== 0)
          throw new Error('Native fork did not complete; reconcile before retrying');
        const result = await reconcileFork(input);
        if (!result) throw new Error('Native fork receipt is missing');
        return result;
      } finally {
        clearTimeout(timer);
      }
    },
    sessionPath(id) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid session ID');
      return join(sessionRoot, `${id}.jsonl`);
    },
    readSession(path, directory) {
      if (!sameDirectory(dirname(path), sessionRoot))
        throw new Error('Session must belong to the application data directory');
      const content = readFileSync(path, 'utf8');
      const header = JSON.parse(content.split('\n')[0] ?? '');
      if (
        header.type !== 'session' ||
        header.version !== 3 ||
        !sameDirectory(header.cwd, directory) ||
        typeof header.id !== 'string'
      )
        throw new Error('Native session does not match its workspace');
      // Native parsing/indexing without opening a writable session or loading extensions.
      return nativeMessages(
        SessionManager.inMemory(directory, undefined, parseSessionEntries(content)).getEntries(),
      );
    },
    async reconcileSession(path, directory) {
      if (!existsSync(path)) return false;
      const header = JSON.parse(readFileSync(path, 'utf8').split('\n')[0] ?? '');
      if (
        header.type !== 'session' ||
        header.version !== 3 ||
        !sameDirectory(header.cwd, directory) ||
        typeof header.id !== 'string'
      )
        throw new Error('Native session does not match the pending operation');
      return true;
    },
    async open(input, emit) {
      if (!sameDirectory(dirname(input.sessionRef), sessionRoot))
        throw new Error('Session must belong to the application data directory');
      if (input.create) writeFileSync(input.sessionRef, '', { flag: 'wx', mode: 0o600 });
      else if (!existsSync(input.sessionRef)) throw new Error('Native session file is missing');
      const processHandle = options.supervisor.start({
        id: input.operationId,
        directory: input.directory,
        command: process.execPath,
        args: [entry, '--offline', '--session', input.sessionRef, ...(options.extraArgs ?? [])],
        env: {
          ...process.env,
          ...options.env,
          PI_CODING_AGENT_DIR: agentDirectory,
        },
      });
      const rpc = new Rpc(processHandle, emit);
      try {
        const state = await rpc.command('get_state');
        if (state.sessionFile !== input.sessionRef)
          throw new Error('pi opened an unexpected native session');
        const connection: EngineConnection = {
          sessionRef: input.sessionRef,
          async models() {
            const data = await rpc.command('get_available_models');
            return data.models.map(
              (model: Json) =>
                ({
                  provider: String(model.provider),
                  model: String(model.id),
                  name: String(model.name ?? model.id),
                  images: model.input?.includes('image') === true,
                }) satisfies AvailableModel,
            );
          },
          async select(model) {
            const available = await connection.models();
            if (
              !available.some(
                (item) => item.provider === model.provider && item.model === model.model,
              )
            )
              throw new Error(
                'Selected model is unavailable or credentials are missing; no replacement was used',
              );
            await rpc.command('set_model', { provider: model.provider, modelId: model.model });
          },
          async messages() {
            const data = await rpc.command('get_entries');
            const points = await rpc.command('get_fork_messages');
            return nativeMessages(
              data.entries,
              new Set(points.messages.map((point: Json) => String(point.entryId))),
            );
          },
          execute: (text, images) => rpc.execute(text, images),
          answer: (id, value) => rpc.answer(id, value),
          cancel: () => rpc.cancel(),
          close: () => processHandle.stop(),
        };
        return connection;
      } catch (error) {
        await processHandle.stop();
        throw error;
      }
    },
  };
}

export { createConfigurationAccess } from './configuration.ts';

export { createModelCatalog } from './model-catalog.ts';
