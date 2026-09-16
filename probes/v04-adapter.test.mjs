import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setup } from './.cache/mwf-source/packages/mwf/dist/setup.js';
import { root } from './rpc.mjs';

const exec = promisify(execFile);
test('V04 fixed MWF extension + real pi loader + MCP tools + bootstrap/resume', { timeout: 60000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), 'parallel-pi-adapter-'));
  try {
    mkdirSync(join(project, '.pi/npm/node_modules'), { recursive: true });
    symlinkSync(`${root}node_modules/pi-mcp-adapter`, join(project, '.pi/npm/node_modules/pi-mcp-adapter'), 'dir');
    writeFileSync(join(project, '.pi/settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-adapter@2.32.1'] }));
    const result = await setup({ project_root: project, harness: ['pi'], git_mode: 'track', install_pi_adapter: false });
    assert.equal(result.ok, true);
    const { stdout } = await exec(process.execPath, [
      `${root}probes/.cache/mwf-source/packages/mwf/scripts/check-pi.ts`, project,
      `${root}vendor/pi/packages/coding-agent`,
    ], { timeout: 45000, maxBuffer: 1024 * 1024, env: { ...process.env, PI_OFFLINE: '1' } });
    assert.match(stdout, /PASS: real Pi loader/);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('V04 upstream real SIGKILL writer releases lock and recovers durable receipt', { timeout: 30000 }, async () => {
  const { stdout } = await exec(process.execPath, [
    '--test', '--test-reporter=tap', '--test-name-pattern=^killed writer releases lock',
    `${root}probes/.cache/mwf-source/packages/mwf/tests/core.test.ts`,
  ], { timeout: 25000, maxBuffer: 1024 * 1024, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  assert.match(stdout, /# pass 1\b/);
  assert.match(stdout, /# fail 0\b/);
});
