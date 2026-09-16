import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SessionManager } from './.cache/pi-previous/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js';
const packageUrl = new URL('./.cache/pi-previous/node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url);
if (JSON.parse(readFileSync(packageUrl)).version !== '0.84.1') throw Error('Expected pi 0.84.1');
const temp = mkdtempSync(join(tmpdir(), 'parallel-pi-old-session-'));
try {
  const session = SessionManager.create('/fixture/worktree', temp);
  session.appendModelChange('parallel-probe', 'probe-a');
  for (const text of ['old-first', 'old-fork-point']) {
    session.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
    session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `answer:${text}` }], api: 'faux', provider: 'parallel-probe', model: 'probe-a', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
  }
  const bytes = readFileSync(session.getSessionFile());
  writeFileSync(new URL('./fixtures/pi-0.84.1-session.jsonl', import.meta.url), bytes);
  writeFileSync(new URL('./fixtures/pi-0.84.1-session.meta.json', import.meta.url), JSON.stringify({
    package: '@earendil-works/pi-coding-agent', version: '0.84.1',
    integrity: 'sha512-ncAqFrG+iybuPGOhMiZoEHkEzTpJgz3guYD32pD+M7ucc0WeHmauP6wa7qwP8V/KWvsZDVNa5XGsdZ7fkC7w7A==',
    generator: 'Real 0.84.1 SessionManager; synthetic user/assistant messages; no model call',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }, null, 2) + '\n');
} finally { rmSync(temp, { recursive: true, force: true }); }
