import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

test('worktree settings preserve native fields, apply trust and keep queued models frozen across a UI switch', async ({
  page,
}) => {
  test.setTimeout(45000);
  const root = mkdtempSync(join(tmpdir(), 'parallel-browser-settings-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  mkdirSync(join(root, '.pi'));
  const path = join(root, '.pi/settings.json');
  writeFileSync(
    path,
    JSON.stringify({
      defaultProvider: 'parallel-probe',
      defaultModel: 'probe-b',
      unknown: { keep: true },
    }),
  );
  git('add', '.');
  git('commit', '-m', 'initial');
  git('branch', 'other');
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
    const configuration = await (await page.request.get('/api/configuration')).json();
    expect(
      (
        await page.request.post('/api/configuration', {
          data: {
            kind: 'defaults',
            revision: configuration.settingsRevision,
            provider: 'parallel-probe',
            model: 'probe-a',
          },
        })
      ).ok(),
    ).toBe(true);
    const project = await command({ type: 'project.add', directory: root });
    await page.getByRole('button', { name: new RegExp(basename(root)) }).click();
    const main = page.getByRole('region', { name: 'main', exact: true });
    await main.getByRole('button', { name: '工作区设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '工作区设置', exact: true });
    await expect(dialog.getByText('当前有效：parallel-probe / probe-a')).toBeVisible();
    await expect(dialog.getByText('文件中：parallel-probe / probe-b')).toBeVisible();
    await dialog.getByLabel('此工作区的信任选择').selectOption('trust');
    await dialog.getByRole('button', { name: '确认信任此工作区' }).click();
    await expect(dialog.getByText('当前有效：parallel-probe / probe-b')).toBeVisible();
    await expect(dialog.getByLabel('此工作区的信任选择')).toHaveValue('trust');
    await dialog.getByLabel('工作区默认模型 ID').fill('probe-a');
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: 'parallel-probe',
        defaultModel: 'external-edit',
        unknown: { keep: true },
      }),
    );
    await dialog.getByRole('button', { name: '保存工作区默认模型' }).click();
    await expect(dialog.locator('#project-settings-error')).toContainText('changed; reload');
    await expect(dialog.getByLabel('工作区默认模型 ID')).toHaveValue('probe-a');
    await dialog.getByRole('button', { name: '重新读取工作区配置' }).click();
    await expect(dialog.getByText('文件中：parallel-probe / external-edit')).toBeVisible();
    await dialog.getByLabel('工作区默认模型 ID').fill('probe-b');
    await dialog.getByRole('button', { name: '保存工作区默认模型' }).click();
    await expect(dialog.getByRole('status')).toContainText('已保存');
    expect(JSON.parse(readFileSync(path, 'utf8')).unknown).toEqual({ keep: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByLabel('此工作区的信任选择').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: 'test-results/project-settings-narrow.png', fullPage: true });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await main.getByRole('button', { name: '＋ 新建独立会话', exact: true }).click();
    await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('probe-b');
    await page.getByLabel('会话标题').fill('设置验证会话');
    await page.getByRole('button', { name: '创建会话', exact: true }).click();
    await expect(page.getByRole('heading', { name: '设置验证会话' })).toBeVisible();
    const snapshot = await (await page.request.get('/api/snapshot')).json();
    const session = snapshot.sessions.find(
      (item: { title: string }) => item.title === '设置验证会话',
    );
    const run = await command({
      type: 'run.enqueue',
      requestId: crypto.randomUUID(),
      sessionId: session.id,
      text: 'probe-question-tool',
      attachmentIds: [],
    });
    await expect(page.getByText('Continue probe tool?', { exact: true })).toBeVisible();
    const queued = await command({
      type: 'run.enqueue',
      requestId: crypto.randomUUID(),
      sessionId: session.id,
      text: 'frozen model',
      attachmentIds: [],
    });
    await page.getByRole('button', { name: '切换会话模型' }).click();
    await page.getByLabel('模型 ID', { exact: true }).fill('probe-a');
    await page.getByRole('button', { name: '保存会话模型' }).click();
    await expect(page.locator('.conversation-heading')).toContainText('probe-a');
    const changed = await (await page.request.get('/api/snapshot')).json();
    expect(changed.runs.find((item: { id: string }) => item.id === run.id).model.model).toBe(
      'probe-b',
    );
    expect(changed.runs.find((item: { id: string }) => item.id === queued.id).model.model).toBe(
      'probe-b',
    );
    await command({ type: 'run.stop', runId: run.id });
    await expect(page.getByRole('button', { name: '恢复未启动的队列', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消排队', exact: true }).click();
    const other = changed.lanes.find(
      (item: { projectId: string; ref: string }) =>
        item.projectId === project.id && item.ref === 'refs/heads/other',
    );
    const otherView = await command({ type: 'project.configuration', laneId: other.id });
    expect(otherView.directory).not.toBe(root);
    expect(otherView.trusted).toBe(false);
    expect(otherView.effective.model).toBe('probe-a');
    expect(errors).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
