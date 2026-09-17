import { test, expect } from '@playwright/test';

test('native settings mask credentials, retain conflicts and guard unsaved edits in a narrow modal', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('本地服务已连接');
  await page.route('**/api/configuration', (route) => route.abort());
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await expect(dialog.locator('#settings-error')).not.toBeEmpty();
  await page.unroute('**/api/configuration');
  await dialog.getByRole('button', { name: '重新读取配置' }).click();
  await expect(dialog.getByLabel('默认 provider')).toBeVisible();
  await dialog.getByLabel('默认 provider').fill('parallel-probe');
  await dialog.getByLabel('默认模型 ID').fill('probe-a');
  await dialog.getByRole('button', { name: '保存全局默认模型' }).click();
  await expect(dialog.getByRole('status')).toContainText('已保存');
  await dialog.getByLabel('默认模型 ID').fill('probe-b');
  // A second authenticated client changes the same native file while this form is open.
  const current = await (await page.request.get('/api/configuration')).json();
  const changed = await page.request.post('/api/configuration', {
    data: {
      kind: 'defaults',
      revision: current.settingsRevision,
      provider: 'parallel-probe',
      model: 'external-choice',
    },
  });
  expect(changed.ok()).toBe(true);
  await dialog.getByRole('button', { name: '保存全局默认模型' }).click();
  await expect(dialog.locator('#settings-error')).toContainText('changed; reload');
  await expect(dialog.getByLabel('默认模型 ID')).toHaveValue('probe-b');
  await dialog.getByRole('button', { name: '重新读取配置' }).click();
  await expect(dialog.getByText('当前：parallel-probe / external-choice')).toBeVisible();
  await expect(dialog.getByLabel('默认模型 ID')).toHaveValue('probe-b');
  await dialog.getByRole('button', { name: '保存全局默认模型' }).click();
  await expect(dialog.getByRole('status')).toContainText('已保存');
  await dialog.getByRole('button', { name: '保存 API key' }).click();
  await expect(dialog.getByLabel('凭据 provider')).toBeFocused();
  await dialog.getByLabel('凭据 provider').fill('browser-fixture');
  await dialog.getByLabel('API key', { exact: true }).fill('fixture-private-browser-key');
  await expect(dialog.getByLabel('API key', { exact: true })).toHaveAttribute('type', 'password');
  await dialog.getByRole('button', { name: '显示密钥' }).click();
  await expect(dialog.getByLabel('API key', { exact: true })).toHaveAttribute('type', 'text');
  await dialog.getByRole('button', { name: '隐藏密钥' }).click();
  const external = await (await page.request.get('/api/configuration')).json();
  expect(
    (
      await page.request.post('/api/configuration', {
        data: {
          kind: 'defaults',
          revision: external.settingsRevision,
          provider: 'parallel-probe',
          model: 'probe-a',
        },
      })
    ).ok(),
  ).toBe(true);
  await page.route('**/api/configuration', (route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue(),
  );
  await dialog.getByRole('button', { name: '保存 API key' }).click();
  await expect(dialog.locator('#settings-error')).not.toBeEmpty();
  await expect(dialog.getByLabel('API key', { exact: true })).toHaveValue(
    'fixture-private-browser-key',
  );
  await page.unroute('**/api/configuration');
  await dialog.getByRole('button', { name: '保存 API key' }).click();
  await expect(dialog.getByRole('status')).toContainText('已保存');
  await expect(dialog.getByLabel('API key', { exact: true })).toHaveValue('');
  await expect(dialog.getByText('browser-fixture · api_key')).toBeVisible();
  // Saving auth must not silently accept an external settings revision.
  await dialog.getByRole('button', { name: '保存全局默认模型' }).click();
  await expect(dialog.locator('#settings-error')).toContainText('changed; reload');
  await dialog.getByRole('button', { name: '重新读取配置' }).click();
  await expect(dialog.getByLabel('默认模型 ID')).toHaveValue('probe-b');
  await dialog.getByRole('button', { name: '保存全局默认模型' }).click();
  await expect(dialog.getByRole('status')).toContainText('已保存');

  await dialog.getByRole('button', { name: '读取可用模型' }).click();
  await expect(dialog.getByLabel('原生可用模型')).toBeVisible();
  await dialog
    .getByLabel('原生可用模型')
    .selectOption({ label: 'browser-fixture / catalog-vision · 支持图片' });
  await expect(dialog.getByLabel('默认 provider')).toHaveValue('browser-fixture');
  await expect(dialog.getByLabel('默认模型 ID')).toHaveValue('catalog-vision');
  await dialog.getByLabel('默认 provider').fill('parallel-probe');
  await dialog.getByLabel('默认模型 ID').fill('probe-b');
  const metadata = await (await page.request.get('/api/configuration')).text();
  expect(metadata).not.toContain('fixture-private-browser-key');
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    ),
  ).not.toContain('fixture-private-browser-key');
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole('button', { name: '移除 browser-fixture 凭据' }).click();
  await expect(dialog.getByRole('group', { name: '确认移除凭据' })).toBeVisible();
  await dialog.getByRole('button', { name: '保留凭据' }).click();
  await dialog.getByLabel('API key', { exact: true }).fill('unsaved-private');
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('group', { name: '放弃未保存修改' })).toBeVisible();
  await dialog.getByRole('button', { name: '继续编辑' }).click();
  await expect(dialog.getByLabel('API key', { exact: true })).toHaveValue('unsaved-private');
  await dialog.getByLabel('API key', { exact: true }).fill('');
  await dialog.getByRole('button', { name: '移除 browser-fixture 凭据' }).click();
  await dialog.getByRole('button', { name: '确认移除凭据' }).click();
  await expect(dialog.getByText('browser-fixture · api_key')).toHaveCount(0);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await dialog.getByLabel('默认 provider').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/settings-narrow.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // The narrow sidebar is collapsed, so focus restoration is verified at desktop width.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(dialog.getByLabel('默认模型 ID')).toHaveValue('probe-b');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});
