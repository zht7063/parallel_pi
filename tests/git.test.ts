import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGit } from '@parallel-pi/infra-git';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'parallel-git-'));
  const repository = join(root, 'repository');
  mkdirSync(repository);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repository, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repository, 'file.txt'), 'committed\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  return { root, repository, git };
}

test('canonical Git identity, dirty preservation and worktree reconciliation use actual repository facts', async (t) => {
  const { root, repository, git } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = createGit();
  writeFileSync(join(repository, 'file.txt'), 'user change\n');
  writeFileSync(join(repository, 'untracked.txt'), 'keep\n');
  symlinkSync(repository, join(root, 'alias'));
  const facts = await adapter.inspect(join(root, 'alias'));
  assert.equal(facts.directory, repository);
  assert.equal(facts.repository, join(repository, '.git'));
  assert.equal(facts.dirty, true);
  await adapter.validate({ repository: facts.repository, ref: facts.ref, directory: repository });
  await adapter.createBranch(repository, 'feature', 'refs/heads/main');
  const target = join(root, 'work tree\n中文\n');
  assert.equal(
    await adapter.reconcileWorktree(facts.repository, 'refs/heads/feature', target),
    null,
  );
  await adapter.prepareWorktree(repository, 'refs/heads/feature', target);
  assert.equal(readFileSync(join(target, 'file.txt'), 'utf8'), 'committed\n');
  assert.equal(existsSync(join(target, 'untracked.txt')), false);
  assert.equal(readFileSync(join(repository, 'file.txt'), 'utf8'), 'user change\n');
  assert.equal(git('symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.equal(
    await adapter.reconcileWorktree(facts.repository, 'refs/heads/feature', target),
    target,
  );
  assert.equal((await adapter.inspect(target)).repository, facts.repository);
  await assert.rejects(
    adapter.reconcileWorktree(facts.repository, 'refs/heads/main', target),
    /ambiguous/,
  );
  await assert.rejects(
    adapter.createBranch(repository, 'feature', 'refs/heads/main'),
    /already exists/,
  );
  await assert.rejects(adapter.createBranch(repository, '--force', 'refs/heads/main'), /Invalid/);
  await assert.rejects(
    adapter.validate({
      repository: facts.repository,
      ref: 'refs/heads/other',
      directory: repository,
    }),
    /binding changed/,
  );
});

test('in-progress Git operations and ambiguous existing directories cannot silently start work', async (t) => {
  const { root, repository, git } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = createGit();
  const facts = await adapter.inspect(repository);
  writeFileSync(join(repository, '.git/MERGE_HEAD'), git('rev-parse', 'HEAD') + '\n');
  await assert.rejects(
    adapter.validate({ repository: facts.repository, ref: facts.ref, directory: repository }),
    /in progress/,
  );
  const target = join(root, 'unknown');
  mkdirSync(target);
  writeFileSync(join(target, 'keep'), 'unknown');
  await assert.rejects(adapter.reconcileWorktree(facts.repository, facts.ref, target), /ambiguous/);
  assert.equal(readFileSync(join(target, 'keep'), 'utf8'), 'unknown');
});

test('Git preview distinguishes index, worktree, untracked and partial files without changing the index', async (t) => {
  const { inspectGitChanges } = await import('@parallel-pi/infra-git');
  const { root, repository, git } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(repository, 'file.txt'), 'staged version\n');
  git('add', '--', 'file.txt');
  writeFileSync(join(repository, 'file.txt'), 'working version\n');
  const literal = ':(glob)*\n中文.txt';
  writeFileSync(join(repository, literal), 'literal path content\n');
  writeFileSync(join(repository, 'binary'), Buffer.from([0, 1, 2, 3]));
  symlinkSync('file.txt', join(repository, 'link'));
  const index = readFileSync(join(repository, '.git/index'));
  const view = await inspectGitChanges(repository);
  assert.equal(view.head, git('rev-parse', 'HEAD'));
  assert.equal(view.ref, 'refs/heads/main');
  const partial = view.files.find((file) => file.path === 'file.txt')!;
  assert.equal(partial.partial, true);
  assert.equal(partial.staged, true);
  assert.equal(partial.unstaged, true);
  assert.match(partial.stagedDiff, /\+staged version/);
  assert.doesNotMatch(partial.stagedDiff, /working version/);
  assert.match(partial.workingDiff, /\+working version/);
  assert.match(
    view.files.find((file) => file.path === literal)!.workingDiff,
    /literal path content/,
  );
  assert.match(view.files.find((file) => file.path === 'binary')!.workingDiff, /Binary files/);
  assert.match(view.files.find((file) => file.path === 'link')!.workingDiff, /120000/);
  assert.deepEqual(readFileSync(join(repository, '.git/index')), index);
  assert.equal((await inspectGitChanges(repository)).revision, view.revision);
  writeFileSync(join(repository, 'binary'), Buffer.from([0, 1, 2, 4]));
  const binaryChanged = await inspectGitChanges(repository);
  assert.notEqual(binaryChanged.revision, view.revision, 'binary bytes participate in revision');
  assert.notEqual(
    binaryChanged.files.find((file) => file.path === 'binary')!.workingDiff,
    view.files.find((file) => file.path === 'binary')!.workingDiff,
  );
  git('add', '--', 'file.txt');
  const staged = await inspectGitChanges(repository);
  assert.notEqual(staged.revision, binaryChanged.revision);
  assert.equal(staged.files.find((file) => file.path === 'file.txt')!.partial, false);
  assert.deepEqual(readFileSync(join(repository, literal), 'utf8'), 'literal path content\n');
});

test('Git preview exposes both rename paths and refuses conflicted or nested repository paths', async (t) => {
  const { inspectGitChanges } = await import('@parallel-pi/infra-git');
  const { root, repository, git } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git('mv', 'file.txt', 'renamed.txt');
  let view = await inspectGitChanges(repository);
  assert.equal(view.files.find((file) => file.path === 'file.txt')!.indexStatus, 'D');
  assert.equal(view.files.find((file) => file.path === 'renamed.txt')!.indexStatus, 'A');
  mkdirSync(join(repository, 'nested'));
  git('-C', 'nested', 'init', '-b', 'main');
  writeFileSync(join(repository, 'nested/file'), 'nested content');
  git('-C', 'nested', 'add', '.');
  git(
    '-C',
    'nested',
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'nested',
  );
  view = await inspectGitChanges(repository);
  assert.match(
    view.files.find((file) => file.path === 'nested/')!.unsupported!,
    /nested repository/,
  );
  git('checkout', '-b', 'conflict');
  writeFileSync(join(repository, 'renamed.txt'), 'left\n');
  git('add', '--', 'renamed.txt');
  git('commit', '-m', 'left');
  git('checkout', 'main');
  writeFileSync(join(repository, 'file.txt'), 'right\n');
  git('add', '--', 'file.txt');
  git('commit', '-m', 'right');
  assert.throws(() => git('merge', 'conflict'));
  view = await inspectGitChanges(repository);
  assert.ok(view.files.some((file) => file.unsupported?.includes('conflicts')));
});

test('a staged deletion recreated on disk remains one partial path in Git preview', async (t) => {
  const { inspectGitChanges } = await import('@parallel-pi/infra-git');
  const { root, repository, git } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git('rm', '--', 'file.txt');
  writeFileSync(join(repository, 'file.txt'), 'recreated contents\n');
  const view = await inspectGitChanges(repository);
  assert.equal(view.files.length, 1);
  const file = view.files[0]!;
  assert.equal(file.path, 'file.txt');
  assert.equal(file.partial, true);
  assert.equal(file.staged, true);
  assert.equal(file.unstaged, true);
  assert.match(file.stagedDiff, /deleted file mode/);
  assert.match(file.workingDiff, /recreated contents/);
  assert.equal(git('diff', '--cached', '--name-status'), 'D\tfile.txt');
});

test('repository metadata inspection reaps detached fsmonitor children before returning', async (t) => {
  const { createSupervisor } = await import('@parallel-pi/infra-platform');
  const { root, repository, git } = fixture();
  const originalDirectory = process.cwd();
  process.chdir(root);
  const pids = join(root, 'fsmonitor-pids');
  t.after(() => {
    process.chdir(originalDirectory);
    if (existsSync(pids))
      for (const line of readFileSync(pids, 'utf8').trim().split('\n')) {
        try {
          process.kill(Number(line), 'SIGKILL');
        } catch {
          /* Already reaped. */
        }
      }
    rmSync(root, { recursive: true, force: true });
  });
  const hook = join(root, 'fsmonitor');
  writeFileSync(
    hook,
    `#!/usr/bin/env python3\nimport os, subprocess\np = subprocess.Popen(['sleep', '60'], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\nwith open(${JSON.stringify(pids)}, 'a') as out: out.write(str(p.pid) + '\\n')\nos.write(1, b'token\\0/\\0')\n`,
    { mode: 0o700 },
  );
  git('config', 'core.fsmonitor', hook);
  const adapter = createGit(createSupervisor(join(root, 'supervision')));
  const facts = await adapter.inspect('repository', 'inspect-fsmonitor');
  assert.ok(existsSync(pids), 'real Git must invoke the configured fsmonitor');
  const check = () => {
    for (const line of readFileSync(pids, 'utf8').trim().split('\n'))
      assert.throws(
        () => process.kill(Number(line), 0),
        { code: 'ESRCH' },
        'metadata reads must not leave hook descendants alive',
      );
  };
  check();
  await adapter.validate(
    { directory: repository, repository: facts.repository, ref: facts.ref },
    'validate-fsmonitor',
  );
  check();
});
