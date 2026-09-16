import { Coordinator } from './coordinator.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [data, cwd] = process.argv.slice(2);
const coordinator = new Coordinator(data);
coordinator.enqueue('crash-active', cwd, 'probe-slow-tool');
coordinator.enqueue('crash-queued', cwd, 'must not replay');
coordinator.pump();
const deadline = Date.now() + 15000;
while (true) {
  try {
    const toolPid = Number(readFileSync(join(cwd, 'tool.pid'), 'utf8'));
    const run = coordinator.get('crash-active');
    if (toolPid && run.state === 'running') {
      process.send({ type: 'running', pid: run.pid, toolPid });
      break;
    }
  } catch {}
  if (Date.now() > deadline) throw Error('Tool did not start');
  await delay(20);
}
