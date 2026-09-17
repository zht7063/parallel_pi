import { test, expect } from '@playwright/test';

test('custom connections preserve draft conflicts, reach the native catalog and confirm removal', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('本地服务已连接');
  await page.route('**/api/connections', (route) => route.abort());
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  const panel = dialog.getByRole('region', { name: '自定义 Provider 连接' });
  await expect(panel.locator('#connections-error')).not.toBeEmpty();
  await page.unroute('**/api/connections');
  await panel.getByRole('button', { name: '重新读取连接' }).click();
  await panel.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(panel.getByLabel('连接 provider ID')).toBeFocused();
  await panel.getByLabel('连接 provider ID').fill('browser-custom');
  await panel.getByLabel('服务地址（Base URL）').fill('http://127.0.0.1:9/v1');
  await panel.getByLabel('添加或更新模型 ID').fill('new-vision');
  await panel.getByLabel('此模型支持图片输入').check();
  await panel.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(
    panel.getByText('连接已保存。可重新读取可用模型；此操作未测试网络连接。'),
  ).toBeVisible();
  await expect(panel.getByLabel('编辑连接')).toHaveValue('browser-custom');
  await dialog.getByRole('button', { name: '读取可用模型' }).click();
  await expect(
    dialog
      .getByLabel('原生可用模型')
      .locator('option', { hasText: 'browser-custom / new-vision · 支持图片' }),
  ).toHaveCount(1);
  await panel.getByLabel('服务地址（Base URL）').fill('http://127.0.0.1:9/mine');
  const current = await (await page.request.get('/api/connections')).json();
  const changed = await page.request.post('/api/connections', {
    data: {
      revision: current.revision,
      provider: 'browser-custom',
      remove: false,
      baseUrl: 'http://127.0.0.1:9/external',
    },
  });
  expect(changed.ok()).toBe(true);
  await panel.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(panel.locator('#connections-error')).toContainText('changed; reload');
  await expect(panel.getByLabel('服务地址（Base URL）')).toHaveValue('http://127.0.0.1:9/mine');
  await panel.getByRole('button', { name: '重新读取连接' }).click();
  await expect(panel.getByText(/当前地址：http:\/\/127.0.0.1:9\/external/)).toBeVisible();
  await expect(panel.getByLabel('服务地址（Base URL）')).toHaveValue('http://127.0.0.1:9/mine');
  await page.route('**/api/connections', (route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue(),
  );
  await panel.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(panel.locator('#connections-error')).not.toBeEmpty();
  await page.unroute('**/api/connections');
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('group', { name: '放弃未保存修改' })).toBeVisible();
  await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
  await panel.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(panel.getByLabel('编辑连接')).toBeEnabled();
  await panel.getByLabel('读取已有模型到表单').selectOption('new-vision');
  await expect(panel.getByLabel('此模型支持图片输入')).toBeChecked();
  await panel.getByLabel('此模型支持图片输入').uncheck();
  await panel.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(panel.getByLabel('读取已有模型到表单')).toHaveValue('');
  const saved = await (await page.request.get('/api/connections')).json();
  expect(
    saved.providers.find((item: { provider: string }) => item.provider === 'browser-custom').models,
  ).toEqual([{ id: 'new-vision', images: false }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole('button', { name: '移除此自定义连接' }).click();
  await expect(panel.getByRole('group', { name: '确认移除连接' })).toBeVisible();
  await panel.getByRole('button', { name: '保留连接' }).click();
  await panel.getByLabel('服务地址（Base URL）').scrollIntoViewIfNeeded();
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/connections-narrow.png', fullPage: true });
  await panel.getByRole('button', { name: '移除此自定义连接' }).click();
  await panel.getByRole('button', { name: '确认移除连接' }).click();
  await expect(
    panel.getByLabel('编辑连接').locator('option', { hasText: 'browser-custom' }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});
