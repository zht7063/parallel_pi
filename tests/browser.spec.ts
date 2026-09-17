import { test, expect } from '@playwright/test';

test('local shell connects, retries with keyboard, and fits a narrow viewport', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('本地服务已连接');
  const retry = page.getByRole('button', { name: '重新连接' });
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('本地服务已连接');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(retry).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarColor),
  ).not.toBe('auto');
  await page.route('**/api/status', (route) => route.abort());
  await retry.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.unroute('**/api/status');
  await retry.click();
  await expect(page.getByRole('status')).toHaveText('本地服务已连接');
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/shell-narrow.png', fullPage: true });
});

test('real UI adds a dirty repository, executes images, preserves drafts, retries without duplication and resumes a stopped lane', async ({
  page,
}) => {
  test.setTimeout(90000);
  const { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'parallel-browser-repo-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'code'), 'committed');
  git('add', '.');
  git('commit', '-m', 'initial');
  git('branch', 'other');
  const remoteDirectory = join(root, 'remote.git');
  execFileSync('git', ['clone', '--bare', root, remoteDirectory], { stdio: 'pipe' });
  execFileSync('git', ['-C', remoteDirectory, 'update-ref', 'refs/heads/remote-only', 'HEAD'], {
    stdio: 'pipe',
  });
  git('remote', 'add', 'origin', remoteDirectory);
  git('fetch', 'origin');
  writeFileSync(join(root, 'code'), 'dirty');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('/');
    await expect(page.getByRole('status')).toHaveText('本地服务已连接');
    await page.getByRole('button', { name: '＋ 添加项目', exact: true }).click();
    await page.getByLabel('Git 项目目录').fill('/missing/repository');
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await expect(page.locator('#form-error')).not.toBeEmpty();
    await expect(page.getByLabel('Git 项目目录')).toHaveValue('/missing/repository');
    await page.getByLabel('Git 项目目录').fill(root);
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await expect(page.getByRole('heading', { name: '分支地图', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/map-desktop.png', fullPage: true });
    await page
      .getByRole('region', { name: 'main', exact: true })
      .getByRole('button', { name: '＋ 新建独立会话' })
      .click();
    await page.getByLabel('会话标题').fill('端到端会话');
    await page.getByLabel('Provider', { exact: true }).fill('parallel-probe');
    await page.getByLabel('模型 ID', { exact: true }).fill('probe-a');
    await page.getByRole('button', { name: '创建会话', exact: true }).click();
    await expect(page.getByRole('heading', { name: '端到端会话', exact: true })).toBeVisible();
    const composer = page.getByLabel('消息', { exact: true });
    await page
      .getByLabel('添加图片', { exact: true })
      .setInputFiles('probes/fixtures/red-square.png');
    await expect(page.getByRole('button', { name: '移除图片' })).toHaveCount(1);
    await composer.fill('浏览器图片验证');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.run-row strong').first()).toHaveText('执行完成', {
      timeout: 15000,
    });
    await expect(page.locator('.message.user img')).toHaveCount(1);
    await expect(page.locator('.message.user')).toContainText('浏览器图片验证');
    await composer.fill('刷新保留的草稿');
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const snapshot = await (await fetch('/api/snapshot')).json();
          return snapshot.drafts.at(-1)?.text;
        }),
      )
      .toBe('刷新保留的草稿');
    await page.reload();
    await expect(composer).toHaveValue('刷新保留的草稿');
    await expect(page.locator('.message.user')).toContainText('浏览器图片验证');
    let dropped = false;
    await page.route('**/api/command', async (route) => {
      const body = route.request().postDataJSON();
      if (!dropped && body.type === 'run.enqueue') {
        dropped = true;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    });
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('button', { name: '核对并重试发送' })).toBeVisible();
    await page.getByRole('button', { name: '核对并重试发送' }).click();
    await expect(page.locator('.run-row strong').first()).toHaveText('执行完成', {
      timeout: 15000,
    });
    await expect
      .poll(async () =>
        page.evaluate(async () => (await (await fetch('/api/snapshot')).json()).runs.length),
      )
      .toBe(2);
    await page.unroute('**/api/command');
    const previousRun = await page.evaluate(
      async () => (await (await fetch('/api/snapshot')).json()).runs.at(-1).id,
    );
    let delayedActivity = false;
    await page.route('**/api/activity?*', async (route) => {
      if (
        !delayedActivity &&
        new URL(route.request().url()).searchParams.get('runId') === previousRun
      ) {
        delayedActivity = true;
        return; // Hold an obsolete request until the client cancels it on run change.
      }
      await route.continue();
    });
    await composer.fill('probe-question-tool');
    await expect.poll(() => delayedActivity).toBe(true);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Continue probe tool?' })).toBeVisible({
      timeout: 15000,
    });
    await page.getByLabel('回答', { exact: true }).fill('continue');
    await page.getByRole('button', { name: '回复当前任务' }).click();
    await expect(page.locator('.run-row strong').first()).toHaveText('执行完成', {
      timeout: 15000,
    });
    await composer.fill('probe-slow-tool');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.tool-event')).toContainText(['bash'], { timeout: 15000 });
    await page.getByRole('button', { name: '查看地图', exact: true }).click();
    await expect(
      page
        .getByRole('region', { name: '浮层分支地图', exact: true })
        .getByRole('region', { name: 'main', exact: true })
        .locator('.lane-heading .status-chip'),
    ).toHaveText('执行中');
    await page.getByRole('button', { name: '关闭地图', exact: true }).click();

    await composer.fill('停止后恢复');
    await page.getByRole('button', { name: '加入队列', exact: true }).click();
    await page.getByRole('button', { name: '停止当前执行' }).click();
    await expect(page.getByRole('button', { name: '恢复未启动的队列' })).toBeVisible();
    await expect(page.locator('.run-row strong').first()).toHaveText('排队中');
    await expect(page.locator('.run-row').first()).toContainText('等待序列第 1 项');
    await expect(
      page.locator('.message').filter({ hasText: 'probe-slow-tool' }).first(),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.locator('.message').filter({ hasText: 'probe-slow-tool' }).first(),
    ).toBeVisible();
    await expect(page.locator('.run-row strong').first()).toHaveText('排队中');

    await page.getByRole('button', { name: '恢复未启动的队列' }).click();
    await expect(page.locator('.run-row strong').first()).toHaveText('执行完成', {
      timeout: 15000,
    });
    expect(readFileSync(join(root, 'code'), 'utf8')).toBe('dirty');
    expect(existsSync(join(root, 'late-write'))).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(composer).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'test-results/conversation-narrow.png', fullPage: true });
    const nativeDefaults = await (await page.request.get('/api/configuration')).json();
    expect(
      (
        await page.request.post('/api/configuration', {
          data: {
            kind: 'defaults',
            revision: nativeDefaults.settingsRevision,
            provider: 'parallel-probe',
            model: 'probe-b',
          },
        })
      ).ok(),
    ).toBe(true);
    const beforeContinue = await page.evaluate(
      async () => await (await fetch('/api/snapshot')).json(),
    );
    await page.getByRole('button', { name: '← 返回全局地图', exact: true }).click();
    await page
      .getByRole('region', { name: 'main', exact: true })
      .getByRole('button', { name: '新建接续会话', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toContainText('不复制聊天或自动运行');
    await page.getByLabel('会话标题').fill('接续探索');
    await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('probe-b');
    await page.getByRole('button', { name: '创建会话', exact: true }).click();
    await expect(page.getByRole('heading', { name: '接续探索', exact: true })).toBeVisible();
    await expect(composer).toHaveValue('');
    await expect(page.locator('.message')).toHaveCount(0);
    const afterContinue = await page.evaluate(
      async () => await (await fetch('/api/snapshot')).json(),
    );
    expect(afterContinue.runs).toHaveLength(beforeContinue.runs.length);
    expect(afterContinue.sessions.at(-1).origin).toEqual({
      kind: 'continue',
      sessionId: beforeContinue.sessions[0].id,
    });
    expect(afterContinue.sessions.at(-1).pathId).toBe(beforeContinue.sessions[0].pathId);
    await page.reload();
    await expect(page.getByRole('heading', { name: '接续探索', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '← 返回全局地图', exact: true }).click();
    await page.getByRole('button', { name: '新建 Git 分支', exact: true }).click();
    await page.getByLabel('本地分支名称').fill('bad name');
    await page.getByRole('button', { name: '创建本地分支', exact: true }).click();
    await expect(page.locator('#form-error')).not.toBeEmpty();
    await expect(page.getByLabel('本地分支名称')).toHaveValue('bad name');
    await page.getByLabel('本地分支名称').fill('browser-feature');
    await page.getByLabel('起点分支').selectOption('refs/heads/main');
    await page.getByRole('button', { name: '创建本地分支', exact: true }).click();
    await expect(page.getByRole('region', { name: 'browser-feature', exact: true })).toBeVisible();
    await page.locator('.remote-branches > summary').click();
    const remoteRow = page.locator('.remote-branch-row').filter({ hasText: 'origin/remote-only' });
    await remoteRow.getByRole('button', { name: '拉取到本地' }).click();
    await page.getByRole('button', { name: '创建本地分支', exact: true }).click();
    await expect(page.getByRole('region', { name: 'remote-only', exact: true })).toBeVisible();
    await expect(remoteRow).toHaveCount(0);
    expect(git('symbolic-ref', 'HEAD').toString().trim()).toBe('refs/heads/main');
    expect(readFileSync(join(root, 'code'), 'utf8')).toBe('dirty');
    await page
      .locator('.session-node')
      .filter({ has: page.getByRole('button', { name: '预览 端到端会话', exact: true }) })
      .getByRole('button', { name: '进入会话 →', exact: true })
      .click();
    const pointButton = page.getByRole('button', { name: '从此处分叉', exact: true }).first();
    await pointButton.click();
    await expect(page.getByRole('dialog')).toContainText('这条消息之前的历史');
    await expect(page.getByRole('dialog')).toContainText('浏览器图片验证');
    await expect(page.getByRole('dialog')).toContainText('包含 1 张图片');
    await page.keyboard.press('Escape');
    await expect(pointButton).toBeFocused();
    await pointButton.press('Enter');
    await page.getByLabel('分叉会话标题').fill('浏览器分叉');
    await page.screenshot({ path: 'test-results/fork-dialog-narrow.png', fullPage: true });
    await page.getByRole('button', { name: '创建分叉会话', exact: true }).click();
    await expect(page.getByRole('heading', { name: '浏览器分叉', exact: true })).toBeVisible();
    await expect(composer).toHaveValue('浏览器图片验证');
    await expect(page.getByRole('button', { name: '移除图片' })).toHaveCount(1);
    await expect(page.locator('.message')).toHaveCount(0);
    const forked = await page.evaluate(async () => await (await fetch('/api/snapshot')).json());
    expect(forked.runs).toHaveLength(beforeContinue.runs.length);
    expect(forked.sessions.at(-1).origin).toEqual({
      kind: 'fork',
      sessionId: beforeContinue.sessions[0].id,
      entryId: beforeContinue.sessions[0].messages[0].id,
    });
    await page.reload();
    await expect(composer).toHaveValue('浏览器图片验证');
    await expect(page.getByRole('button', { name: '移除图片' })).toHaveCount(1);
    expect(readFileSync(join(root, 'code'), 'utf8')).toBe('dirty');
    await page.getByRole('button', { name: '← 返回全局地图', exact: true }).click();
    await expect(page.locator('.session-edges .fork text')).toHaveText('分叉');
    await expect(page.locator('.session-edges .continue text')).toHaveText('接续');
    expect(errors).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('handoff storage failure keeps execution success visible and retries without another model run', async ({
  page,
}) => {
  test.setTimeout(45000);
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { createBackend } = await import('../apps/server/src/bootstrap.ts');
  const root = mkdtempSync(join(tmpdir(), 'parallel-browser-handoff-'));
  const directory = join(root, 'repository');
  mkdirSync(directory);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', directory, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(directory, 'code'), 'initial');
  git('add', '.');
  git('commit', '-m', 'initial');
  const backend = await createBackend({
    dataDirectory: join(root, 'data'),
    agentDirectory: join(root, 'agent'),
    engineArgs: [
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '-e',
      fileURLToPath(new URL('../probes/fixture-extension.mjs', import.meta.url)),
    ],
  });
  try {
    await new Promise<void>((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
    const address = backend.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local address');
    await backend.app.addProject(directory);
    const lane = backend.app.snapshot().state.lanes[0]!;
    await backend.app.createSession(lane.id, '交接保存恢复', {
      provider: 'parallel-probe',
      model: 'probe-a',
    });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole('button', { name: /交接保存恢复/ }).click();
    await page.getByRole('button', { name: '进入会话', exact: true }).click();
    writeFileSync(join(root, 'data', 'handoffs'), 'simulate inaccessible record directory');
    await page.getByLabel('消息', { exact: true }).fill('保存失败后仅重试记录');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const pending = page.getByRole('region', { name: '待保存的交接记录' });
    await expect(pending).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.run-row strong').first()).toHaveText('执行完成');
    await expect(page.getByRole('button', { name: '恢复未启动的队列' })).toHaveCount(0);
    await page.reload();
    await expect(pending).toBeVisible();
    await page.getByRole('button', { name: '重试保存交接' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '暂不保存，允许恢复队列' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: '暂不保存，允许恢复队列' })).toBeInViewport();
    await page.screenshot({ path: 'test-results/handoff-failure-narrow.png', fullPage: true });
    rmSync(join(root, 'data', 'handoffs'));
    await page.getByRole('button', { name: '重试保存交接' }).focus();
    await page.keyboard.press('Enter');
    await expect(pending).toHaveCount(0);
    await expect(page.locator('.run-row').first()).toContainText('交接记录：已保存');
    await page.getByRole('button', { name: '恢复未启动的队列' }).click();
    await expect.poll(() => backend.app.snapshot().state.lanes[0]!.state).toBe('ready');
    const save = await page.evaluate(async () => {
      const snapshot = await (await fetch('/api/snapshot')).json();
      const response = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'memory.save',
          requestId: 'browser-memory',
          sessionId: snapshot.sessions[0].id,
          runId: snapshot.runs[0].id,
          content: {
            type: 'knowledge',
            title: '浏览器记忆恢复',
            summary: '保存请求可以安全重试',
            body: '已核验同一保存请求不会重复添加原生记录。',
            candidate: false,
            scope: { paths: ['code'] },
          },
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    });
    expect(save.state).toBe('failed');
    const memoryPending = page.getByRole('region', { name: '待保存的长期记忆' });
    await expect(memoryPending).toBeVisible();
    await expect(page.getByRole('button', { name: '恢复未启动的队列' })).toHaveCount(0);
    await page.reload();
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/command') &&
          response.request().postDataJSON()?.type === 'memory.retry',
      ),
      page.getByRole('button', { name: '重试保存长期记忆' }).click(),
    ]);
    await expect(page.getByRole('button', { name: '重试保存长期记忆' })).toBeEnabled();
    await expect(memoryPending).toContainText('not connected');
    const cli = fileURLToPath(
      new URL('../probes/.cache/mwf-source/packages/mwf/dist/cli.js', import.meta.url),
    );
    execFileSync(process.execPath, [cli, 'init', '--root', directory, '--git-mode', 'ignore']);
    await page.getByRole('button', { name: '重试保存长期记忆' }).click();
    await expect(memoryPending).toHaveCount(0);
    await page.getByRole('button', { name: '恢复未启动的队列' }).click();
    expect(backend.app.snapshot().state.memorySaves[0]!.state).toBe('saved');
    expect(backend.app.snapshot().state.runs).toHaveLength(1);
    expect(
      backend.app
        .snapshot()
        .state.sessions[0]!.messages.filter((message) => message.role === 'user'),
    ).toHaveLength(1);
  } finally {
    await backend.close();
    rmSync(root, { recursive: true, force: true });
  }
});
