import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcessSupervisor, ProcessSpec, ReapEvidence } from '@parallel-pi/application';

const execute = promisify(execFile);
const helper = fileURLToPath(
  new URL(
    process.platform === 'darwin' ? './darwin-supervisor.py' : './supervisor.py',
    import.meta.url,
  ),
);

export function createSupervisor(root: string): ProcessSupervisor {
  if (!['linux', 'darwin'].includes(process.platform))
    throw new Error('Process supervision requires Linux or macOS with a desktop login session');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  function directory(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid supervision ID');
    return join(root, id);
  }
  async function recover(id: string): Promise<ReapEvidence> {
    const path = directory(id);
    // A reservation is created synchronously before spawn. No directory means no start occurred.
    if (!existsSync(path)) return { settled: true, exitCode: null, reason: 'never-reserved' };
    try {
      const { stdout } = await execute('python3', [helper, 'recover', path], {
        timeout: 10000,
        maxBuffer: 65536,
      });
      const proof = JSON.parse(stdout) as ReapEvidence;
      if (typeof proof.settled !== 'boolean' || typeof proof.reason !== 'string')
        throw new Error('Invalid supervisor result');
      return proof;
    } catch {
      return {
        settled: false,
        exitCode: null,
        reason: 'Unable to verify process cleanup; workspace remains recovering',
      };
    }
  }
  return {
    recover,
    start(spec: ProcessSpec) {
      const path = directory(spec.id);
      // Exclusive mkdir prevents process-generation reuse and retains crash evidence.
      mkdirSync(path, { mode: 0o700 });
      const child = spawn(
        'python3',
        [helper, 'run', path, spec.directory, spec.command, ...spec.args],
        {
          cwd: spec.directory,
          env: spec.env ?? process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdin.on('error', () => {
        /* Completion/recovery is the authority for a closed pipe. */
      });
      const completion = new Promise<ReapEvidence>((resolve) => {
        let resolved = false;
        const finish = async () => {
          if (resolved) return;
          resolved = true;
          resolve(await recover(spec.id));
        };
        child.once('error', finish);
        child.once('close', finish);
      });
      return {
        write(data) {
          if (child.stdin.destroyed || !child.stdin.writable)
            throw new Error('Supervised input is closed');
          child.stdin.write(data);
        },
        onOutput(listener) {
          child.stdout.on('data', listener);
          return () => {
            child.stdout.off('data', listener);
          };
        },
        onErrorOutput(listener) {
          child.stderr.on('data', listener);
          return () => {
            child.stderr.off('data', listener);
          };
        },
        completion,
        async stop() {
          writeFileSync(join(path, 'cancel'), '', { mode: 0o600 });
          child.stdin.end();
          return recover(spec.id);
        },
      };
    },
  };
}
