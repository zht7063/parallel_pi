import { fileURLToPath } from 'node:url';
import { inspectGitChanges } from './changes.ts';
import { git, pathLine, safeError } from './command.ts';
import { realpath, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { WorkspaceAccess, RepositoryFacts, ProcessSupervisor } from '@parallel-pi/application';

async function worktrees(directory: string): Promise<RepositoryFacts['worktrees']> {
  const raw = await git(directory, 'worktree', 'list', '--porcelain', '-z');
  const result: RepositoryFacts['worktrees'] = [];
  for (const block of raw.split('\0\0').filter(Boolean)) {
    const fields = block.split('\0');
    const path = fields.find((field) => field.startsWith('worktree '))?.slice(9);
    if (!path) continue;
    const canonical = await realpath(path).catch(() => resolve(path));
    result.push({
      directory: canonical,
      ref: fields.find((field) => field.startsWith('branch '))?.slice(7) ?? null,
      head: fields.find((field) => field.startsWith('HEAD '))?.slice(5) ?? '',
      locked: fields.some((field) => field === 'locked' || field.startsWith('locked ')),
    });
  }
  return result;
}
export function createGit(supervisor?: ProcessSupervisor): WorkspaceAccess {
  async function writeGit(directory: string, args: string[], operationId?: string, worker = false) {
    if (!supervisor) return git(directory, ...args);
    if (!operationId) throw new Error('Git writes require a persisted operation ID');
    const child = supervisor.start({
      id: operationId,
      directory,
      command: worker ? process.execPath : 'git',
      args: worker ? args : ['-C', directory, ...args],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let output = '',
      error = '',
      exceeded = false,
      timedOut = false;
    child.onOutput((chunk) => {
      if (output.length + chunk.length > 16 * 1024 * 1024) {
        exceeded = true;
        void child.stop();
      } else output += chunk;
    });
    child.onErrorOutput((chunk) => {
      error = (error + chunk).slice(-65536);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      void child.stop();
    }, 30000);
    try {
      const proof = await child.completion;
      if (!proof.settled) throw new Error(proof.reason);
      if (exceeded || timedOut)
        throw new Error(exceeded ? 'Git output exceeded its limit' : 'Git operation timed out');
      if (proof.exitCode !== 0) throw new Error(safeError(error || 'Git operation failed'));
      return output;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async inspectChanges(directory, operationId) {
      if (!supervisor) return inspectGitChanges(directory);
      const output = await writeGit(
        directory,
        [fileURLToPath(new URL('./changes-worker.ts', import.meta.url))],
        operationId,
        true,
      );
      return JSON.parse(output);
    },
    async inspect(input) {
      const inputPath = await realpath(input);
      if ((await git(inputPath, 'rev-parse', '--is-bare-repository')).trim() === 'true')
        throw new Error('Bare repositories are not supported; select a checked-out worktree');
      const directory = await realpath(
        pathLine(await git(inputPath, 'rev-parse', '--show-toplevel')),
      );
      const repository = await realpath(
        pathLine(await git(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir')),
      );
      let ref: string, head: string;
      try {
        ref = (await git(directory, 'symbolic-ref', '--quiet', 'HEAD')).trim();
        head = (await git(directory, 'rev-parse', '--verify', 'HEAD^{commit}')).trim();
      } catch (cause) {
        throw new Error(
          'Select a branch with an existing commit; detached HEAD and empty repositories are not supported',
          { cause },
        );
      }
      const [branches, entries, status, remoteRefs, remoteNames] = await Promise.all([
        git(
          directory,
          'for-each-ref',
          '--format=%(refname)%00%(objectname)%00%(upstream)',
          'refs/heads/',
        ),
        worktrees(directory),
        git(directory, 'status', '--porcelain=v1', '-z'),
        git(
          directory,
          'for-each-ref',
          '--format=%(refname)%00%(objectname)%00%(symref)',
          'refs/remotes/',
        ),
        git(directory, 'remote'),
      ]);
      return {
        repository,
        directory,
        ref,
        head,
        dirty: Boolean(status),
        worktrees: entries,
        remoteBranches: remoteRefs
          .trimEnd()
          .split('\n')
          .filter(Boolean)
          .flatMap((line) => {
            const [ref, head, symbolic] = line.split('\0');
            if (!ref || !head || symbolic) return [];
            const remote = remoteNames
              .trimEnd()
              .split('\n')
              .filter(Boolean)
              .sort((a, b) => b.length - a.length)
              .find((name) => ref.startsWith(`refs/remotes/${name}/`));
            return remote
              ? [{ ref, head, remote, name: ref.slice(`refs/remotes/${remote}/`.length) }]
              : [];
          }),
        branches: branches
          .trimEnd()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [branchRef, branchHead, upstream] = line.split('\0');
            if (!branchRef || !branchHead) throw new Error('Invalid Git branch response');
            return { ref: branchRef, head: branchHead, upstream: upstream || null };
          }),
      };
    },
    async validate(binding) {
      const actual = await this.inspect(binding.directory);
      if (
        actual.repository !== binding.repository ||
        actual.directory !== binding.directory ||
        actual.ref !== binding.ref
      )
        throw new Error('Worktree binding changed; inspect the repository before resuming');
      const gitDir = pathLine(await git(binding.directory, 'rev-parse', '--absolute-git-dir'));
      for (const marker of [
        'MERGE_HEAD',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        'rebase-merge',
        'rebase-apply',
        'BISECT_LOG',
      ]) {
        const present = await access(join(gitDir, marker)).then(
          () => true,
          (error) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        );
        if (present)
          throw new Error(
            'A Git merge, rebase, cherry-pick or bisect is in progress; finish it before running',
          );
      }
      if ((await git(binding.directory, 'ls-files', '-u', '-z')).length)
        throw new Error('Resolve Git conflicts before running');
    },
    async checkBranchName(directory, name) {
      if (!name || name.startsWith('-')) throw new Error('Invalid branch name');
      await git(directory, 'check-ref-format', `refs/heads/${name}`);
    },
    async createBranch(directory, name, startRef, operationId, track = false) {
      await this.checkBranchName(directory, name);
      if (
        !(track
          ? startRef.startsWith('refs/remotes/')
          : startRef.startsWith('refs/heads/') || /^[a-f0-9]{40,64}$/.test(startRef))
      )
        throw new Error('Select a valid branch as the starting point');
      const start = (await git(directory, 'rev-parse', '--verify', `${startRef}^{commit}`)).trim();
      await writeGit(
        directory,
        ['branch', track ? '--track' : '--no-track', '--', name, track ? startRef : start],
        operationId,
      );
    },
    async fetchRemotes(directory, operationId, remote) {
      await writeGit(
        directory,
        remote ? ['fetch', '--prune', '--', remote] : ['fetch', '--all', '--prune'],
        operationId,
      );
    },
    async prepareWorktree(directory, ref, target, operationId) {
      if (!ref.startsWith('refs/heads/')) throw new Error('Expected a local branch');
      await writeGit(directory, ['worktree', 'add', '--', target, ref.slice(11)], operationId);
    },
    async reconcileWorktree(repository, ref, target) {
      const entries = await worktrees(repository);
      const canonical = await realpath(target).catch((error) => {
        if (error.code === 'ENOENT') return resolve(target);
        throw error;
      });
      const entry = entries.find((item) => item.directory === canonical);
      const exists = await access(target).then(
        () => true,
        (error) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      );
      if (!entry && !exists) return null;
      if (!entry || !exists || entry.ref !== ref)
        throw new Error(
          'Worktree operation is ambiguous; preserve the directory and inspect it manually',
        );
      await this.validate({ repository, ref, directory: canonical });
      return canonical;
    },
  };
}

export { inspectGitChanges } from './changes.ts';
