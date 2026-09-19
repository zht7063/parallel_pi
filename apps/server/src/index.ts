import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

process.umask(0o077);
const port = Number(process.env.PARALLEL_PI_PORT ?? 4317);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error('Invalid PARALLEL_PI_PORT');
const dataDirectory = resolve(
  process.env.PARALLEL_PI_DATA_DIR ??
    join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'parallel_pi'),
);
// Configure before loading dependencies so cached paths and child processes agree.
const temporaryDirectory = join(dataDirectory, 'tmp');
mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = temporaryDirectory;
const { createBackend } = await import('./bootstrap.ts');
const backend = await createBackend({
  dataDirectory,
  agentDirectory: process.env.PARALLEL_PI_AGENT_DIR,
});
backend.server.listen(port, '127.0.0.1', () => {
  const address = backend.server.address();
  if (address && typeof address !== 'string')
    console.log(`parallel_pi: http://127.0.0.1:${address.port}`);
});
backend.server.on('error', async (error) => {
  console.error(error.message);
  process.exitCode = 1;
  await backend.close();
});
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void backend.close();
  });
