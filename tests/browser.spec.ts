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
