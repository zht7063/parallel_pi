import { concurrency, DEFAULT_CONCURRENCY } from '@parallel-pi/domain';

export function createApplication(options: { concurrency?: number } = {}) {
  const limit = concurrency(options.concurrency ?? DEFAULT_CONCURRENCY);
  return {
    status() {
      return { concurrency: limit };
    },
  };
}
export type Application = ReturnType<typeof createApplication>;
