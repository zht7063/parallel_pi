import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsManager } from '../vendor/pi/packages/coding-agent/dist/core/settings-manager.js';
import { AuthStorage } from '../vendor/pi/packages/coding-agent/dist/core/auth-storage.js';
import { Rpc } from './rpc.mjs';
import { Coordinator } from './coordinator.mjs';
import { execFileSync } from 'node:child_process';
import { updateSettings, revision } from './configuration.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-pi-v03-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agent = join(dir, 'agent'), a = join(dir, 'a'), b = join(dir, 'b');
  for (const path of [agent, join(a, '.pi')]) mkdirSync(path, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: a, stdio: 'pipe' });
  git('init', '-b', 'main');
  writeFileSync(join(a, 'tracked'), 'fixture'); git('add', 'tracked');
  git('-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-m', 'fixture');
  git('worktree', 'add', '-b', 'other', b);
  mkdirSync(join(b, '.pi')); 
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'parallel-probe', defaultModel: 'probe-a' }));
  writeFileSync(join(a, '.pi/settings.json'), JSON.stringify({ defaultModel: 'probe-b' }));
  return { dir, agent, a, b };
}
test('V03 global/project sources, session override and fixed queued selection', async t => {
  const { agent, a, b } = fixture(t);
  const settingsA = SettingsManager.create(a, agent), settingsB = SettingsManager.create(b, agent);
  assert.equal(settingsA.getGlobalSettings().defaultModel, 'probe-a');
  assert.equal(settingsA.getProjectSettings().defaultModel, 'probe-b');
  assert.equal(settingsA.getDefaultModel(), 'probe-b');
  assert.equal(settingsB.getDefaultModel(), 'probe-a');
  const untrusted = new Rpc(a, agent, [], { nativeDefaults: true });
  try { assert.equal((await untrusted.command('get_state')).model.id, 'probe-a'); }
  finally { await untrusted.close(); }
  const rpc = new Rpc(a, agent, ['--approve'], { nativeDefaults: true });
  try {
    assert.equal((await rpc.command('get_state')).model.id, 'probe-b');
    await rpc.command('set_model', { provider: 'parallel-probe', modelId: 'probe-a' });
    const queued = structuredClone((await rpc.command('get_state')).model);
    writeFileSync(join(a, '.pi/settings.json'), JSON.stringify({ defaultModel: 'probe-b' }));
    await settingsA.reload();
    assert.equal(queued.id, 'probe-a');
    await rpc.command('set_model', { provider: queued.provider, modelId: queued.id });
    const events = await rpc.prompt('fixed-model');
    assert.ok(events.some(e => e.type === 'message_end' && e.message.role === 'assistant' && e.message.model === 'probe-a'));
    await assert.rejects(rpc.command('set_model', { provider: 'parallel-probe', modelId: 'removed-model' }), /not found/i);
    assert.equal((await rpc.command('get_state')).model.id, 'probe-a');
  } finally { await rpc.close(); }
});
test('V03 native writes preserve unrelated edits; same-field stale write needs application revision guard', async t => {
  const { agent, a } = fixture(t);
  const settings = SettingsManager.create(a, agent);
  const path = join(agent, 'settings.json');
  writeFileSync(path, JSON.stringify({ defaultProvider: 'parallel-probe', defaultModel: 'external-new-model', theme: 'external-theme' }));
  settings.setDefaultModel('stale-model');
  await settings.flush();
  assert.deepEqual(settings.drainErrors(), []);
  const stored = JSON.parse(readFileSync(path));
  assert.equal(stored.theme, 'external-theme');
  assert.equal(stored.defaultModel, 'stale-model', 'native setter does not reject a stale UI edit');
  writeFileSync(path, '{broken');
  await settings.reload();
  assert.ok(settings.drainErrors().length > 0);
  settings.setDefaultModel('must-not-overwrite');
  await settings.flush();
  assert.equal(readFileSync(path, 'utf8'), '{broken');
});
test('V03 native credential access, missing auth and conflict check inside locked callback', async t => {
  const { agent } = fixture(t);
  const path = join(agent, 'auth.json');
  const auth = AuthStorage.create(path);
  assert.equal(await auth.read('probe'), undefined);
  await auth.modify('probe', async () => ({ type: 'api_key', key: 'fixture-only-not-a-secret' }));
  const expected = await auth.read('probe');
  await auth.modify('other', async () => ({ type: 'api_key', key: 'another-fixture' }));
  await auth.modify('probe', async () => ({ type: 'api_key', key: 'external-new-fixture' }));
  await assert.rejects(auth.modify('probe', async current => {
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw Error('revision conflict');
    return { type: 'api_key', key: 'stale-fixture' };
  }), /revision conflict/);
  assert.equal((await auth.read('probe')).key, 'external-new-fixture');
  assert.equal((await auth.read('other')).key, 'another-fixture');
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('V03 revision-aware native settings wrapper rejects stale edits under the existing lock', async t => {
  const { a, agent } = fixture(t);
  const path = join(agent, 'settings.json');
  const oldRevision = revision(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ defaultProvider: 'parallel-probe', defaultModel: 'external', theme: 'keep' }));
  assert.throws(() => updateSettings(a, agent, 'global', oldRevision, settings => { settings.defaultModel = 'stale'; }), /revision conflict/);
  assert.equal(JSON.parse(readFileSync(path)).defaultModel, 'external');
  const currentRevision = revision(readFileSync(path, 'utf8'));
  updateSettings(a, agent, 'global', currentRevision, settings => { settings.defaultModel = 'probe-b'; });
  assert.equal(JSON.parse(readFileSync(path)).defaultModel, 'probe-b');
  assert.equal(JSON.parse(readFileSync(path)).theme, 'keep');
});

test('V03 durable queue retains model and fails unavailable model without substitution', { timeout: 20000 }, async t => {
  const { dir, a, agent } = fixture(t);
  const coordinator = new Coordinator(join(dir, 'queue'));
  try {
    coordinator.enqueue('fixed', a, 'fixed queued selection', 'probe-b');
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'parallel-probe', defaultModel: 'probe-a' }));
    writeFileSync(join(a, '.pi/settings.json'), JSON.stringify({ defaultProvider: 'parallel-probe', defaultModel: 'probe-a' }));
    coordinator.pump();
    await Promise.all([...coordinator.active.values()].map(e => e.done));
    assert.equal(coordinator.get('fixed').model, 'probe-b');
    assert.equal(coordinator.get('fixed').state, 'succeeded');
    coordinator.enqueue('removed', a, 'must not use fallback', 'removed-model');
    coordinator.pump();
    await Promise.all([...coordinator.active.values()].map(e => e.done));
    assert.notEqual(coordinator.get('removed').state, 'succeeded');
    assert.notEqual(coordinator.lane('removed').state, 'ready');
  } finally { await coordinator.close(); }
});
test('V03 real RPC rejects a prompt with missing provider credentials', async t => {
  const { a, agent } = fixture(t);
  const rpc = new Rpc(a, agent, [], { provider: 'anthropic', model: 'claude-sonnet-4-5' });
  try {
    await assert.rejects(rpc.command('set_model', { provider: 'anthropic', modelId: 'claude-sonnet-4-5' }), /Model not found/);
    await assert.rejects(rpc.command('prompt', { message: 'must fail before provider call' }), /No API key/);
    assert.equal((await rpc.command('get_state')).model.provider, 'anthropic');
  } finally { await rpc.close(); }
});
