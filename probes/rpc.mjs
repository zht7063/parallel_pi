import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const root = fileURLToPath(new URL('../', import.meta.url));
export class Rpc {
  events = [];
  changes = new EventEmitter();
  sequence = 0;
  stderr = '';
  constructor(cwd, agentDir, extra = [], options = {}) {
    this.child = spawn(process.execPath, [
      `${root}vendor/pi/packages/coding-agent/dist/rpc-entry.js`,
      '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates',
      '-e', `${root}probes/fixture-extension.mjs`,
      ...(options.nativeDefaults ? [] : ['--provider', 'parallel-probe', '--model', 'probe-a']), ...extra,
    ], { cwd, env: { PATH: process.env.PATH, HOME: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    this.child.stdout.setEncoding('utf8').on('data', chunk => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, at).replace(/\r$/, '');
        buffer = buffer.slice(at + 1);
        try { this.events.push(JSON.parse(line)); }
        catch { this.error = new Error(`Non-JSON RPC output: ${line}`); }
        this.changes.emit('change');
      }
    });
    this.child.stderr.setEncoding('utf8').on('data', chunk => { this.stderr += chunk; });
    this.child.on('error', error => { this.error = error; this.changes.emit('change'); });
    this.child.on('exit', () => { this.exited = true; this.changes.emit('change'); });
  }
  send(value) { this.child.stdin.write(JSON.stringify(value) + '\n'); }
  async wait(predicate, after = 0, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (true) {
      const match = this.events.slice(after).find(predicate);
      if (match) return match;
      if (this.error) throw this.error;
      if (this.exited) throw new Error(`RPC exited: ${this.stderr}`);
      if (Date.now() >= deadline) throw new Error(`RPC timeout: ${this.stderr}\n${JSON.stringify(this.events.slice(-4))}`);
      const controller = new AbortController();
      await Promise.race([once(this.changes, 'change', { signal: controller.signal }), delay(Math.min(100, deadline - Date.now()))]);
      controller.abort();
    }
  }
  async command(type, args = {}) {
    const id = `probe-${++this.sequence}`;
    this.send({ type, id, ...args });
    const response = await this.wait(event => event.type === 'response' && event.id === id);
    if (!response.success) throw new Error(`${type}: ${response.error}`);
    return response.data;
  }
  async prompt(message, args = {}) {
    const after = this.events.length;
    await this.command('prompt', { message, ...args });
    await this.wait(event => event.type === 'agent_end', after);
    return this.events.slice(after);
  }
  async close() {
    if (this.exited) return;
    const exited = once(this.child, 'exit');
    process.kill(-this.child.pid, 'SIGTERM');
    await Promise.race([exited, delay(1000)]);
    if (!this.exited) { process.kill(-this.child.pid, 'SIGKILL'); await exited; }
  }
}
