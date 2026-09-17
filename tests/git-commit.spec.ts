import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

test('explicit whole-file commit retains failed input and restores real hook progress after reload', async ({
  page,
}) => {
  test.setTimeout(60000);
  const root = mkdtempSync(join(tmpdir(), 'parallel-browser-commit-')),
    directory = join(root, 'repository');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(directory);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(directory, 'other'), 'original\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  writeFileSync(join(directory, 'other'), 'staged other\n');
  git('add', '--', 'other');
  writeFileSync(join(directory, 'other'), 'working other\n');
  writeFileSync(join(directory, 'selected.txt'), 'selected version one\n');
  const initial = git('rev-parse', 'HEAD'),
    index = readFileSync(join(directory, '.git/index'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('/');
    await expect(page.getByRole('status')).toHaveText('本地服务已连接');
    const added = await page.request.post('/api/command', {
      data: { type: 'project.add', directory },
    });
    expect(added.ok()).toBe(true);
    await page.getByRole('button', { name: new RegExp(basename(directory)) }).click();
    await page
      .getByRole('region', { name: 'main', exact: true })
      .getByRole('button', { name: '分支变更', exact: true })
      .click();
    let dialog = page.getByRole('dialog', { name: '分支变更', exact: true });
    await expect(dialog.getByRole('checkbox', { name: '提交 other', exact: true })).toBeDisabled();
    await dialog.getByRole('checkbox', { name: '提交 selected.txt', exact: true }).check();
    await dialog.getByLabel('提交消息', { exact: true }).fill('User approved selected file');
    await dialog.getByRole('button', { name: '预览实际提交内容', exact: true }).click();
    await expect(dialog.getByRole('region', { name: '确认提交内容' })).toContainText(
      '+selected version one',
    );
    expect(git('rev-parse', 'HEAD')).toBe(initial);
    writeFileSync(join(directory, 'selected.txt'), 'selected version two\n');
    await dialog.getByRole('button', { name: '确认创建本地提交', exact: true }).click();
    await expect(dialog.getByRole('region', { name: '最近提交结果' })).toContainText('提交未完成');
    await expect(dialog.getByLabel('提交消息', { exact: true })).toHaveValue(
      'User approved selected file',
    );
    await expect(
      dialog.getByRole('checkbox', { name: '提交 selected.txt', exact: true }),
    ).toBeChecked();
    expect(git('rev-parse', 'HEAD')).toBe(initial);
    expect(readFileSync(join(directory, '.git/index'))).toEqual(index);
    const hook = join(directory, '.git/hooks/pre-commit');
    writeFileSync(
      hook,
      `#!/bin/sh\nprintf 'once\\n' >>'${join(root, 'count')}'\nprintf 'validator refused\\n' >&2\nexit 3\n`,
      { mode: 0o700 },
    );
    await dialog.getByRole('button', { name: '重新读取变更' }).click();
    await dialog.getByRole('button', { name: '预览实际提交内容' }).click();
    await expect(dialog.getByRole('region', { name: '确认提交内容' })).toContainText(
      '+selected version two',
    );
    await dialog.getByRole('button', { name: '确认创建本地提交' }).click();
    await expect(dialog.getByRole('region', { name: '最近提交结果' })).toContainText(
      'validator refused',
    );
    await expect(dialog.getByLabel('提交消息', { exact: true })).toHaveValue(
      'User approved selected file',
    );
    expect(git('rev-parse', 'HEAD')).toBe(initial);
    writeFileSync(
      hook,
      `#!/bin/sh\nprintf 'once\\n' >>'${join(root, 'count')}'\nwhile [ ! -f '${join(root, 'release')}' ]; do sleep 0.1; done\n`,
      { mode: 0o700 },
    );
    await dialog.getByRole('button', { name: '重新读取变更' }).click();
    await dialog.getByRole('button', { name: '预览实际提交内容' }).click();
    await expect(dialog.getByRole('region', { name: '确认提交内容' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByRole('button', { name: '确认创建本地提交' }).scrollIntoViewIfNeeded();
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/git-commit-confirm-narrow.png', fullPage: true });
    await dialog.getByRole('button', { name: '确认创建本地提交' }).click();
    await expect(dialog.getByRole('region', { name: '最近提交结果' })).toContainText(
      '正在运行钩子：pre-commit',
      { timeout: 10000 },
    );
    await page.reload();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page
      .getByRole('region', { name: 'main', exact: true })
      .getByRole('button', { name: '分支变更', exact: true })
      .click();
    dialog = page.getByRole('dialog', { name: '分支变更', exact: true });
    await expect(dialog.getByRole('region', { name: '最近提交结果' })).toContainText(
      '正在运行钩子：pre-commit',
    );
    writeFileSync(join(root, 'release'), 'continue');
    await expect(dialog.getByRole('region', { name: '最近提交结果' })).toContainText('提交已创建', {
      timeout: 10000,
    });
    await expect(dialog.getByRole('region', { name: '最近提交结果' })).toContainText(
      git('rev-parse', 'HEAD'),
    );
    expect(git('rev-list', '--count', 'HEAD')).toBe('2');
    expect(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe('selected.txt');
    expect(git('show', ':other')).toBe('staged other');
    expect(readFileSync(join(directory, 'other'), 'utf8')).toBe('working other\n');
    expect(readFileSync(join(root, 'count'), 'utf8')).toBe('once\nonce\n');
    await expect(dialog.getByLabel('提交消息', { exact: true })).toHaveValue('');
    // Deliver the real commit to the backend, then lose only its HTTP confirmation.
    writeFileSync(join(directory, 'selected.txt'), 'confirmation lost content\n');
    await dialog.getByRole('button', { name: '重新读取变更' }).click();
    await dialog.getByRole('checkbox', { name: '提交 selected.txt', exact: true }).check();
    await dialog.getByLabel('提交消息', { exact: true }).fill('Retry the same confirmed intent');
    await dialog.getByRole('button', { name: '预览实际提交内容' }).click();
    const requests: unknown[] = [];
    await page.route('**/api/command', async (route) => {
      const input = route.request().postDataJSON();
      if (input.type !== 'git.commit') return route.continue();
      requests.push(input);
      if (requests.length !== 1) return route.continue();
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      const result = await response.json();
      expect(result.state).toBe('committed');
      // Let the durable snapshot arrive while submit is still waiting for HTTP.
      await expect(dialog.getByRole('region', { name: '最近提交结果' })).toContainText(
        result.commit,
      );
      await route.abort('connectionreset');
    });
    await dialog.getByRole('button', { name: '确认创建本地提交' }).click();
    await expect(dialog.getByRole('group', { name: '未确认的提交请求' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '重试同一提交请求' })).toBeEnabled();
    expect(git('rev-list', '--count', 'HEAD')).toBe('3');
    await dialog.getByRole('button', { name: '重试同一提交请求' }).click();
    await expect(dialog.getByRole('group', { name: '未确认的提交请求' })).toHaveCount(0);
    await expect(dialog.getByLabel('提交消息', { exact: true })).toHaveValue('');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(git('rev-list', '--count', 'HEAD')).toBe('3');
    expect(readFileSync(join(root, 'count'), 'utf8')).toBe('once\nonce\nonce\n');
    expect(git('show', ':other')).toBe('staged other');
    await page.unroute('**/api/command');
    const beforeReviewHead = git('rev-parse', 'HEAD'),
      beforeReviewIndex = readFileSync(join(directory, '.git/index'));
    writeFileSync(join(directory, 'selected.txt'), 'external review content\n');
    writeFileSync(
      join(directory, '.git/hooks/post-commit'),
      '#!/bin/sh\ngit update-ref refs/heads/main "$(git rev-parse HEAD^)"\n',
      { mode: 0o700 },
    );
    await dialog.getByRole('button', { name: '重新读取变更' }).click();
    await dialog.getByRole('checkbox', { name: '提交 selected.txt', exact: true }).check();
    await dialog.getByLabel('提交消息', { exact: true }).fill('Inspect external ref movement');
    await dialog.getByRole('button', { name: '预览实际提交内容' }).click();
    await dialog.getByRole('button', { name: '确认创建本地提交' }).click();
    await expect(dialog.getByRole('region', { name: '最近提交结果' })).toContainText(
      '提交结果需要核对',
    );
    expect(git('rev-parse', 'HEAD')).toBe(beforeReviewHead);
    await dialog.getByRole('button', { name: '已在外部 Git 核对，保留当前状态' }).click();
    await expect(dialog.getByRole('group', { name: '确认外部 Git 核对' })).toBeVisible();
    await dialog.getByRole('button', { name: '确认已核对并保留当前状态' }).click();
    await expect(dialog.getByRole('region', { name: '最近提交结果' })).toContainText(
      '已记录外部核对',
    );
    expect(git('rev-parse', 'HEAD')).toBe(beforeReviewHead);
    expect(readFileSync(join(directory, '.git/index'))).toEqual(beforeReviewIndex);
    expect(existsSync(join(directory, '.git/index.lock'))).toBe(false);
    expect(readFileSync(join(directory, 'selected.txt'), 'utf8')).toBe('external review content\n');
    expect(errors).toEqual([]);
  } finally {
    writeFileSync(join(root, 'release'), 'continue');
    rmSync(root, { recursive: true, force: true });
  }
});
