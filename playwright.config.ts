import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.ts',
  use: { baseURL: 'http://127.0.0.1:4318', headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: 'node apps/server/src/index.ts',
    env: { PARALLEL_PI_PORT: '4318' },
    url: 'http://127.0.0.1:4318',
    reuseExistingServer: false,
  },
});
