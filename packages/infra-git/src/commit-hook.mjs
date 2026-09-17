// Per-invocation launcher. Never installed into the user's hooks directory.
import {
  readFileSync,
  appendFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const [manifestPath, name, ...args] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const input = name === 'reference-transaction' ? readFileSync(0, 'utf8') : undefined;
function receipt(name, value) {
  const target = join(manifest.jobDirectory, name);
  const content = JSON.stringify(value);
  try {
    const fd = openSync(target, 'wx', 0o600);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const parent = openSync(manifest.jobDirectory, 'r');
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } catch (error) {
    if (error.code !== 'EEXIST' || readFileSync(target, 'utf8') !== content) throw error;
  }
}
function nativeHook() {
  const original = manifest.hooks[name];
  if (!original) return;
  const progress = (phase, exitCode) =>
    appendFileSync(
      join(manifest.jobDirectory, 'progress.jsonl'),
      JSON.stringify({ name, phase, ...(exitCode === undefined ? {} : { exitCode }) }) + '\n',
      { mode: 0o600 },
    );
  progress('started');
  const result = spawnSync(original, args, {
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    // Remove only our per-invocation hook-path override from nested Git calls.
    // Existing inherited command-line config remains exactly as it was.
    env: { ...process.env, GIT_CONFIG_PARAMETERS: manifest.gitConfigParameters ?? undefined },
  });
  progress('finished', result.status ?? 1);
  if (result.error || result.signal || result.status !== 0) {
    if (result.error) process.stderr.write(`Unable to execute ${name}: ${result.error.message}\n`);
    process.exit(result.status || 1);
  }
}
const updates =
  input
    ?.trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ')) ?? [];
const relevant = updates.filter(([, , ref]) => ref === manifest.ref || ref === 'HEAD');
if (name === 'reference-transaction' && args[0] === 'committed' && relevant.length) {
  receipt('committed.json', { commit: relevant[0][1] });
}
nativeHook();
if (name === 'reference-transaction' && args[0] === 'prepared' && relevant.length) {
  try {
    const commits = new Set();
    for (const [old, commit] of relevant) {
      if (old !== manifest.head || !/^[a-f0-9]{40,64}$/.test(commit))
        throw new Error('Git branch changed; reload before committing');
      const git = (...args) =>
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      if (
        git('rev-parse', `${commit}^{tree}`) !== manifest.tree ||
        git('rev-list', '--parents', '-n', '1', commit) !== `${commit} ${manifest.head}`
      )
        throw new Error(
          'Commit contents changed after preview, possibly in a hook; reload and inspect before retrying',
        );
      commits.add(commit);
    }
    if (commits.size !== 1) throw new Error('Commit reference transaction is inconsistent');
    receipt('prepared.json', { commit: [...commits][0] });
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exit(1);
  }
}
