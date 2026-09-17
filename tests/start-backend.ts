// Browser tests use the real application and real pi with an isolated, deterministic provider.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackend } from '../apps/server/src/bootstrap.ts';

const root = mkdtempSync(join(tmpdir(), 'parallel-browser-'));
mkdirSync(join(root, 'agent'));
writeFileSync(
  join(root, 'agent/models.json'),
  JSON.stringify({
    providers: {
      'browser-fixture': {
        baseUrl: 'http://127.0.0.1:9/v1',
        api: 'openai-completions',
        models: [{ id: 'catalog-vision', input: ['text', 'image'] }],
      },
    },
  }),
);
const backend = await createBackend({
  dataDirectory: join(root, 'data'),
  agentDirectory: join(root, 'agent'),
  engineArgs: [
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '-e',
    fileURLToPath(new URL('../probes/fixture-extension.mjs', import.meta.url)),
  ],
});
backend.server.listen(4318, '127.0.0.1');
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await backend.close();
  rmSync(root, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void close();
  });
