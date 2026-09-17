import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MemoryAccess, ProcessSupervisor } from '@parallel-pi/application';

const cli = fileURLToPath(
  new URL('../../../probes/.cache/mwf-source/packages/mwf/dist/cli.js', import.meta.url),
);

/** Fixed-version native CLI; no native JSON escapes this adapter. */
export function createMemoryAccess(
  supervisor: ProcessSupervisor,
  inputDirectory: string,
): MemoryAccess {
  return {
    async add(input) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.operationId))
        throw new Error('Invalid memory operation ID');
      mkdirSync(inputDirectory, { recursive: true, mode: 0o700 });
      const path = join(inputDirectory, `${input.operationId}.json`);
      const payload = {
        project_root: input.directory,
        request_id: input.requestId,
        type: input.content.type,
        title: input.content.title,
        summary: input.content.summary,
        body: `${input.content.body}\n\n## 来源\n\nparallel_pi session: ${input.source.sessionId}${input.source.runId ? ` / run: ${input.source.runId}` : ''}`,
        scope: input.content.scope,
      };
      writeFileSync(path, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });
      let child;
      try {
        child = supervisor.start({
          id: input.operationId,
          directory: input.directory,
          command: process.execPath,
          args: [cli, input.content.candidate ? 'propose' : 'add', '--input-file', path],
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
              : 'MWF save timed out; retry uses the same request ID',
          );
        if (proof.exitCode !== 0) {
          let message = 'MWF save failed';
          try {
            const parsed = JSON.parse(stderr.trim());
            message = parsed.error?.message ?? message;
          } catch {
            /* Do not expose raw CLI diagnostics or input. */
          }
          throw new Error(message);
        }
        const result = JSON.parse(output);
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
      } finally {
        clearTimeout(timer);
        rmSync(path, { force: true });
      }
    },
  };
}
