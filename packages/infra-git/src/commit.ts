import type { GitCommitResult, GitHookEvent, GitCommitPreview } from '@parallel-pi/application';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectGitChanges } from './changes.ts';
import { safeError, pathLine } from './command.ts';

export interface GitCommitRequest {
  directory: string;
  revision: string;
  tree: string;
  paths: string[];
  message: string;
}
interface Manifest {
  jobDirectory: string;
  directory: string;
  head: string;
  ref: string;
  tree: string;
  index: string;
  originalHash: string;
  mode: number;
  lock: { ino: number; dev: number };
  paths: string[];
  hooks: Record<string, string>;
  gitConfigParameters: string | null;
}
const execute = promisify(execFile);
const digest = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function native(directory: string, args: string[], index?: string) {
  return execFileSync('git', ['--literal-pathspecs', '-C', directory, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(index ? { GIT_INDEX_FILE: index } : {}) },
  });
}
function durable(path: string, value: unknown) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(dirname(path), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
function ownedLock(manifest: Manifest) {
  try {
    const stat = lstatSync(manifest.index + '.lock');
    return stat.isFile() && stat.ino === manifest.lock.ino && stat.dev === manifest.lock.dev;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function receipt(path: string): { commit: string } | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function select(view: Awaited<ReturnType<typeof inspectGitChanges>>, paths: string[]) {
  if (!paths.length || new Set(paths).size !== paths.length)
    throw new Error('Select distinct whole files');
  for (const path of paths) {
    const file = view.files.find((item) => item.path === path);
    if (!file || file.partial || file.unsupported)
      throw new Error(
        'Selected files include partial staging or unsupported changes; handle them in an external Git tool',
      );
  }
}
function selectionTree(directory: string, head: string, paths: string, index: string) {
  const internal = ['-c', 'core.hooksPath=/dev/null'];
  native(directory, [...internal, 'read-tree', head], index);
  native(
    directory,
    [...internal, 'add', '--pathspec-from-file=' + paths, '--pathspec-file-nul'],
    index,
  );
  return native(directory, ['write-tree'], index).trim();
}
/** Native clean filters run in a private index; show the exact tree that approval binds. */
export async function previewGitCommit(
  directory: string,
  revision: string,
  paths: string[],
): Promise<GitCommitPreview> {
  const view = await inspectGitChanges(directory);
  if (view.revision !== revision)
    throw new Error('Git changes changed after preview; reload before selecting files');
  select(view, paths);
  const temporary = mkdtempSync(join(tmpdir(), 'parallel-git-preview-'));
  try {
    const pathFile = join(temporary, 'paths');
    writeFileSync(pathFile, paths.join('\0') + '\0', { mode: 0o600 });
    const tree = selectionTree(view.directory, view.head, pathFile, join(temporary, 'index'));
    if (tree === native(view.directory, ['rev-parse', 'HEAD^{tree}']).trim())
      throw new Error('The selected files have no changes to commit');
    const diff = native(view.directory, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--no-color',
      '--full-index',
      view.head,
      tree,
      '--',
    ]);
    if ((await inspectGitChanges(directory)).revision !== revision)
      throw new Error('Git changes changed while preparing; reload before selecting files');
    return { revision, head: view.head, ref: view.ref, tree, paths, diff };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function hookWarning(jobDirectory: string) {
  const path = join(jobDirectory, 'progress.jsonl');
  if (!existsSync(path)) return null;
  const active = new Set<string>(),
    failures: string[] = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.pop();
  for (const line of lines) {
    const event: GitHookEvent = JSON.parse(line);
    if (event.phase === 'started') active.add(event.name);
    else {
      active.delete(event.name);
      if (event.exitCode) failures.push(`${event.name} exited ${event.exitCode}`);
    }
  }
  failures.push(
    ...[...active].map((name) => `${name} was interrupted after the commit was created`),
  );
  return failures.length ? failures.join('; ') : null;
}

/** Explicit user review only, after process cleanup. Keeps current refs/index/worktree unchanged. */
export function reviewGitCommit(jobDirectory: string): GitCommitResult {
  const reviewPath = join(jobDirectory, 'reviewed.json');
  if (existsSync(reviewPath)) return JSON.parse(readFileSync(reviewPath, 'utf8'));
  if (existsSync(join(jobDirectory, 'result.json')))
    return JSON.parse(readFileSync(join(jobDirectory, 'result.json'), 'utf8'));
  const manifestPath = join(jobDirectory, 'manifest.json');
  if (!existsSync(manifestPath)) return recoverGitCommit(jobDirectory);
  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (ownedLock(manifest)) unlinkSync(manifest.index + '.lock');
  if (existsSync(manifest.index + '.lock'))
    throw new Error('An unowned Git index lock remains; inspect it externally before continuing');
  const result: GitCommitResult = {
    state: 'reviewed',
    commit: receipt(join(jobDirectory, 'committed.json'))?.commit ?? null,
    error: '原提交结果未自动确认；已记录外部核对并保留当前 Git 状态，不再自动修复索引。',
  };
  durable(reviewPath, result);
  return result;
}

/** Caller must first prove the previous worker and all descendants have exited. Never replays hooks. */
export function recoverGitCommit(jobDirectory: string): GitCommitResult {
  if (existsSync(join(jobDirectory, 'reviewed.json')))
    return JSON.parse(readFileSync(join(jobDirectory, 'reviewed.json'), 'utf8'));
  if (!existsSync(join(jobDirectory, 'request.json')))
    return {
      state: 'failed',
      commit: null,
      error: 'Git commit was not started; reload before retrying',
    };
  const resultPath = join(jobDirectory, 'result.json');
  if (existsSync(resultPath)) return JSON.parse(readFileSync(resultPath, 'utf8'));
  const manifestPath = join(jobDirectory, 'manifest.json');
  if (!existsSync(manifestPath)) {
    const request: GitCommitRequest = JSON.parse(
      readFileSync(join(jobDirectory, 'request.json'), 'utf8'),
    );
    const lock =
      pathLine(
        native(request.directory, ['rev-parse', '--path-format=absolute', '--git-path', 'index']),
      ) + '.lock';
    if (existsSync(lock)) {
      if (readFileSync(lock, 'utf8') !== 'parallel_pi ' + jobDirectory + '\n')
        return {
          state: 'uncertain',
          commit: null,
          error: 'Commit preparation was interrupted; inspect the Git index lock before continuing',
        };
      unlinkSync(lock);
    }
    // No native commit is launched before its manifest is durable.
    const result: GitCommitResult = {
      state: 'failed',
      commit: null,
      error: 'Commit preparation was interrupted before Git commit started; reload before retrying',
    };
    durable(resultPath, result);
    return result;
  }
  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const prepared = receipt(join(jobDirectory, 'prepared.json'));
  const committed = receipt(join(jobDirectory, 'committed.json'));
  const head = native(manifest.directory, ['rev-parse', '--verify', manifest.ref]).trim();
  const commit = committed?.commit ?? (prepared?.commit === head ? head : null);
  let result: GitCommitResult;
  if (commit) {
    if (
      head !== commit ||
      native(manifest.directory, ['symbolic-ref', '--quiet', 'HEAD']).trim() !== manifest.ref
    ) {
      return {
        state: 'uncertain',
        commit,
        error:
          'The commit exists but the branch moved; inspect Git state before reconciling the index',
      };
    }
    const reconciled = join(jobDirectory, 'reconciled.index');
    copyFileSync(join(jobDirectory, 'original.index'), reconciled);
    native(
      manifest.directory,
      [
        '-c',
        'core.hooksPath=/dev/null',
        'reset',
        '--quiet',
        commit,
        '--pathspec-from-file=' + join(jobDirectory, 'paths'),
        '--pathspec-file-nul',
      ],
      reconciled,
    );
    const finalIndex = readFileSync(reconciled);
    const currentIndex = readFileSync(manifest.index);
    if (digest(currentIndex) !== digest(finalIndex)) {
      if (!ownedLock(manifest) || digest(currentIndex) !== manifest.originalHash)
        return {
          state: 'uncertain',
          commit,
          error: 'Commit exists but the index changed externally; preserve it and reconcile in Git',
        };
      const fd = openSync(manifest.index + '.lock', constants.O_WRONLY | constants.O_NOFOLLOW);
      try {
        const identity = fstatSync(fd);
        if (identity.ino !== manifest.lock.ino || identity.dev !== manifest.lock.dev)
          throw new Error('Git index lock changed');
        ftruncateSync(fd, 0);
        writeFileSync(fd, finalIndex);
        fchmodSync(fd, manifest.mode);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(manifest.index + '.lock', manifest.index);
      const parent = openSync(dirname(manifest.index), 'r');
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    }
    result = { state: 'committed', commit, error: hookWarning(jobDirectory) };
  } else {
    result = {
      state: 'failed',
      commit: null,
      error: existsSync(join(jobDirectory, 'failure.json'))
        ? JSON.parse(readFileSync(join(jobDirectory, 'failure.json'), 'utf8')).error
        : 'No completed commit was found; reload changes before a new attempt',
    };
  }
  if (ownedLock(manifest)) unlinkSync(manifest.index + '.lock');
  durable(resultPath, result);
  return result;
}

/** Private index transaction: native commit owns hooks; reference guard enforces the approved tree. */
export async function commitGitFiles(
  jobDirectory: string,
  request: GitCommitRequest,
  progress: (event: GitHookEvent) => void = () => {},
): Promise<GitCommitResult> {
  if (!request.message.trim() || request.message.includes('\0') || request.message.length > 65536)
    throw new Error('Enter a valid commit message');
  if (!request.paths.length || new Set(request.paths).size !== request.paths.length)
    throw new Error('Select distinct whole files');
  // ponytail: retained index snapshots use O(commits × index size); prune terminal snapshots if space becomes material.
  mkdirSync(jobDirectory, { mode: 0o700 });
  durable(join(jobDirectory, 'request.json'), request);
  let manifest: Manifest | undefined;
  let lockFd: number | undefined;
  let lockPath = '';
  function releasePreparationLock() {
    if (lockFd === undefined) return;
    const identity = fstatSync(lockFd);
    closeSync(lockFd);
    lockFd = undefined;
    try {
      const stat = lstatSync(lockPath);
      if (stat.ino === identity.ino && stat.dev === identity.dev) unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const view = await inspectGitChanges(request.directory);
    if (view.revision !== request.revision)
      throw new Error('Git changes changed after preview; reload before committing');
    select(view, request.paths);
    const index = pathLine(
      native(view.directory, ['rev-parse', '--path-format=absolute', '--git-path', 'index']),
    );
    const stat = lstatSync(index);
    if (!stat.isFile()) throw new Error('A regular Git index is required');
    lockPath = index + '.lock';
    lockFd = openSync(lockPath, 'wx', 0o600);
    const identity = fstatSync(lockFd);
    writeFileSync(lockFd, 'parallel_pi ' + jobDirectory + '\n');
    fsyncSync(lockFd);
    const original = readFileSync(index);
    writeFileSync(join(jobDirectory, 'original.index'), original, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(jobDirectory, 'paths'), request.paths.join('\0') + '\0', {
      flag: 'wx',
      mode: 0o600,
    });
    writeFileSync(join(jobDirectory, 'message'), request.message, { flag: 'wx', mode: 0o600 });
    const internal = ['-c', 'core.hooksPath=/dev/null'];
    const tree = selectionTree(
      view.directory,
      view.head,
      join(jobDirectory, 'paths'),
      join(jobDirectory, 'selected.index'),
    );
    if (tree !== request.tree)
      throw new Error(
        'Prepared commit differs from the approved content; preview again before committing',
      );
    if ((await inspectGitChanges(view.directory)).revision !== request.revision)
      throw new Error('Git changes changed while preparing; reload before committing');
    const originalHooks = pathLine(
      native(view.directory, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']),
    );
    const hooks: Record<string, string> = {};
    if (existsSync(originalHooks) && statSync(originalHooks).isDirectory())
      for (const name of readdirSync(originalHooks)) {
        if (!/^[a-zA-Z0-9-]+$/.test(name)) continue;
        const path = resolve(originalHooks, name);
        try {
          if (statSync(path).isFile()) {
            accessSync(path, constants.X_OK);
            hooks[name] = path;
          }
        } catch {
          /* Git also ignores non-executable hooks. */
        }
      }
    manifest = {
      jobDirectory,
      directory: view.directory,
      head: view.head,
      ref: view.ref,
      tree,
      index,
      originalHash: digest(original),
      mode: stat.mode & 0o777,
      lock: { ino: identity.ino, dev: identity.dev },
      paths: request.paths,
      hooks,
      gitConfigParameters: process.env.GIT_CONFIG_PARAMETERS ?? null,
    };
    durable(join(jobDirectory, 'manifest.json'), manifest);
    const hooksPath = join(jobDirectory, 'hooks');
    mkdirSync(hooksPath, { mode: 0o700 });
    const hookRunner = fileURLToPath(new URL('./commit-hook.mjs', import.meta.url));
    for (const name of new Set([...Object.keys(hooks), 'reference-transaction'])) {
      writeFileSync(
        join(hooksPath, name),
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(hookRunner)} ${quote(join(jobDirectory, 'manifest.json'))} ${quote(name)} "$@"\n`,
        { flag: 'wx', mode: 0o700 },
      );
    }
    const transactionIndex = join(jobDirectory, 'transaction.index');
    copyFileSync(join(jobDirectory, 'original.index'), transactionIndex);
    const untracked = view.files
      .filter((file) => file.untracked && request.paths.includes(file.path))
      .map((file) => file.path);
    if (untracked.length) {
      const pathFile = join(jobDirectory, 'untracked.paths');
      writeFileSync(pathFile, untracked.join('\0') + '\0', { flag: 'wx', mode: 0o600 });
      // Native --only needs new paths in its input index; existing paths are
      // already known from the index/HEAD, including staged deletions.
      native(
        view.directory,
        [
          ...internal,
          'add',
          '--intent-to-add',
          '--pathspec-from-file=' + pathFile,
          '--pathspec-file-nul',
        ],
        transactionIndex,
      );
    }
    let seen = 0;
    const flush = () => {
      const path = join(jobDirectory, 'progress.jsonl');
      if (!existsSync(path)) return;
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.pop();
      for (; seen < lines.length; seen++) progress(JSON.parse(lines[seen]!));
    };
    timer = setInterval(flush, 100);
    try {
      await execute(
        'git',
        [
          '--literal-pathspecs',
          '-C',
          view.directory,
          '-c',
          'core.hooksPath=' + hooksPath,
          'commit',
          '--only',
          '--cleanup=verbatim',
          '--file=' + join(jobDirectory, 'message'),
          '--pathspec-from-file=' + join(jobDirectory, 'paths'),
          '--pathspec-file-nul',
        ],
        {
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, GIT_INDEX_FILE: transactionIndex, GIT_TERMINAL_PROMPT: '0' },
        },
      );
    } finally {
      clearInterval(timer);
      timer = undefined;
      flush();
    }
    return recoverGitCommit(jobDirectory);
  } catch (cause) {
    const failure = cause as Error & { stderr?: string };
    const error = safeError(failure.stderr?.trim() || failure.message || 'Git commit failed');
    if (manifest) {
      durable(join(jobDirectory, 'failure.json'), { error });
      const result = recoverGitCommit(jobDirectory);
      return result.state === 'failed' ? { ...result, error } : result;
    }
    releasePreparationLock();
    const result: GitCommitResult = { state: 'failed', commit: null, error };
    durable(join(jobDirectory, 'result.json'), result);
    return result;
  } finally {
    if (timer) clearInterval(timer);
    if (!manifest) releasePreparationLock();
    else if (lockFd !== undefined) closeSync(lockFd);
  }
}
