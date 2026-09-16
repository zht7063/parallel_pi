import { Coordinator } from './coordinator.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [data, cwd, target] = process.argv.slice(2);
const coordinator = new Coordinator(data, 2, (stage, _run, entry) => {
  if (stage !== target) return;
  writeFileSync(join(data, 'test-actors.json'), JSON.stringify({ stage, pid: entry.rpc?.child.pid }));
  process.kill(process.pid, 'SIGKILL');
});
coordinator.enqueue('uncertain', cwd, 'probe-tool');
coordinator.enqueue('untouched', cwd, 'must remain queued');
coordinator.pump();
