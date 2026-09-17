import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectGitChanges,
  commitGitFiles,
  recoverGitCommit,
  previewGitCommit,
} from '@parallel-pi/infra-git';
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'parallel-commit-'));
  const directory = join(root, 'repository');
  mkdirSync(directory);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', directory, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(directory, 'selected'), 'base\n');
  writeFileSync(join(directory, 'other'), 'base\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  return { root, directory, git };
}
test('native whole-file commit preserves unselected staging and runs original hooks with their paths', async (t) => {
  const { root, directory, git } = setup();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(directory, 'selected'), 'selected change\n');
  writeFileSync(join(directory, 'other'), 'staged other\n');
  git('add', '--', 'other');
  writeFileSync(join(directory, 'other'), 'unstaged other\n');
  const literal = ':(glob)*\n中文';
  writeFileSync(join(directory, literal), 'new literal\n');
  const hooks = join(directory, 'custom hooks');
  mkdirSync(hooks);
  git('config', 'core.hooksPath', 'custom hooks');
  writeFileSync(join(hooks, 'sibling'), 'native sibling');
  writeFileSync(
    join(hooks, 'pre-commit'),
    '#!/bin/sh\ntest "$(git config --get core.hooksPath)" = "custom hooks" || exit 8\ncat "$(dirname "$0")/sibling" >/dev/null || exit 9\nprintf "pre\\n" >> hook-ran\n',
    { mode: 0o700 },
  );
  writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\nprintf "\\nHook footer\\n" >> "$1"\n', {
    mode: 0o700,
  });
  const originalHook = readFileSync(join(hooks, 'pre-commit'));
  const view = await inspectGitChanges(directory);
  const job = join(root, "job 'quoted'");
  const events: unknown[] = [];
  const result = await commitGitFiles(
    job,
    {
      directory,
      revision: view.revision,
      tree: (await previewGitCommit(directory, view.revision, ['selected', literal])).tree,
      paths: ['selected', literal],
      message: 'selected files',
    },
    (event) => events.push(event),
  );
  assert.equal(result.state, 'committed', result.error ?? '');
  assert.equal(result.commit, git('rev-parse', 'HEAD'));
  assert.deepEqual(
    git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD')
      .split('\0')
      .filter(Boolean)
      .sort(),
    [literal, 'selected'].sort(),
  );
  assert.equal(git('show', ':other'), 'staged other');
  assert.equal(readFileSync(join(directory, 'other'), 'utf8'), 'unstaged other\n');
  assert.match(git('log', '-1', '--format=%B'), /Hook footer/);
  assert.deepEqual(events, [
    { name: 'pre-commit', phase: 'started' },
    { name: 'pre-commit', phase: 'finished', exitCode: 0 },
    { name: 'commit-msg', phase: 'started' },
    { name: 'commit-msg', phase: 'finished', exitCode: 0 },
  ]);
  assert.deepEqual(readFileSync(join(hooks, 'pre-commit')), originalHook);
  assert.equal(git('config', 'core.hooksPath'), 'custom hooks');
  assert.equal(existsSync(join(directory, '.git/index.lock')), false);
  assert.deepEqual(recoverGitCommit(job), result);
  assert.equal(readFileSync(join(directory, 'hook-ran'), 'utf8'), 'pre\n');
});

test('stale previews, selected partial staging and failing hooks leave HEAD and index intact', async (t) => {
  const { root, directory, git } = setup();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(directory, 'selected'), 'first\n');
  const stale = await inspectGitChanges(directory);
  writeFileSync(join(directory, 'selected'), 'second\n');
  const head = git('rev-parse', 'HEAD'),
    originalIndex = readFileSync(join(directory, '.git/index'));
  let result = await commitGitFiles(join(root, 'stale'), {
    directory,
    revision: stale.revision,
    tree: git('rev-parse', 'HEAD^{tree}'),
    paths: ['selected'],
    message: 'stale',
  });
  assert.equal(result.state, 'failed');
  assert.match(result.error!, /changed after preview/);
  git('add', '--', 'selected');
  writeFileSync(join(directory, 'selected'), 'partial\n');
  let view = await inspectGitChanges(directory);
  result = await commitGitFiles(join(root, 'partial'), {
    directory,
    revision: view.revision,
    tree: git('rev-parse', 'HEAD^{tree}'),
    paths: ['selected'],
    message: 'partial',
  });
  assert.equal(result.state, 'failed');
  assert.match(result.error!, /partial staging/);
  git('reset', '--quiet', 'HEAD', '--', 'selected');
  const beforeHook = readFileSync(join(directory, '.git/index'));
  writeFileSync(
    join(directory, '.git/hooks/pre-commit'),
    '#!/bin/sh\nprintf "validator refused\\n" >&2\nexit 3\n',
    { mode: 0o700 },
  );
  view = await inspectGitChanges(directory);
  result = await commitGitFiles(join(root, 'hook-failed'), {
    directory,
    revision: view.revision,
    tree: (await previewGitCommit(directory, view.revision, ['selected'])).tree,
    paths: ['selected'],
    message: 'fail',
  });
  assert.equal(result.state, 'failed');
  assert.match(result.error!, /validator refused/);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.deepEqual(readFileSync(join(directory, '.git/index')), beforeHook);
  assert.equal(existsSync(join(directory, '.git/index.lock')), false);
  assert.equal(readFileSync(join(directory, 'selected'), 'utf8'), 'partial\n');
  assert.ok(originalIndex.length > 0);
});

test('a native hook cannot expand the approved commit tree and disabled hooks remain disabled', async (t) => {
  const { root, directory, git } = setup();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(directory, 'selected'), 'chosen\n');
  writeFileSync(join(directory, 'other'), 'outside selection\n');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(join(directory, '.git/hooks/pre-commit'), '#!/bin/sh\ngit add -- other\n', {
    mode: 0o700,
  });
  const view = await inspectGitChanges(directory),
    index = readFileSync(join(directory, '.git/index'));
  const result = await commitGitFiles(join(root, 'expanded'), {
    directory,
    revision: view.revision,
    tree: (await previewGitCommit(directory, view.revision, ['selected'])).tree,
    paths: ['selected'],
    message: 'chosen only',
  });
  assert.equal(result.state, 'failed');
  assert.match(result.error!, /contents changed after preview/);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.deepEqual(readFileSync(join(directory, '.git/index')), index);
  assert.equal(git('diff', '--cached'), '');
  git('config', 'core.hooksPath', '/dev/null');
  const next = await inspectGitChanges(directory);
  const committed = await commitGitFiles(join(root, 'disabled-hooks'), {
    directory,
    revision: next.revision,
    tree: (await previewGitCommit(directory, next.revision, ['selected'])).tree,
    paths: ['selected'],
    message: 'selected only',
  });
  assert.equal(committed.state, 'committed', committed.error ?? '');
  assert.equal(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'selected');
});

test(
  'supervised recovery after pre/post-commit termination never reruns hooks or loses unselected staging',
  { timeout: 30000 },
  async (t) => {
    const { createGit } = await import('@parallel-pi/infra-git');
    const { createSupervisor } = await import('@parallel-pi/infra-platform');
    for (const name of ['pre-commit', 'post-commit']) {
      const { root, directory, git } = setup();
      t.after(() => rmSync(root, { recursive: true, force: true }));
      writeFileSync(join(directory, 'selected'), 'chosen\n');
      writeFileSync(join(directory, 'other'), 'staged other\n');
      git('add', '--', 'other');
      const index = readFileSync(join(directory, '.git/index')),
        head = git('rev-parse', 'HEAD');
      writeFileSync(
        join(directory, '.git/hooks', name),
        '#!/bin/sh\nprintf "once\\n" >> hook-count\nsleep 20\n',
        { mode: 0o700 },
      );
      const supervisor = createSupervisor(join(root, 'supervision'));
      let child: ReturnType<typeof supervisor.start> | undefined;
      const adapter = createGit(
        {
          ...supervisor,
          start(spec) {
            child = supervisor.start(spec);
            return child;
          },
        },
        join(root, 'transactions'),
      );
      const view = await inspectGitChanges(directory);
      let started!: () => void;
      const hookStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const committing = adapter.commitFiles(
        {
          directory,
          operationId: 'commit',
          jobId: 'job',
          revision: view.revision,
          tree: (await previewGitCommit(directory, view.revision, ['selected'])).tree,
          paths: ['selected'],
          message: 'supervised commit',
        },
        (event) => {
          if (event.name === name && event.phase === 'started') started();
        },
      );
      const outcome = committing.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await hookStarted;
      assert.equal(existsSync(join(directory, '.git/index.lock')), true);
      await child!.stop();
      await outcome;
      assert.equal((await supervisor.recover('commit')).settled, true);
      const recovered = await adapter.recoverCommit({
        directory,
        operationId: 'recover',
        jobId: 'job',
      });
      assert.equal(
        recovered.state,
        name === 'pre-commit' ? 'failed' : 'committed',
        recovered.error ?? '',
      );
      assert.equal(git('show', ':other'), 'staged other');
      if (name === 'pre-commit') {
        assert.equal(git('rev-parse', 'HEAD'), head);
        assert.deepEqual(readFileSync(join(directory, '.git/index')), index);
      } else {
        assert.equal(git('show', 'HEAD:selected'), 'chosen');
        assert.equal(git('diff', '--cached', '--name-only'), 'other');
      }
      assert.equal(existsSync(join(directory, '.git/index.lock')), false);
      assert.equal(readFileSync(join(directory, 'hook-count'), 'utf8'), 'once\n');
      if (name === 'post-commit') assert.match(recovered.error!, /post-commit was interrupted/);
      const repeated = await adapter.recoverCommit({
        directory,
        operationId: 'recover-again',
        jobId: 'job',
      });
      assert.deepEqual(repeated, recovered);
      assert.equal(readFileSync(join(directory, 'hook-count'), 'utf8'), 'once\n');
    }
  },
);

test('commit confirmation shows native clean-filter output and rejects later conversion changes', async (t) => {
  const { root, directory, git } = setup();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(directory, '.gitattributes'), 'new.txt filter=case\n');
  writeFileSync(join(directory, 'new.txt'), 'lower text\n');
  git('config', 'filter.case.clean', 'tr a-z A-Z');
  const view = await inspectGitChanges(directory);
  const preview = await previewGitCommit(directory, view.revision, ['new.txt']);
  assert.match(preview.diff, /\+LOWER TEXT/);
  const index = readFileSync(join(directory, '.git/index'));
  git('config', 'filter.case.clean', 'cat');
  const rejected = await commitGitFiles(join(root, 'changed-filter'), {
    directory,
    revision: view.revision,
    tree: preview.tree,
    paths: ['new.txt'],
    message: 'filtered',
  });
  assert.equal(rejected.state, 'failed');
  assert.match(rejected.error!, /changed|differs/);
  assert.deepEqual(readFileSync(join(directory, '.git/index')), index);
  git('config', 'filter.case.clean', 'tr a-z A-Z');
  const current = await inspectGitChanges(directory);
  const approved = await previewGitCommit(directory, current.revision, ['new.txt']);
  const result = await commitGitFiles(join(root, 'filtered'), {
    directory,
    revision: current.revision,
    tree: approved.tree,
    paths: ['new.txt'],
    message: 'filtered',
  });
  assert.equal(result.state, 'committed', result.error ?? '');
  assert.equal(git('show', 'HEAD:new.txt'), 'LOWER TEXT');
  assert.equal(readFileSync(join(directory, 'new.txt'), 'utf8'), 'lower text\n');
});

test(
  'termination during private-index preparation releases only the owned lock without starting a commit',
  { timeout: 20000 },
  async (t) => {
    const { createGit } = await import('@parallel-pi/infra-git');
    const { createSupervisor } = await import('@parallel-pi/infra-platform');
    const { setTimeout: delay } = await import('node:timers/promises');
    const { root, directory, git } = setup();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(directory, 'selected'), 'chosen\n');
    writeFileSync(join(directory, '.gitattributes'), 'selected filter=hold\n');
    const filter = join(root, 'filter');
    writeFileSync(
      filter,
      `#!/bin/sh\ncase "$GIT_INDEX_FILE" in */selected.index) printf preparing >'${join(root, 'preparing')}'; sleep 20;; esac\ncat\n`,
      { mode: 0o700 },
    );
    git('config', 'filter.hold.clean', filter);
    const view = await inspectGitChanges(directory);
    const preview = await previewGitCommit(directory, view.revision, ['selected']);
    const index = readFileSync(join(directory, '.git/index')),
      head = git('rev-parse', 'HEAD');
    const supervisor = createSupervisor(join(root, 'supervision'));
    let child: ReturnType<typeof supervisor.start> | undefined;
    const adapter = createGit(
      {
        ...supervisor,
        start(spec) {
          child = supervisor.start(spec);
          return child;
        },
      },
      join(root, 'transactions'),
    );
    const committing = adapter.commitFiles(
      {
        directory,
        operationId: 'prepare',
        jobId: 'job',
        revision: view.revision,
        tree: preview.tree,
        paths: ['selected'],
        message: 'interrupted preparation',
      },
      () => {},
    );
    const outcome = committing.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    for (let i = 0; i < 200 && !existsSync(join(root, 'preparing')); i++) await delay(25);
    assert.equal(existsSync(join(root, 'preparing')), true);
    await child!.stop();
    await outcome;
    assert.equal((await supervisor.recover('prepare')).settled, true);
    const result = await adapter.recoverCommit({ directory, operationId: 'recover', jobId: 'job' });
    assert.equal(result.state, 'failed', result.error ?? '');
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.deepEqual(readFileSync(join(directory, '.git/index')), index);
    assert.equal(existsSync(join(directory, '.git/index.lock')), false);
  },
);

test('whole-file submission includes staged deletion and both selected rename paths', async (t) => {
  const { root, directory, git } = setup();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git('mv', '--', 'selected', 'renamed');
  git('rm', '--', 'other');
  const view = await inspectGitChanges(directory),
    paths = ['selected', 'renamed', 'other'];
  const preview = await previewGitCommit(directory, view.revision, paths);
  const result = await commitGitFiles(join(root, 'rename-delete'), {
    directory,
    revision: view.revision,
    tree: preview.tree,
    paths,
    message: 'rename and delete',
  });
  assert.equal(result.state, 'committed', result.error ?? '');
  assert.equal(git('ls-tree', '--name-only', 'HEAD'), 'renamed');
  assert.equal(git('status', '--porcelain'), '');
});
