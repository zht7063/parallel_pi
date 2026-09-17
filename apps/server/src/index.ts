import { fileURLToPath } from 'node:url';
import { createApplication } from '@parallel-pi/application';
import { createHttpServer } from '@parallel-pi/transport';

const port = Number(process.env.PARALLEL_PI_PORT ?? 4317);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error('Invalid PARALLEL_PI_PORT');
const application = createApplication();
const server = createHttpServer(
  application,
  fileURLToPath(new URL('../../web/dist', import.meta.url)),
);
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string')
    console.log(`parallel_pi: http://127.0.0.1:${address.port}`);
});
server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
