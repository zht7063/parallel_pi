import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url));

test('CLI help and version work outside the checkout; invalid arguments fail before startup', () => {
  for (const args of [['--help'], ['--version']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: tmpdir(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim());
    assert.doesNotMatch(result.stdout, /Runtime ready/);
  }
  for (const args of [
    [],
    ['bogus'],
    ['serve', '--port', '-1'],
    ['serve', '--port', '65536'],
    ['serve', '--port', '1e3'],
    ['serve', '--host', '0.0.0.0'],
    ['serve', '--data-dir', ''],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: tmpdir(), encoding: 'utf8' });
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.doesNotMatch(result.stdout, /Runtime ready/);
  }
});

test(
  'CLI serves Web and API from a different cwd and shuts down without deleting data',
  { timeout: 30000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'parallel-cli-'));
    const child = spawn(
      process.execPath,
      [cli, 'serve', '--port', '0', '--data-dir', 'data', '--agent-dir', 'agent'],
      {
        cwd: root,
        env: { ...process.env, PARALLEL_PI_PORT: 'invalid-overridden-by-cli' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      rmSync(root, { recursive: true, force: true });
    });
    const base = await new Promise((resolve, reject) => {
      let stdout = '';
      child.stdout.on('data', (data) => {
        stdout += data;
        const match = stdout.match(/parallel_pi: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) resolve(match[1]);
      });
      child.on('error', reject);
      child.on('exit', () => reject(new Error(`Exited before listening: ${stderr}`)));
    });
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);
    const session = await fetch(`${base}/api/session`);
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const status = await fetch(`${base}/api/status`, { headers: { cookie } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).service, 'parallel_pi');
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
    assert.ok(existsSync(join(root, 'data')));
    const doctor = spawnSync(process.execPath, [cli, 'doctor'], { cwd: root, encoding: 'utf8' });
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /Runtime ready/);
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
    assert.equal(manifest.bin['parallel-pi'], 'scripts/cli.mjs');
  },
);
