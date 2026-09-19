import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const platformModule =
  process.env.PARALLEL_PI_PLATFORM_MODULE ??
  new URL('../packages/infra-platform/src/index.ts', import.meta.url).href;
const { createSupervisor }: typeof import('@parallel-pi/infra-platform') = await import(
  platformModule
);
const helper = fileURLToPath(
  new URL(
    process.platform === 'darwin' ? './darwin-supervisor.py' : './supervisor.py',
    platformModule,
  ),
);
async function waitFor(path: string) {
  for (let i = 0; i < 200; i++) {
    if (existsSync(path)) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${path}`);
}
function temporary() {
  return mkdtempSync(join(tmpdir(), 'parallel-platform-'));
}

test('supervisor captures output and kernel proof for a normally exiting child', async (t) => {
  const root = temporary();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const supervisor = createSupervisor(join(root, 'supervision'));
  const processHandle = supervisor.start({
    id: 'normal',
    directory: root,
    command: process.execPath,
    args: ['-e', "process.stdout.write('hello')"],
  });
  let output = '';
  processHandle.onOutput((data) => {
    output += data;
  });
  const proof = await processHandle.completion;
  assert.equal(proof.settled, true);
  assert.equal(proof.exitCode, 0);
  assert.equal(
    proof.reason,
    process.platform === 'darwin' ? 'kernel-coalition-empty' : 'kernel-echild',
  );
  assert.equal(output, 'hello');
  assert.deepEqual(await supervisor.recover('normal'), proof);
});

test('stop reaps a detached double-fork tool before declaring the workspace reusable', async (t) => {
  const root = temporary();
  const supervisor = createSupervisor(join(root, 'supervision'));
  const tool = `
import os, time
from pathlib import Path
if os.fork() == 0:
    os.setsid()
    if os.fork() == 0:
        Path('detached.pid').write_text(str(os.getpid()))
        time.sleep(1.5)
        Path('unsafe').write_text('late write')
        os._exit(0)
    os._exit(0)
while True: time.sleep(1)
`;
  const handle = supervisor.start({
    id: 'detached',
    directory: root,
    command: 'python3',
    args: ['-c', tool],
  });
  t.after(async () => {
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await waitFor(join(root, 'detached.pid'));
  const pid = Number(readFileSync(join(root, 'detached.pid'), 'utf8'));
  const proof = await handle.stop();
  assert.equal(proof.settled, true, proof.reason);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  await delay(1600);
  assert.equal(existsSync(join(root, 'unsafe')), false);
});

test('backend SIGKILL closes input, supervisor reaps tools, and restart can verify cleanup', async (t) => {
  const root = temporary();
  const backend = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { createSupervisor } from ${JSON.stringify(platformModule)};
    const supervisor = createSupervisor(process.argv[1] + '/supervision');
    supervisor.start({ id: 'backend-crash', directory: process.argv[1], command: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('running', String(process.pid)); setInterval(() => {}, 1000)"] });
    setInterval(() => {}, 1000);
  `,
      root,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(async () => {
    if (backend.exitCode === null && backend.signalCode === null) backend.kill('SIGKILL');
    await createSupervisor(join(root, 'supervision')).recover('backend-crash');
    rmSync(root, { recursive: true, force: true });
  });
  await waitFor(join(root, 'running'));
  const pid = Number(readFileSync(join(root, 'running'), 'utf8'));
  const exited = once(backend, 'exit');
  backend.kill('SIGKILL');
  await exited;
  const proof = await createSupervisor(join(root, 'supervision')).recover('backend-crash');
  assert.equal(proof.settled, true, proof.reason);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('recovery tombstone prevents a launcher delayed across the spawn/record crash window', async (t) => {
  const root = temporary();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const supervisor = createSupervisor(join(root, 'supervision'));
  const operation = join(root, 'supervision', 'delayed');
  mkdirSync(operation);
  assert.equal((await supervisor.recover('delayed')).settled, true);
  const late = spawnSync('python3', [
    helper,
    'run',
    operation,
    root,
    process.execPath,
    '-e',
    "require('node:fs').writeFileSync('unsafe', 'launched')",
  ]);
  assert.equal(late.status, 0, late.stderr.toString());
  assert.equal(existsSync(join(root, 'unsafe')), false);
});

test(
  'missing cleanup proof is not replaced by elapsed time or a reused PID',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const root = temporary();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const supervisor = createSupervisor(join(root, 'supervision'));
    const operation = join(root, 'supervision', 'uncertain');
    mkdirSync(operation);
    writeFileSync(
      join(operation, 'owner.json'),
      JSON.stringify({
        pid: process.pid,
        start: 'wrong-generation',
        boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      }),
    );
    const proof = await supervisor.recover('uncertain');
    assert.equal(proof.settled, false);
    assert.match(proof.reason, /without proving/);
    const attempt = spawnSync('python3', [
      '-c',
      `
import importlib.util, signal
spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(helper)})
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.send_verified(${process.pid}, 'wrong-generation', signal.SIGKILL)
`,
    ]);
    assert.equal(attempt.status, 0, attempt.stderr.toString());
    process.kill(process.pid, 0);
  },
);

test(
  'containment cleanup cannot wake a waiting shell into its next command',
  { timeout: 15000, skip: process.platform !== 'linux' },
  async (t) => {
    const root = temporary();
    const operation = join(root, 'operation');
    mkdirSync(operation);
    // Pause between signals to make a scheduler interruption reproducible. All ownership,
    // traversal, actual signals and kernel cleanup proof still use the production helper.
    const runner = join(root, 'slow-signal.py');
    writeFileSync(
      runner,
      `import importlib.util, pathlib, sys, time
spec = importlib.util.spec_from_file_location('supervisor', sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
send = helper.send_verified
def slow_send(pid, stamp, sig):
    send(pid, stamp, sig)
    time.sleep(.1)
helper.send_verified = slow_send
helper.run(pathlib.Path(sys.argv[2]), sys.argv[3], ['bash', '-c', 'echo $$ > tool.pid; sleep 30; echo unintended > late-write'])
`,
    );
    const child = spawn('python3', [runner, helper, operation, root], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    t.after(async () => {
      child.stdin.end();
      await exited;
      rmSync(root, { recursive: true, force: true });
    });
    await waitFor(join(root, 'tool.pid'));
    child.stdin.end();
    await exited;
    assert.equal(existsSync(join(root, 'late-write')), false);
    assert.equal(JSON.parse(readFileSync(join(operation, 'result.json'), 'utf8')).settled, true);
  },
);

test(
  'Darwin supervisor death without a kernel proof keeps the workspace recovering',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = temporary();
    const supervisor = createSupervisor(join(root, 's'));
    const handle = supervisor.start({
      id: 'crash',
      directory: root,
      command: 'python3',
      args: [
        '-c',
        "import os,time; from pathlib import Path; Path('tool.pid').write_text(str(os.getpid())); time.sleep(30)",
      ],
    });
    const operation = join(root, 's', 'crash');
    let toolIdentity: string | undefined;
    const nativeImport = `import sys, importlib.util, json, signal
sys.path.insert(0, ${JSON.stringify(dirname(helper))})
spec = importlib.util.spec_from_file_location('darwin', ${JSON.stringify(helper)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
`;
    t.after(async () => {
      // Test cleanup only: launchd teardown is not accepted as production proof.
      const intent = JSON.parse(readFileSync(join(operation, 'launch.json'), 'utf8'));
      spawnSync('/bin/launchctl', ['bootout', `${intent.domain}/${intent.label}`]);
      if (toolIdentity) {
        const cleaned = spawnSync(
          'python3',
          [
            '-c',
            nativeImport +
              `
try: m.send(m.bindings(), json.loads(sys.argv[1]), signal.SIGKILL)
except ProcessLookupError: pass
`,
            toolIdentity,
          ],
          { encoding: 'utf8' },
        );
        assert.equal(cleaned.status, 0, cleaned.stderr);
      }
      await handle.stop();
      rmSync(root, { recursive: true, force: true });
    });
    await waitFor(join(root, 'tool.pid'));
    const captured = spawnSync(
      'python3',
      [
        '-c',
        nativeImport + 'print(json.dumps(m.identity(m.bindings(), int(sys.argv[1]))))',
        readFileSync(join(root, 'tool.pid'), 'utf8'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(captured.status, 0, captured.stderr);
    toolIdentity = captured.stdout.trim();
    const owner = JSON.parse(readFileSync(join(operation, 'owner.json'), 'utf8'));
    process.kill(owner.pid, 'SIGKILL');
    const proof = await supervisor.recover('crash');
    assert.equal(proof.settled, false);
    assert.match(proof.reason, /without proving/);
    assert.equal((await handle.completion).settled, false);
  },
);

test(
  'Darwin cancellation freezes a waiting shell before killing its child',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = temporary();
    const supervisor = createSupervisor(join(root, 's'));
    const handle = supervisor.start({
      id: 'shell',
      directory: root,
      command: '/bin/sh',
      args: ['-c', 'echo ready > running; sleep 30; echo unintended > late-write'],
    });
    t.after(async () => {
      await handle.stop();
      rmSync(root, { recursive: true, force: true });
    });
    await waitFor(join(root, 'running'));
    assert.equal((await handle.stop()).settled, true);
    assert.equal(existsSync(join(root, 'late-write')), false);
  },
);

test('portable Darwin recovery and cleanup decision checks', () => {
  const check = spawnSync(
    'python3',
    [fileURLToPath(new URL('./darwin-supervisor.test.py', import.meta.url))],
    { encoding: 'utf8' },
  );
  assert.equal(check.status, 0, check.stdout + check.stderr);
});
