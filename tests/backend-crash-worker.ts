import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackend } from '../apps/server/src/bootstrap.ts';
const root = process.argv[2]!;
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
backend.server.listen(0, '127.0.0.1', () => {
  const address = backend.server.address();
  if (address && typeof address !== 'string')
    writeFileSync(join(root, 'url'), `http://127.0.0.1:${address.port}`);
});
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void backend.close();
  });
