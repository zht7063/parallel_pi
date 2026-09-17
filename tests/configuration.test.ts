import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createConfigurationAccess } from '@parallel-pi/infra-pi';
import { createApplication, createConfiguration } from '@parallel-pi/application';
import { createHttpServer } from '@parallel-pi/transport';

test('native configuration preserves unrelated fields, rejects stale writes and never resolves key commands', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'agent');
  const access = createConfigurationAccess(directory),
    app = createConfiguration(access);
  const empty = app.read();
  assert.equal(existsSync(directory), false, 'reading does not create native files');
  app.update({
    kind: 'defaults',
    revision: empty.settingsRevision,
    provider: 'fixture',
    model: 'first',
  });
  const settings = join(directory, 'settings.json'),
    auth = join(directory, 'auth.json');
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), {
    defaultProvider: 'fixture',
    defaultModel: 'first',
  });
  const old = app.read();
  writeFileSync(
    settings,
    JSON.stringify({ defaultProvider: 'external', defaultModel: 'new', extra: { keep: true } }),
  );
  assert.throws(
    () =>
      app.update({
        kind: 'defaults',
        revision: old.settingsRevision,
        provider: 'fixture',
        model: 'stale',
      }),
    /changed; reload/,
  );
  app.update({
    kind: 'defaults',
    revision: app.read().settingsRevision,
    provider: 'fixture',
    model: 'chosen',
  });
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')).extra, { keep: true });
  app.update({ kind: 'defaults', revision: app.read().settingsRevision, clear: true });
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { extra: { keep: true } });
  const marker = join(root, 'must-not-run');
  writeFileSync(
    auth,
    JSON.stringify({
      external: { type: 'api_key', key: `!touch ${marker}` },
      oauth: { type: 'oauth', refresh: 'private-refresh', access: 'private-access', expires: 42 },
    }),
    { mode: 0o600 },
  );
  const metadata = app.read();
  assert.equal(existsSync(marker), false);
  assert.doesNotMatch(JSON.stringify(metadata), /private-|touch|must-not-run/);
  const result = app.update({
    kind: 'credential',
    revision: metadata.credentialsRevision,
    provider: 'fixture',
    key: 'private-new-api-key',
  });
  assert.doesNotMatch(JSON.stringify(result), /private-/);
  const contents = JSON.parse(readFileSync(auth, 'utf8'));
  assert.equal(contents.oauth.refresh, 'private-refresh');
  assert.equal(contents.external.key, `!touch ${marker}`);
  assert.equal(contents.fixture.key, 'private-new-api-key');
  assert.equal(statSync(auth).mode & 0o777, 0o600);
  assert.throws(
    () =>
      app.update({
        kind: 'credential',
        revision: metadata.credentialsRevision,
        provider: 'fixture',
        key: null,
      }),
    /changed; reload/,
  );
  const newRevision = app.read().credentialsRevision;
  assert.throws(
    () =>
      app.update({
        kind: 'credential',
        revision: newRevision,
        provider: 'fixture',
        key: '!echo unsafe',
      }),
    /command expressions/,
  );
  assert.throws(
    () =>
      app.update({
        kind: 'credential',
        revision: newRevision,
        provider: '__proto__',
        key: 'fixture',
      }),
    /Invalid provider/,
  );
  app.update({ kind: 'credential', revision: newRevision, provider: 'fixture', key: null });
  assert.equal(JSON.parse(readFileSync(auth, 'utf8')).fixture, undefined);
  assert.equal(existsSync(marker), false);
  const beforeCorruption = app.read();
  writeFileSync(auth, '{"secret":"private-broken-token",');
  assert.throws(
    () => app.read(),
    (e) => e instanceof Error && !e.message.includes('private-') && e.message.includes('invalid'),
  );
  assert.throws(
    () =>
      app.update({
        kind: 'credential',
        revision: beforeCorruption.credentialsRevision,
        provider: 'fixture',
        key: 'new',
      }),
    /changed; reload/,
  );
  assert.equal(readFileSync(auth, 'utf8'), '{"secret":"private-broken-token",');
  writeFileSync(auth, '{}');
  mkdirSync(settings + '.lock');
  assert.throws(
    () => app.update({ kind: 'defaults', revision: app.read().settingsRevision, clear: true }),
    /locked or unwritable/,
  );
  rmSync(settings + '.lock', { recursive: true });
  const restarted = createConfigurationAccess(directory);
  assert.notEqual(restarted.read().settingsRevision, app.read().settingsRevision);
});

test('configuration HTTP requires the local session and returns metadata only on success and failure', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-config-http-'));
  const app = createConfiguration(createConfigurationAccess(root));
  const server = createHttpServer(createApplication(), '/nonexistent', undefined, app);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(base + '/api/configuration')).status, 401);
  const connect = await fetch(base + '/api/session');
  const cookie = connect.headers.get('set-cookie')!.split(';')[0]!;
  const headers = { cookie, 'content-type': 'application/json' };
  const malformed = await fetch(base + '/api/configuration', {
    method: 'POST',
    headers,
    body: '{private-malformed-key',
  });
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /private-malformed-key/);
  const initial = await (await fetch(base + '/api/configuration', { headers })).json();
  const input = {
    kind: 'credential',
    revision: initial.credentialsRevision,
    provider: 'fixture',
    key: 'http-private-secret',
  };
  assert.equal(
    (
      await fetch(base + '/api/configuration', {
        method: 'POST',
        headers: { ...headers, origin: 'https://external.invalid' },
        body: JSON.stringify(input),
      })
    ).status,
    403,
  );
  const saved = await fetch(base + '/api/configuration', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  assert.equal(saved.status, 200);
  assert.doesNotMatch(await saved.text(), /http-private-secret/);
  const stale = await fetch(base + '/api/configuration', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...input, key: null }),
  });
  assert.equal(stale.status, 400);
  assert.match(await stale.text(), /changed; reload/);
  writeFileSync(join(root, 'auth.json'), '{http-private-broken');
  const broken = await fetch(base + '/api/configuration', { headers });
  assert.equal(broken.status, 400);
  assert.doesNotMatch(await broken.text(), /http-private-broken/);
});

test('worktree defaults and trust preserve native parent inheritance, revisions and explicit denies', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-project-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = join(root, 'agent'),
    directory = join(root, 'repo'),
    other = join(root, 'other');
  mkdirSync(join(directory, '.pi'), { recursive: true });
  mkdirSync(other);
  const access = createConfigurationAccess(agent);
  access.defaults(access.read().settingsRevision, { provider: 'global', model: 'global-model' });
  writeFileSync(
    join(directory, '.pi/settings.json'),
    JSON.stringify({ defaultModel: 'local-model', unknown: { preserve: true } }),
  );
  const initial = access.project(directory);
  assert.equal(initial.trusted, false);
  assert.deepEqual(initial.effective, { provider: 'global', model: 'global-model' });
  access.trust(root, initial.trustRevision, true);
  const parent = access.project(directory);
  assert.equal(parent.trustSource, root);
  assert.equal(parent.trusted, true);
  assert.deepEqual(parent.effective, { provider: 'global', model: 'local-model' });
  assert.throws(() => access.trust(directory, initial.trustRevision, false), /changed; reload/);
  access.trust(directory, parent.trustRevision, false);
  assert.equal(access.project(directory).trusted, false);
  assert.equal(access.project(other).trusted, true);
  access.trust(directory, access.project(directory).trustRevision, null);
  assert.equal(access.project(directory).trustSource, root);
  access.projectDefaults(directory, parent.settingsRevision, {
    provider: 'local',
    model: 'changed',
  });
  assert.deepEqual(JSON.parse(readFileSync(join(directory, '.pi/settings.json'), 'utf8')).unknown, {
    preserve: true,
  });
  assert.equal(access.project(other).effective.model, 'global-model');
  assert.throws(
    () => access.projectDefaults(directory, parent.settingsRevision, null),
    /changed; reload/,
  );
  access.projectDefaults(directory, access.project(directory).settingsRevision, null);
  assert.deepEqual(access.project(directory).effective, {
    provider: 'global',
    model: 'global-model',
  });
  // Check the native trust reader observes our exact directory entries and lock protocol.
  const { ProjectTrustStore } =
    await import('../vendor/pi/packages/coding-agent/dist/core/trust-manager.js');
  const native = new ProjectTrustStore(agent);
  assert.equal(native.get(directory), true);
  native.set(directory, false);
  assert.equal(access.project(directory).trusted, false);
  const revision = access.project(directory).trustRevision;
  mkdirSync(join(agent, 'trust.json.lock'));
  assert.throws(() => access.trust(directory, revision, true), /locked or unwritable/);
  rmSync(join(agent, 'trust.json.lock'), { recursive: true });
  writeFileSync(join(agent, 'trust.json'), '{broken-trust');
  assert.throws(() => access.project(directory), /invalid/);
  assert.equal(readFileSync(join(agent, 'trust.json'), 'utf8'), '{broken-trust');
});

test(
  'actual pi and configuration inspection share native saved trust, revocation and global extension decisions',
  { timeout: 20000 },
  async (t) => {
    const { createEngine } = await import('@parallel-pi/infra-pi');
    const { createSupervisor } = await import('@parallel-pi/infra-platform');
    const root = mkdtempSync(join(tmpdir(), 'parallel-project-trust-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const directory = join(root, 'repo'),
      agent = join(root, 'agent');
    mkdirSync(join(directory, '.pi/extensions'), { recursive: true });
    const marker = join(directory, 'loaded');
    writeFileSync(
      join(directory, '.pi/extensions/proof.js'),
      `import { writeFileSync } from 'node:fs'; export default function() { writeFileSync(${JSON.stringify(marker)}, 'loaded'); }`,
    );
    const access = createConfigurationAccess(agent);
    const engine = createEngine({
      supervisor: createSupervisor(join(root, 'supervision')),
      sessionRoot: join(root, 'sessions'),
      agentDirectory: agent,
    });
    async function open(id: string) {
      const connection = await engine.open(
        { operationId: id, directory, sessionRef: engine.sessionPath(id), create: true },
        () => {},
      );
      try {
        assert.ok(await engine.reconcileSession(connection.sessionRef, directory));
      } finally {
        assert.equal((await connection.close()).settled, true);
      }
    }
    assert.equal(
      (await engine.inspectConfiguration({ operationId: 'inspect-untrusted', directory })).trusted,
      false,
    );
    await open('untrusted');
    assert.equal(existsSync(marker), false);
    access.trust(directory, access.project(directory).trustRevision, true);
    assert.equal(
      (await engine.inspectConfiguration({ operationId: 'inspect-trusted', directory })).trusted,
      true,
    );
    rmSync(marker);
    await open('trusted');
    assert.equal(readFileSync(marker, 'utf8'), 'loaded');
    rmSync(marker);
    access.trust(directory, access.project(directory).trustRevision, false);
    assert.equal(
      (await engine.inspectConfiguration({ operationId: 'inspect-revoked', directory })).trusted,
      false,
    );
    await open('revoked');
    assert.equal(existsSync(marker), false);
    mkdirSync(join(agent, 'extensions'));
    writeFileSync(
      join(agent, 'extensions/trust.js'),
      `export default function(pi) { pi.on('project_trust', async () => ({ trusted: 'yes' })); }`,
    );
    assert.equal(
      (await engine.inspectConfiguration({ operationId: 'inspect-hook', directory })).trusted,
      true,
    );
    assert.equal(
      access.project(directory).decision,
      false,
      'the non-remembered native hook does not replace the saved decision',
    );
    rmSync(marker);
    await open('hook');
    assert.equal(readFileSync(marker, 'utf8'), 'loaded');
  },
);

test(
  'supervised native model catalog reflects credentials and custom models without exposing secrets',
  { timeout: 20000 },
  async (t) => {
    const { createModelCatalog } = await import('@parallel-pi/infra-pi');
    const { createSupervisor } = await import('@parallel-pi/infra-platform');
    const root = mkdtempSync(join(tmpdir(), 'parallel-model-catalog-'));
    const agent = join(root, 'agent');
    mkdirSync(agent);
    const catalog = createModelCatalog(createSupervisor(join(root, 'supervision')), agent);
    t.after(async () => {
      await catalog.close();
      rmSync(root, { recursive: true, force: true });
    });
    writeFileSync(
      join(agent, 'models.json'),
      JSON.stringify({
        providers: {
          'catalog-fixture': {
            baseUrl: 'http://127.0.0.1:9/v1',
            api: 'openai-completions',
            models: [{ id: 'vision-test', name: 'Native custom model', input: ['text', 'image'] }],
          },
        },
      }),
    );
    const before = await catalog.list();
    const item = before.find(
      (item) => item.provider === 'catalog-fixture' && item.model === 'vision-test',
    );
    assert.ok(item);
    assert.equal(item.images, true);
    assert.equal(item.available, false);
    const access = createConfigurationAccess(agent);
    access.credential(
      access.read().credentialsRevision,
      'catalog-fixture',
      'private-catalog-fixture',
    );
    const after = await catalog.list();
    assert.equal(after.find((item) => item.provider === 'catalog-fixture')?.available, true);
    assert.doesNotMatch(JSON.stringify(after), /private-catalog-fixture/);
    writeFileSync(join(agent, 'models.json'), '{private-model-parser-token');
    await assert.rejects(
      catalog.list(),
      (error) =>
        error instanceof Error &&
        error.message.includes('Cannot read native models') &&
        !error.message.includes('private-model-parser-token'),
    );
    await catalog.close();
    await assert.rejects(catalog.list(), /shutting down/);
  },
);
