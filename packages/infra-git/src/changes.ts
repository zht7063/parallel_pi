import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitChangesView, GitFileChange } from '@parallel-pi/application';
import { git, pathLine, safeError } from './command.ts';

const execute = promisify(execFile);
const diffArgs = ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--full-index'];
async function untrackedDiff(directory: string, path: string) {
  try {
    const result = await execute(
      'git',
      [
        '--literal-pathspecs',
        '-C',
        directory,
        'diff',
        ...diffArgs,
        '--no-index',
        '--',
        '/dev/null',
        path,
      ],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
    );
    return result.stdout;
  } catch (cause) {
    const error = cause as Error & { code?: number; stdout?: string; stderr?: string };
    if (error.code === 1 && typeof error.stdout === 'string') return error.stdout;
    throw new Error(safeError(error.stderr?.trim() || 'Unable to preview untracked file'));
  }
}
async function capture(directory: string) {
  // Disable rename pairing: the UI selects whole paths, including both sides of
  // a rename, without silently widening a selected path to another file.
  const [head, ref, status, index] = await Promise.all([
    git(directory, 'rev-parse', '--verify', 'HEAD^{commit}'),
    git(directory, 'symbolic-ref', '--quiet', 'HEAD'),
    git(directory, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'),
    git(directory, 'ls-files', '--stage', '-z'),
  ]);
  const submodules = new Set(
    index
      .split('\0')
      .filter((entry) => entry.startsWith('160000 '))
      .map((entry) => entry.slice(entry.indexOf('\t') + 1)),
  );
  const entries: GitFileChange[] = status
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const indexStatus = entry[0]!,
        worktreeStatus = entry[1]!,
        path = entry.slice(3);
      const untracked = indexStatus === '?';
      const staged = !untracked && indexStatus !== ' ';
      const unstaged = untracked || worktreeStatus !== ' ';
      const conflict =
        [indexStatus, worktreeStatus].includes('U') || ['AA', 'DD'].includes(entry.slice(0, 2));
      return {
        path,
        indexStatus,
        worktreeStatus,
        staged,
        unstaged,
        untracked,
        partial: staged && unstaged,
        unsupported: conflict
          ? 'Resolve Git conflicts in an external Git tool'
          : submodules.has(path) || path.endsWith('/')
            ? 'Manage submodule or nested repository changes in an external Git tool'
            : null,
        stagedDiff: '',
        workingDiff: '',
      };
    });
  const byPath = new Map<string, GitFileChange>();
  for (const entry of entries) {
    const previous = byPath.get(entry.path);
    if (!previous) byPath.set(entry.path, entry);
    else {
      // A staged deletion followed by a recreated untracked file is one whole
      // path with different index/worktree contents, not two selectable files.
      const staged = previous.staged ? previous : entry;
      const untracked = previous.untracked ? previous : entry;
      byPath.set(entry.path, {
        ...staged,
        untracked: untracked.untracked,
        unstaged: true,
        worktreeStatus: untracked.worktreeStatus,
        partial: true,
      });
    }
  }
  const files = [...byPath.values()];
  const hash = createHash('sha256').update(JSON.stringify([directory, head, ref, status, index]));
  for (const file of files) {
    hash.update(JSON.stringify(file.path));
    const path = join(directory, file.path);
    const stat = await lstat(path).catch((cause) => {
      if (cause.code === 'ENOENT') return null;
      throw cause;
    });
    if (!stat) {
      hash.update('missing');
      continue;
    }
    hash.update(JSON.stringify([stat.mode, stat.size]));
    if (stat.isSymbolicLink()) hash.update(await readlink(path));
    else if (stat.isFile()) for await (const chunk of createReadStream(path)) hash.update(chunk);
    else if (!file.unsupported)
      file.unsupported = 'Only regular files and symbolic links can be committed here';
  }
  return { head: head.trim(), ref: ref.trim(), revision: hash.digest('hex'), files };
}

/** A revision covers HEAD, the complete index, and bytes/modes of changed paths. */
export async function inspectGitChanges(input: string): Promise<GitChangesView> {
  const directory = await realpath(pathLine(await git(input, 'rev-parse', '--show-toplevel')));
  const before = await capture(directory);
  // ponytail: read all changed paths within the worker deadline; paginate diffs if large workspaces exceed it.
  for (const file of before.files) {
    if (file.unsupported) continue;
    if (file.staged)
      file.stagedDiff = await git(
        directory,
        '--literal-pathspecs',
        'diff',
        ...diffArgs,
        '--cached',
        '--',
        file.path,
      );
    if (file.untracked) file.workingDiff = await untrackedDiff(directory, file.path);
    else if (file.unstaged)
      file.workingDiff = await git(
        directory,
        '--literal-pathspecs',
        'diff',
        ...diffArgs,
        '--',
        file.path,
      );
  }
  const after = await capture(directory);
  if (before.revision !== after.revision)
    throw new Error('Git changes moved while previewing; reload before selecting files');
  // Conversion filters/configuration can change the displayed patch without
  // changing raw worktree bytes. Bind the revision to what the user saw too.
  const revision = createHash('sha256')
    .update(before.revision)
    .update(JSON.stringify(before.files))
    .digest('hex');
  return { directory, ...before, revision };
}
