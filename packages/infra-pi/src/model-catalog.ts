import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getAgentDir } from '../../../vendor/pi/packages/coding-agent/dist/config.js';
import type { ModelCatalog, ProcessSupervisor, SupervisedProcess } from '@parallel-pi/application';

export function createModelCatalog(
  supervisor: ProcessSupervisor,
  agentDirectory = getAgentDir(),
): ModelCatalog {
  agentDirectory = resolve(agentDirectory);
  let closed = false;
  const active = new Set<SupervisedProcess>();
  return {
    async list() {
      if (closed) throw new Error('Application is shutting down');
      mkdirSync(agentDirectory, { recursive: true, mode: 0o700 });
      const child = supervisor.start({
        id: randomUUID(),
        directory: agentDirectory,
        command: process.execPath,
        args: [
          fileURLToPath(new URL('./model-catalog-worker.mjs', import.meta.url)),
          agentDirectory,
        ],
        env: { ...process.env, PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agentDirectory },
      });
      active.add(child);
      let output = '',
        failed = false;
      child.onOutput((chunk) => {
        if (output.length + chunk.length > 8 * 1024 * 1024) {
          failed = true;
          void child.stop();
        } else output += chunk;
      });
      const timer = setTimeout(() => {
        failed = true;
        void child.stop();
      }, 25000);
      try {
        const proof = await child.completion;
        if (!proof.settled || proof.exitCode !== 0 || failed || closed)
          throw new Error(
            'Cannot read native models; check model configuration and credentials, then retry',
          );
        return JSON.parse(output);
      } catch {
        throw new Error(
          'Cannot read native models; check model configuration and credentials, then retry',
        );
      } finally {
        clearTimeout(timer);
        active.delete(child);
      }
    },
    async close() {
      closed = true;
      await Promise.all([...active].map((child) => child.stop()));
    },
  };
}
