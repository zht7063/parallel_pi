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
