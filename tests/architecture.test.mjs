import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkArchitecture } from '../scripts/check-architecture.mjs';

test('architecture guard rejects reverse type imports, private entries, relative escapes and cycles', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-architecture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['domain', 'application']) {
    const directory = join(root, 'packages', name);
    mkdirSync(join(directory, 'src'), { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ exports: './src/index.ts', dependencies: {} }),
    );
  }
  writeFileSync(
    join(root, 'packages/domain/src/index.ts'),
    "import type { X } from '@parallel-pi/application';\nimport './other.ts';\n",
  );
  writeFileSync(
    join(root, 'packages/domain/src/other.ts'),
    "import './index.ts';\nimport fs from 'node:fs';\n",
  );
  writeFileSync(
    join(root, 'packages/application/src/index.ts'),
    "import type { X } from '@parallel-pi/domain/src/index.ts';\nimport '../../domain/src/index.ts';\n",
  );
  const errors = checkArchitecture(root).join('\n');
  assert.match(errors, /forbidden package or private entry @parallel-pi\/application/);
  assert.match(errors, /private entry @parallel-pi\/domain\/src/);
  assert.match(errors, /relative import escapes/);
  assert.match(errors, /platform dependency forbidden/);
  assert.match(errors, /Import cycle/);
  // Only infra-pi may bind this pinned native entry; other escapes stay forbidden.
  const native = join(root, 'vendor/pi/packages/coding-agent/dist/core');
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, 'session-manager.js'), 'export class SessionManager {}');
  const adapter = join(root, 'packages/infra-pi');
  mkdirSync(join(adapter, 'src'), { recursive: true });
  writeFileSync(join(adapter, 'package.json'), JSON.stringify({ exports: './src/index.ts' }));
  const nativeImport =
    "import { SessionManager } from '../../../vendor/pi/packages/coding-agent/dist/core/session-manager.js';";
  writeFileSync(join(adapter, 'src/index.ts'), nativeImport);
  assert.ok(!checkArchitecture(root).some((error) => error.startsWith('packages/infra-pi/')));
  writeFileSync(join(root, 'packages/application/src/native.ts'), nativeImport);
  assert.ok(
    checkArchitecture(root).some((error) =>
      error.includes('application/src/native.ts: relative import escapes'),
    ),
  );
});
