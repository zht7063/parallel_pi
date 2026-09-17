import { createMemoryAccess } from '@parallel-pi/infra-mwf';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createHarness } from '@parallel-pi/application';
import { createHttpServer } from '@parallel-pi/transport';
import { openStore, createAttachmentStore, createHandoffStore } from '@parallel-pi/infra-storage';
import { createGit } from '@parallel-pi/infra-git';
import { createSupervisor } from '@parallel-pi/infra-platform';
import { createEngine } from '@parallel-pi/infra-pi';

export async function createBackend(options: {
  dataDirectory: string;
  agentDirectory?: string;
  engineArgs?: string[];
}) {
  const store = openStore(options.dataDirectory);
  try {
    const supervisor = createSupervisor(join(options.dataDirectory, 'supervision'));
    const engine = createEngine({
      supervisor,
      sessionRoot: join(options.dataDirectory, 'sessions'),
      agentDirectory: options.agentDirectory,
      extraArgs: options.engineArgs,
    });
    const worktrees = join(options.dataDirectory, 'worktrees');
    mkdirSync(worktrees, { recursive: true, mode: 0o700 });
    const app = createHarness({
      store,
      supervisor,
      engine,
      git: createGit(supervisor),
      memory: createMemoryAccess(supervisor, join(options.dataDirectory, 'memory-inputs')),
      handoffs: createHandoffStore(join(options.dataDirectory, 'handoffs')),
      attachments: createAttachmentStore(join(options.dataDirectory, 'attachments')),
      runtime: { id: randomUUID, now: Date.now, worktreePath: (id) => join(worktrees, id) },
    });
    await app.initialize();
    const server = createHttpServer(
      app,
      fileURLToPath(new URL('../../web/dist', import.meta.url)),
      app,
    );
    return {
      app,
      server,
      async close() {
        server.closeAllConnections();
        server.close();
        await app.close();
        store.close();
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
