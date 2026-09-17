import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

test('shared relation map preserves independent viewports, previews, drafts and project navigation', async ({
  page,
}) => {
  test.setTimeout(90000);
  const root = mkdtempSync(join(tmpdir(), 'parallel-map-'));
  const repos = ['alpha', 'beta'].map((name) => {
    const path = join(root, name);
    mkdirSync(path);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', path, ...args], { stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(path, 'code'), 'initial');
    git('add', '.');
    git('commit', '-m', 'initial');
    for (let i = 0; i < 5; i++) git('branch', `feature-${i}`);
    return path;
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('/');
    await expect(page.getByRole('status')).toHaveText('本地服务已连接');
    const command = (input: unknown) =>
      page.evaluate(async (value) => {
        const response = await fetch('/api/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(value),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(result));
        return result;
      }, input);
    const alpha = await command({ type: 'project.add', directory: repos[0] });
    const beta = await command({ type: 'project.add', directory: repos[1] });
    const snapshot = await page.evaluate(async () => (await fetch('/api/snapshot')).json());
    const lane = snapshot.lanes.find(
      (item: { projectId: string; ref: string }) =>
        item.projectId === alpha.id && item.ref === 'refs/heads/main',
    );
    const create = (title: string, parentSessionId?: string) =>
      command({
        type: 'session.create',
        laneId: lane.id,
        title,
        parentSessionId,
        requestId: crypto.randomUUID(),
        model: { provider: 'parallel-probe', model: 'probe-a' },
      });
    const source = await create('地图根会话');
    const continued = await create('接续分支', source.id);
    const independent = await create('另一个独立思路');
    await page.getByRole('button', { name: new RegExp(basename(repos[0]!)) }).click();
    const global = page.getByRole('region', { name: '全局分支地图', exact: true });
    await expect(global.locator('.session-node')).toHaveCount(3);
    await expect(global.locator('.session-edges g')).toHaveCount(1);
    await expect(global.locator('.session-edges text')).toHaveText('接续');
    const viewport = global.locator('.map-viewport');
    await global.getByRole('button', { name: '缩小地图', exact: true }).click();
    await global.getByRole('button', { name: '向右平移地图', exact: true }).click();
    await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await viewport.evaluate((el) => {
      el.scrollTop = 130;
    });
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(130);
    // Explicit enter can scroll its node into view; save the actual resulting viewport.
    const preview = global.getByRole('button', { name: '预览 地图根会话', exact: true });
    await preview.click();
    await expect(global.getByRole('region', { name: '会话预览' })).toBeVisible();
    const saved = await viewport.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
    await global.getByRole('button', { name: '进入会话', exact: true }).click();
    await expect(page.getByRole('heading', { name: '地图根会话', exact: true })).toBeVisible();
    const composer = page.getByLabel('消息', { exact: true });
    await composer.fill('地图切换保留的草稿');
    await page.getByRole('button', { name: '查看地图', exact: true }).click();
    const overlay = page.getByRole('region', { name: '会话中的项目地图', exact: true });
    await expect(overlay).toBeVisible();
    await overlay.getByRole('button', { name: '放大地图', exact: true }).click();
    await overlay.getByRole('button', { name: '预览 接续分支', exact: true }).press('Enter');
    await expect(overlay.getByRole('region', { name: '会话预览' })).toContainText('接续分支');
    await expect
      .poll(() => overlay.locator('.map-viewport').evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(0);
    expect(await overlay.locator('.map-space').evaluate((el) => el.scrollLeft)).toBe(0);
    await expect(page.locator('.conversation-heading h2')).toHaveText('地图根会话');
    await expect(composer).toHaveValue('地图切换保留的草稿');
    await page.keyboard.press('Escape');
    await expect(overlay.getByRole('region', { name: '会话预览' })).toHaveCount(0);
    await expect(overlay).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看地图', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '查看地图', exact: true }).click();
    await expect(overlay.locator('.map-controls')).toContainText('110%');
    await overlay.getByRole('button', { name: '预览 接续分支', exact: true }).dblclick();
    await expect(overlay).toHaveCount(0);
    await expect(page.locator('.conversation-heading h2')).toHaveText('接续分支');
    await expect(composer).toHaveValue('');
    const thumb = page.getByRole('button', {
      name: '项目地图缩略图：单击查看地图，双击返回全局',
      exact: true,
    });
    await thumb.dblclick();
    await expect(global).toBeVisible();
    await expect(global.locator('.map-controls')).toContainText('90%');
    await expect(global.getByRole('region', { name: '会话预览' })).toBeVisible();
    await expect
      .poll(() => viewport.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop })))
      .toEqual(saved);
    await global.getByRole('button', { name: '关闭预览', exact: true }).click();
    // Put the target beneath the future right-side preview; double-click must still enter.
    await page.setViewportSize({ width: 620, height: 844 });
    await global.getByRole('button', { name: '预览 地图根会话', exact: true }).dblclick();
    await expect(page.locator('.conversation-heading h2')).toHaveText('地图根会话');
    await expect(composer).toHaveValue('地图切换保留的草稿');
    await page.getByRole('button', { name: '项目', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(basename(repos[1]!)) }).click();
    await expect(page.getByRole('heading', { name: '分支地图', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '项目', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(basename(repos[0]!)) }).click();
    await expect(page.locator('.conversation-heading h2')).toHaveText('地图根会话');
    await expect(composer).toHaveValue('地图切换保留的草稿');
    await page.reload();
    await expect(page.locator('.conversation-heading h2')).toHaveText('地图根会话');
    await expect(composer).toHaveValue('地图切换保留的草稿');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '查看地图', exact: true }).click();
    await overlay.getByRole('button', { name: '定位当前会话', exact: true }).click();
    await expect(
      overlay.getByRole('button', { name: '预览 地图根会话', exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: 'test-results/map-overlay-narrow.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const after = await page.evaluate(async () => (await fetch('/api/snapshot')).json());
    expect(
      after.runs.filter((run: { sessionId: string }) =>
        [source.id, continued.id, independent.id].includes(run.sessionId),
      ),
    ).toHaveLength(0);
    const background = await command({
      type: 'run.enqueue',
      sessionId: source.id,
      requestId: crypto.randomUUID(),
      text: 'probe-slow-tool',
      attachmentIds: [],
    });
    await expect(
      overlay
        .getByRole('region', { name: 'main', exact: true })
        .locator('.lane-heading .status-chip'),
    ).toHaveText('执行中');
    await overlay.getByRole('button', { name: '预览 接续分支', exact: true }).dblclick();
    await expect(page.locator('.branch-occupancy')).toContainText('地图根会话');
    await composer.fill('后台占用时仍可编辑');
    await expect(page.getByRole('button', { name: '加入队列', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '项目', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(basename(repos[1]!)) }).click();
    const during = await page.evaluate(async () => (await fetch('/api/snapshot')).json());
    expect(during.runs.find((run: { id: string }) => run.id === background.id).state).toBe(
      'running',
    );
    await page.getByRole('button', { name: '项目', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(basename(repos[0]!)) }).click();
    await expect(page.locator('.conversation-heading h2')).toHaveText('接续分支');
    await expect(composer).toHaveValue('后台占用时仍可编辑');
    await command({ type: 'run.stop', runId: background.id });
    await command({ type: 'lane.resume', laneId: lane.id });
    await page.getByRole('button', { name: '查看地图', exact: true }).click();
    await overlay.getByRole('button', { name: '预览 地图根会话', exact: true }).dblclick();
    // UI-only long-history fixture; HTTP cursor semantics are separately tested against the backend.
    const fixtureMessages = Array.from({ length: 95 }, (_, index) => ({
      id: `history-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      text: `分页历史消息 ${index}`,
      images: [],
      forkable: index % 2 === 0,
    }));
    let failEarlier = true;
    await page.route('**/api/snapshot', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const item = body.sessions.find((session: { id: string }) => session.id === source.id);
      item.messages = fixtureMessages.slice(-40);
      item.messageCount = fixtureMessages.length;
      await route.fulfill({ response, json: body });
    });
    await page.route('**/api/history?*', async (route) => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get('sessionId') !== source.id) return route.continue();
      const before = query.get('before');
      if (before && failEarlier) {
        failEarlier = false;
        return route.fulfill({
          status: 503,
          json: { error: { message: '历史读取暂时失败，输入保留' } },
        });
      }
      const end = before
        ? fixtureMessages.findIndex((message) => message.id === before)
        : fixtureMessages.length;
      const start = Math.max(0, end - 40);
      return route.fulfill({
        json: {
          messages: fixtureMessages.slice(start, end),
          total: fixtureMessages.length,
          more: start > 0,
        },
      });
    });
    await page.reload();
    await expect(page.locator('.message')).toHaveCount(40);
    await page.getByRole('button', { name: /加载更早消息/ }).click();
    await expect(page.getByRole('button', { name: '重试读取历史', exact: true })).toBeVisible();
    await expect(page.locator('.message')).toHaveCount(40);
    await expect(composer).toHaveValue('地图切换保留的草稿');
    await page.getByRole('button', { name: '重试读取历史', exact: true }).click();
    await expect(page.locator('.message')).toHaveCount(80);
    await page.getByRole('button', { name: /加载更早消息/ }).click();
    await expect(page.locator('.message')).toHaveCount(95);
    await page
      .locator('.message')
      .first()
      .getByRole('button', { name: '从此处分叉', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toContainText('分页历史消息 0');
    await page.keyboard.press('Escape');
    await page.locator('.messages').evaluate((el) => {
      el.scrollTop = 300;
    });
    await expect
      .poll(() =>
        page.evaluate(
          (id) => JSON.parse(sessionStorage.getItem(`parallel_pi.conversation.${id}`) ?? '{}').top,
          source.id,
        ),
      )
      .toBe(300);
    await page.getByRole('button', { name: '← 返回全局地图', exact: true }).click();
    await global
      .locator(`[data-session="${source.id}"]`)
      .getByRole('button', { name: '进入会话 →', exact: true })
      .click();
    await expect(page.locator('.message')).toHaveCount(95);
    await expect.poll(() => page.locator('.messages').evaluate((el) => el.scrollTop)).toBe(300);
    expect(errors).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
