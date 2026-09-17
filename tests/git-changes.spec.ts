import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

test('branch changes show staged and working content, retain failed reads and fit a narrow dialog', async ({
  page,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-browser-git-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'code'), 'original\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  writeFileSync(join(root, 'code'), 'staged edit\n');
  git('add', '--', 'code');
  writeFileSync(join(root, 'code'), 'working edit\n');
  writeFileSync(join(root, 'new.txt'), 'untracked text\n');
  const index = readFileSync(join(root, '.git/index'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('/');
    await expect(page.getByRole('status')).toHaveText('本地服务已连接');
    const response = await page.request.post('/api/command', {
      data: { type: 'project.add', directory: root },
    });
    expect(response.ok()).toBe(true);
    await page.getByRole('button', { name: new RegExp(basename(root)) }).click();
    await page
      .getByRole('region', { name: 'main', exact: true })
      .getByRole('button', { name: '分支变更', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: '分支变更', exact: true });
    await expect(dialog.getByText(/基准 HEAD：/)).toContainText(
      git('rev-parse', 'HEAD').toString().trim(),
    );
    await expect(dialog.getByRole('region', { name: '已暂存内容', exact: true })).toContainText(
      '+staged edit',
    );
    await expect(dialog.getByRole('region', { name: '工作区内容', exact: true })).toContainText(
      '+working edit',
    );
    await expect(dialog.getByText(/请在外部 Git 工具处理部分暂存/)).toBeVisible();
    await dialog.getByRole('button', { name: 'new.txt · 未跟踪', exact: true }).click();
    await expect(dialog.getByRole('region', { name: '工作区内容', exact: true })).toContainText(
      '+untracked text',
    );
    let fail = true;
    await page.route('**/api/command', (route) => {
      if (fail && route.request().postDataJSON()?.type === 'git.inspect')
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Preview unavailable' } }),
        });
      return route.continue();
    });
    await dialog.getByRole('button', { name: '重新读取变更' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Preview unavailable');
    await expect(dialog.getByText(/保留上次读取的结果/)).toBeVisible();
    await expect(dialog.getByRole('region', { name: '工作区内容', exact: true })).toContainText(
      '+untracked text',
    );
    fail = false;
    writeFileSync(join(root, 'new.txt'), 'fresh text\n');
    await dialog.getByRole('button', { name: '重新读取变更' }).click();
    await expect(dialog.getByRole('region', { name: '工作区内容', exact: true })).toContainText(
      '+fresh text',
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByRole('region', { name: '工作区内容', exact: true }).scrollIntoViewIfNeeded();
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/git-changes-narrow.png', fullPage: true });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(readFileSync(join(root, '.git/index'))).toEqual(index);
    expect(errors).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
