import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Separate gate: build, pack, offline-install, exercise and uninstall the npm artifact.
test(
  'npm artifact installs offline and executes real pi/MWF outside the checkout',
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
    const output = process.env.PARALLEL_PI_NPM_CANDIDATE ?? join(root, 'candidate');
    if (!process.env.PARALLEL_PI_NPM_CANDIDATE)
      execFileSync(process.execPath, ['scripts/build-npm.mjs', output], {
        timeout: 180000,
        stdio: 'pipe',
      });
    const [pack] = JSON.parse(
      execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], {
        cwd: output,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
    const names = pack.files.map((file) => file.path);
    assert.ok(names.includes('apps/server/src/index.js'));
    assert.ok(names.includes('packages/infra-git/src/commit-worker.js'));
    assert.ok(names.includes('packages/infra-platform/src/supervisor.py'));
    assert.ok(names.includes('node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js'));
    assert.equal(
      names.some((name) => /(^|\/)(\.git|\.env|__pycache__)(\/|$)/.test(name)),
      false,
    );
    assert.equal(
      names.some((name) => /^(apps|packages)\/.*\.ts$/.test(name)),
      false,
    );
    const prefix = join(root, 'installation');
    const archive = join(root, pack.filename);
    const install = () =>
      execFileSync(
        'npm',
        [
          'install',
          '--global',
          '--prefix',
          prefix,
          '--offline',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          archive,
        ],
        { cwd: root, stdio: 'pipe', timeout: 120000 },
      );
    install();
    const bundle = join(prefix, 'lib/node_modules/parallel-pi');
    const cli = join(prefix, 'bin/parallel-pi');
    assert.equal(existsSync(join(bundle, '.git')), false);
    assert.equal(existsSync(join(bundle, 'node_modules/typescript')), false);
    const check = () => spawnSync(cli, ['doctor'], { cwd: root, encoding: 'utf8' });
    assert.equal(check().status, 0, check().stderr);
    const manifestPath = join(bundle, 'build-info.json');
    const manifest = readFileSync(manifestPath, 'utf8');
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(manifest), arch: 'wrong-arch' }));
    assert.match(check().stderr, /architecture mismatch/);
    writeFileSync(manifestPath, manifest);
    const fixture = join(root, 'fixture-extension.mjs');
    writeFileSync(
      fixture,
      readFileSync('probes/fixture-extension.mjs', 'utf8').replace(
        '../vendor/pi/packages/ai/dist/index.js',
        join(bundle, 'node_modules/@earendil-works/pi-ai/dist/index.js'),
      ),
    );
    const agent = join(root, 'agent'),
      data = join(root, 'data'),
      repository = join(root, 'repository');
    mkdirSync(agent);
    mkdirSync(repository);
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ extensions: [fixture] }));
    const git = (...args) => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Runtime Test');
    git('config', 'user.email', 'runtime@example.invalid');
    writeFileSync(join(repository, 'code'), 'initial');
    git('add', '.');
    git('commit', '-m', 'initial');
    child = spawn(cli, ['serve'], {
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
        fixture,
      ],
      { encoding: 'utf8', timeout: 120000 },
    );
    assert.equal(backup.status, 0, backup.stderr);
    assert.equal(
      JSON.parse(readFileSync(join(root, 'backup/manifest.json'), 'utf8')).applicationCommit,
      JSON.parse(manifest).applicationCommit,
    );
    install(); // Reinstall/upgrade must not remove application state.
    assert.ok(existsSync(data));
    assert.equal(check().status, 0, check().stderr);
    execFileSync(
      'npm',
      ['uninstall', '--global', '--prefix', prefix, '--ignore-scripts', 'parallel-pi'],
      { cwd: root, stdio: 'pipe' },
    );
    assert.equal(existsSync(cli), false);
    assert.ok(existsSync(data));
    assert.ok(existsSync(join(agent, 'settings.json')));
    assert.equal(readFileSync(join(repository, 'code'), 'utf8'), 'initial');
  },
);
