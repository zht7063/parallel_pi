import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

test('workspace memory initializes explicitly, recalls and corrects with visible conflict recovery', async ({
  page,
}) => {
  test.setTimeout(45000);
  const root = mkdtempSync(join(tmpdir(), 'parallel-browser-memory-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'code'), 'original');
  git('add', '.');
  git('commit', '-m', 'initial');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const command = async (data: unknown) => {
    const response = await page.request.post('/api/command', { data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  try {
    await page.goto('/');
    await expect(page.getByRole('status')).toHaveText('本地服务已连接');
    const project = await command({ type: 'project.add', directory: root });
    await page.getByRole('button', { name: new RegExp(basename(root)) }).click();
    const snapshot = await (await page.request.get('/api/snapshot')).json();
    const lane = snapshot.lanes.find(
      (item: { projectId: string }) => item.projectId === project.id,
    );
    await page
      .getByRole('region', { name: 'main', exact: true })
      .getByRole('button', { name: '工作区记忆' })
      .click();
    const dialog = page.getByRole('dialog', { name: '工作区记忆' });
    await expect(dialog.getByLabel('共享记忆的 Git 策略')).toHaveValue('track');
    await dialog.getByLabel('共享记忆的 Git 策略').selectOption('ignore');
    await dialog.getByRole('button', { name: '初始化记忆', exact: true }).click();
    await expect(dialog.getByText('当前 Git 策略：ignore')).toBeVisible();
    expect(JSON.parse(readFileSync(join(root, '.mwf/config.json'), 'utf8')).git_mode).toBe(
      'ignore',
    );
    expect(git('check-ignore', '.mwf/config.json', '.mwf/local/private.txt').toString()).toContain(
      '.mwf/local/private.txt',
    );
    const session = await command({
      type: 'session.create',
      laneId: lane.id,
      title: 'Memory source',
      model: { provider: 'parallel-probe', model: 'probe-a' },
    });
    await command({
      type: 'memory.save',
      requestId: 'browser-memory-record',
      sessionId: session.id,
      content: {
        type: 'knowledge',
        title: 'Build guidance',
        summary: 'Build notes',
        body: 'Verified source content',
        candidate: true,
        scope: { paths: ['src/**'] },
      },
    });
    await dialog.getByRole('button', { name: '重新读取记忆' }).click();
    await dialog.getByRole('button', { name: 'Build guidance · candidate', exact: true }).click();
    await expect(dialog.getByLabel('记忆正文与来源')).toHaveValue(/parallel_pi session:/);
    await dialog.getByLabel('记忆状态').selectOption('stable');
    await dialog.getByLabel('记忆摘要').fill('Confirmed build guidance');
    const read = await command({ type: 'memory.inspect', laneId: lane.id });
    const record = read.records[0];
    const recordPath = join(root, record.path);
    writeFileSync(
      recordPath,
      readFileSync(recordPath, 'utf8').replace('Verified source content', 'External source edit'),
    );
    await dialog.getByRole('button', { name: '保存记忆纠正' }).click();
    await expect(dialog.locator('#memory-error')).toContainText('changed; reload');
    await expect(dialog.getByLabel('记忆摘要')).toHaveValue('Confirmed build guidance');
    await expect(dialog.getByRole('region', { name: '待确认的记忆修改' })).toBeVisible();
    await dialog.getByRole('button', { name: '暂不重试这次修改' }).click();
    await dialog.getByRole('button', { name: '确认暂不重试', exact: true }).click();
    await dialog.getByRole('button', { name: '重新读取记忆' }).click();
    await expect(dialog.getByLabel('记忆摘要')).toHaveValue('Confirmed build guidance');
    await dialog
      .getByLabel('记忆正文与来源')
      .fill('Confirmed after external source edit. Source: original session.');
    await page.keyboard.press('Escape');
    await expect(dialog.getByRole('group', { name: '放弃未保存修改' })).toBeVisible();
    await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
    await dialog.getByRole('button', { name: '保存记忆纠正' }).click();
    await expect(dialog.getByRole('status')).toContainText('记忆已保存');
    await dialog.getByLabel('相关文件路径').fill('src/main.ts');
    await dialog.getByRole('button', { name: '按条件召回' }).click();
    await expect(dialog.getByText('召回依据：path:src/**')).toBeVisible();
    await dialog.getByRole('button', { name: 'Build guidance · stable', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByLabel('记忆正文与来源').scrollIntoViewIfNeeded();
    await expect(dialog.getByLabel('记忆正文与来源')).toHaveCSS('resize', 'none');
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/memory-narrow.png', fullPage: true });
    await dialog.getByLabel('记忆状态').selectOption('deprecated');
    await dialog.getByRole('button', { name: '保存记忆纠正' }).click();
    await expect(dialog.getByRole('status')).toContainText('记忆已保存');
    await expect(dialog.getByText(/原生召回结果.*0 条/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
