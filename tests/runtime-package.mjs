import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Separate artifact gate: compresses the complete installed dependencies once.
test(
  'relocated Linux bundle serves UI and executes real pi/MWF without a source checkout',
  { timeout: 300000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'parallel-runtime-'));
    let child;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const ended = once(child, 'exit');
        child.kill('SIGTERM');
        await ended;
      }
      rmSync(root, { recursive: true, force: true });
    });
    const output = join(root, 'archive');
    execFileSync('python3', ['scripts/package-runtime.py', output, '--development'], {
      timeout: 120000,
      stdio: 'pipe',
    });
    execFileSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: output });
    execFileSync('tar', ['-xzf', join(output, 'parallel-pi-linux.tar.gz'), '-C', root]);
    const bundle = join(root, 'parallel-pi');
    assert.equal(existsSync(join(bundle, '.git')), false);
    assert.equal(existsSync(join(bundle, 'vendor/pi/.git')), false);
    const check = () =>
      spawnSync(process.execPath, [join(bundle, 'scripts/runtime.mjs'), '--check'], {
        cwd: root,
        encoding: 'utf8',
      });
    assert.equal(check().status, 0);
    const manifestPath = join(bundle, 'runtime-manifest.json');
    const manifest = readFileSync(manifestPath, 'utf8');
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(manifest), arch: 'wrong-arch' }));
    assert.match(check().stderr, /architecture mismatch/);
    writeFileSync(manifestPath, manifest);
    const asset = join(bundle, 'apps/web/dist/index.html');
    const html = readFileSync(asset);
    writeFileSync(asset, 'modified');
    assert.match(check().stderr, /integrity mismatch/);
    writeFileSync(asset, html);
    const agent = join(root, 'agent'),
      data = join(root, 'data'),
      repository = join(root, 'repository');
    mkdirSync(agent);
    mkdirSync(repository);
    writeFileSync(
      join(agent, 'settings.json'),
      JSON.stringify({ extensions: [join(bundle, 'probes/fixture-extension.mjs')] }),
    );
    const git = (...args) => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Runtime Test');
    git('config', 'user.email', 'runtime@example.invalid');
    writeFileSync(join(repository, 'code'), 'initial');
    git('add', '.');
    git('commit', '-m', 'initial');
    child = spawn(process.execPath, [join(bundle, 'scripts/runtime.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        PARALLEL_PI_PORT: '0',
        PARALLEL_PI_DATA_DIR: data,
        PARALLEL_PI_AGENT_DIR: agent,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    for (let i = 0; i < 600 && !stdout.includes('parallel_pi: http'); i++) {
      assert.equal(child.exitCode, null, stderr);
      await delay(25);
    }
    const url = stdout.match(/parallel_pi: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    assert.ok(url, stdout + stderr);
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url + '/api/snapshot')).status, 401);
    assert.equal(
      (await fetch(url + '/api/session', { headers: { origin: 'https://foreign.example' } }))
        .status,
      403,
    );
    const response = await fetch(url + '/api/session');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const headers = { cookie, 'content-type': 'application/json' };
    const command = async (input) => {
      const response = await fetch(url + '/api/command', {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    };
    const snapshot = async () => (await fetch(url + '/api/snapshot', { headers })).json();
    await command({ type: 'project.add', directory: repository });
    const laneId = (await snapshot()).lanes[0].id;
    const initialized = await command({
      type: 'memory.change',
      laneId,
      requestId: 'package-memory',
      change: { kind: 'init', gitMode: 'ignore' },
    });
    assert.equal(initialized.state, 'saved', JSON.stringify(initialized));
    const session = await command({
      type: 'session.create',
      laneId,
      title: 'Packaged session',
      model: { provider: 'parallel-probe', model: 'probe-a' },
    });
    await command({
      type: 'run.enqueue',
      sessionId: session.id,
      requestId: 'packaged-run',
      text: 'hello from relocated package',
      attachmentIds: [],
    });
    let state;
    for (let i = 0; i < 800; i++) {
      state = await snapshot();
      if (['succeeded', 'failed', 'interrupted'].includes(state.runs[0]?.state)) break;
      await delay(25);
    }
    assert.equal(state.runs[0].state, 'succeeded', JSON.stringify(state.runs));
    assert.match(JSON.stringify(state.sessions), /hello from relocated package/);
    const ended = once(child, 'exit');
    child.kill('SIGTERM');
    await ended;
    assert.equal(child.exitCode, 0, stderr);
    // Backups in a release have no .git directory from which to read the version.
    const backup = spawnSync(
      'python3',
      [
        join(bundle, 'scripts/backup.py'),
        'create',
        join(root, 'backup'),
        '--data-dir',
        data,
        '--agent-dir',
        agent,
        '--include',
        bundle,
      ],
      { encoding: 'utf8', timeout: 120000 },
    );
    assert.equal(backup.status, 0, backup.stderr);
    assert.equal(
      JSON.parse(readFileSync(join(root, 'backup/manifest.json'), 'utf8')).applicationCommit,
      JSON.parse(manifest).applicationCommit,
    );
  },
);
