import {
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  readFileSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { HandoffStore } from '@parallel-pi/application';

/** Immutable run records in private application storage, outside the project's MWF tree. */
export function createHandoffStore(directory: string): HandoffStore {
  function syncDirectory() {
    const fd = openSync(directory, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  return {
    put(content) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(content.runId)) throw new Error('Invalid run ID');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const target = join(directory, `${content.runId}.json`);
      const body = JSON.stringify(content, null, 2) + '\n';
      try {
        const existing = readFileSync(target, 'utf8');
        if (existing !== body)
          throw new Error(
            'Run handoff differs from the pending save; preserve both for inspection',
          );
        // A prior process may have crashed after linking but before syncing the directory.
        const fd = openSync(target, 'r');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        syncDirectory();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const temp = join(directory, `.${content.runId}-${randomUUID()}.tmp`);
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(fd, body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        // Atomic no-replace publication: a conflicting destination is never overwritten.
        linkSync(temp, target);
        syncDirectory();
      } finally {
        unlinkSync(temp);
      }
    },
  };
}
