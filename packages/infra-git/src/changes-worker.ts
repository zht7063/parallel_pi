import { inspectGitChanges } from './changes.ts';
import { safeError } from './command.ts';
try {
  process.stdout.write(JSON.stringify(await inspectGitChanges(process.cwd())));
} catch (cause) {
  process.stderr.write(safeError(cause instanceof Error ? cause.message : 'Git preview failed'));
  process.exitCode = 1;
}
