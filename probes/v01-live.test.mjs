import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rpc } from './rpc.mjs';

const provider = process.env.PARALLEL_PI_PROVIDER, model = process.env.PARALLEL_PI_MODEL;
if (!provider || !model) throw Error('Set PARALLEL_PI_PROVIDER and PARALLEL_PI_MODEL, plus the native provider credential environment variable. Never put secrets in Git.');
const text = events => events.filter(e => e.type === 'message_end' && e.message.role === 'assistant').flatMap(e => e.message.content).filter(c => c.type === 'text').map(c => c.text).join('');

test('V01 live provider: text, real tool, image understanding, persisted continuation', { timeout: 180000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-pi-live-'));
  const cwd = join(dir, 'workspace'), agent = join(dir, 'agent'); mkdirSync(cwd); mkdirSync(agent);
  let rpc = new Rpc(cwd, agent, [], { live: true, provider, model });
  try {
    const available = await rpc.command('get_available_models');
    assert.ok(available.models.some(m => m.provider === provider && m.id === model), 'explicit configured model must be available');
    await rpc.command('set_auto_retry', { enabled: false });
    const first = await rpc.prompt('Remember the marker PARALLEL_PI_PROBE_731. Reply with just that marker.');
    assert.match(text(first), /PARALLEL_PI_PROBE_731/);
    const tools = await rpc.prompt('Use the bash tool with command "printf parallel-pi-live-tool". Then briefly report its output.');
    assert.ok(tools.some(e => e.type === 'tool_execution_end' && e.toolName === 'bash' && !e.isError));
    const images = [{ type: 'image', mimeType: 'image/png', data: readFileSync(new URL('./fixtures/red-square.png', import.meta.url)).toString('base64') }];
    const visual = await rpc.prompt('What is the dominant color of this image? Reply with one English word.', { images });
    assert.match(text(visual), /\bred\b/i);
    const session = (await rpc.command('get_state')).sessionFile;
    await rpc.close();
    rpc = new Rpc(cwd, agent, ['--session', session], { live: true, provider, model });
    const resumed = await rpc.prompt('What exact marker did I ask you to remember earlier? Reply only with that marker.');
    assert.match(text(resumed), /PARALLEL_PI_PROBE_731/);
  } finally { await rpc.close(); rmSync(dir, { recursive: true, force: true }); }
});
