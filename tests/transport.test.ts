import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { createApplication } from '@parallel-pi/application';
import { createHttpServer } from '@parallel-pi/transport';

test('local API rejects missing sessions, foreign Host/Origin and serves status with session', async (t) => {
  const server = createHttpServer(createApplication(), '/nonexistent');
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(base + '/api/status')).status, 401);
  assert.equal(
    (await fetch(base + '/api/session', { headers: { Origin: 'https://foreign.example' } })).status,
    403,
  );
  assert.equal(
    await new Promise<number | undefined>((resolve, reject) => {
      get(base + '/api/session', { headers: { Host: 'foreign.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    }),
    403,
  );
  const response = await fetch(base + '/api/session');
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  assert.match(response.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/);
  const status = await fetch(base + '/api/status', { headers: { cookie } });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    service: 'parallel_pi',
    protocolVersion: 1,
    concurrency: 2,
  });
  assert.equal(
    (await fetch(base + '/api/status', { headers: { cookie: 'parallel_pi=invalid' } })).status,
    401,
  );
});
