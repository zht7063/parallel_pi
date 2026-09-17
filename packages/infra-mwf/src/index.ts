import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MemoryAccess, ProcessSupervisor } from '@parallel-pi/application';

const cli = fileURLToPath(
  new URL('../../../probes/.cache/mwf-source/packages/mwf/dist/cli.js', import.meta.url),
);
const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));

/** Fixed-version native operations; no native JSON escapes this adapter. */
export function createMemoryAccess(
  supervisor: ProcessSupervisor,
  inputDirectory: string,
): MemoryAccess {
  async function invoke(
    input: { operationId: string; directory: string },
    entry: string,
    args: string[],
    payload: unknown,
  ) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.operationId))
      throw new Error('Invalid memory operation ID');
    mkdirSync(inputDirectory, { recursive: true, mode: 0o700 });
    const path = join(inputDirectory, `${input.operationId}.json`);
    writeFileSync(path, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });
    let child;
    try {
      child = supervisor.start({
        id: input.operationId,
        directory: input.directory,
        command: process.execPath,
        args: [entry, ...args, path],
      });
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
    let output = '',
      stderr = '',
      exceeded = false,
      timedOut = false;
    const collect = (chunk: string, error: boolean) => {
      if (output.length + stderr.length + chunk.length > 2 * 1024 * 1024) {
        exceeded = true;
        void child.stop();
        return;
      }
      if (error) stderr += chunk;
      else output += chunk;
    };
    child.onOutput((chunk) => collect(chunk, false));
    child.onErrorOutput((chunk) => collect(chunk, true));
    const timer = setTimeout(() => {
      timedOut = true;
      void child.stop();
    }, 30000);
    try {
      const proof = await child.completion;
      if (!proof.settled) throw new Error(proof.reason);
      if (exceeded || timedOut)
        throw new Error(
          exceeded
            ? 'MWF output exceeded its limit'
            : 'MWF operation timed out; retry the original request',
        );
      if (proof.exitCode !== 0) {
        let message = 'MWF operation failed';
        try {
          message = JSON.parse(stderr.trim()).error?.message ?? message;
        } catch {
          /* Never expose raw CLI diagnostics or input. */
        }
        throw new Error(message);
      }
      try {
        return JSON.parse(output);
      } catch {
        throw new Error('Invalid MWF result');
      }
    } finally {
      clearTimeout(timer);
      rmSync(path, { force: true });
    }
  }
  return {
    async inspect(input) {
      const result = await invoke(input, worker, [], { kind: 'inspect', ...input });
      if (
        typeof result?.initialized !== 'boolean' ||
        !Array.isArray(result.records) ||
        !Number.isSafeInteger(result.total)
      )
        throw new Error('Invalid MWF view');
      return result;
    },
    async modify(input) {
      const result = await invoke(input, worker, [], { kind: 'modify', ...input });
      if (
        result?.kind !== input.change.kind ||
        typeof result.replayed !== 'boolean' ||
        (result.kind === 'update' &&
          (typeof result.id !== 'string' || typeof result.revision !== 'string'))
      )
        throw new Error('Invalid MWF change receipt');
      return result;
    },
    async add(input) {
      const result = await invoke(
        input,
        cli,
        [input.content.candidate ? 'propose' : 'add', '--input-file'],
        {
          project_root: input.directory,
          request_id: input.requestId,
          type: input.content.type,
          title: input.content.title,
          summary: input.content.summary,
          body: `${input.content.body}\n\n## 来源\n\nparallel_pi session: ${input.source.sessionId}${input.source.runId ? ` / run: ${input.source.runId}` : ''}`,
          scope: input.content.scope,
        },
      );
      if (
        !result.ok ||
        typeof result.data?.id !== 'string' ||
        typeof result.data?.path !== 'string' ||
        typeof result.data?.status !== 'string'
      )
        throw new Error('Invalid MWF save receipt');
      return {
        id: result.data.id,
        path: result.data.path,
        status: result.data.status,
        replayed: result.replayed === true,
      };
    },
  };
}
