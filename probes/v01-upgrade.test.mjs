import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Rpc } from './rpc.mjs';

test('V01 actual pi 0.84.1 session opens, continues and forks with fixed 0.85.1 kernel', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-pi-upgrade-'));
  const cwd = join(dir, 'workspace'), agent = join(dir, 'agent'); mkdirSync(cwd); mkdirSync(agent);
  const bytes = readFileSync(new URL('./fixtures/pi-0.84.1-session.jsonl', import.meta.url));
  const meta = JSON.parse(readFileSync(new URL('./fixtures/pi-0.84.1-session.meta.json', import.meta.url)));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), meta.sha256);
  const entries = bytes.toString().trim().split('\n').map(line => JSON.parse(line));
  entries[0].cwd = cwd; // Relocate only the fixture's worktree; preserve historical entries.
  const path = join(dir, 'old.jsonl'); writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  const rpc = new Rpc(cwd, agent, ['--session', path]);
  try {
    assert.match(JSON.stringify(await rpc.command('get_messages')), /answer:old-first/);
    await rpc.prompt('continued by current kernel');
    const selected = (await rpc.command('get_fork_messages')).messages.find(m => m.text === 'old-fork-point');
    assert.ok(selected);
    assert.equal((await rpc.command('fork', { entryId: selected.entryId })).cancelled, false);
    assert.match(JSON.stringify(await rpc.command('get_messages')), /answer:old-first/);
    assert.doesNotMatch(JSON.stringify(await rpc.command('get_messages')), /continued by current kernel/);
    await rpc.prompt('old session fork continued');
    assert.notEqual((await rpc.command('get_state')).sessionFile, path);
  } finally { await rpc.close(); rmSync(dir, { recursive: true, force: true }); }
});
