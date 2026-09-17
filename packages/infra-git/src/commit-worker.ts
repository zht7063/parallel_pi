import { readFileSync } from 'node:fs';
import { commitGitFiles, recoverGitCommit } from './commit.ts';
const [action, jobDirectory, inputPath] = process.argv.slice(2);
try {
  if (!jobDirectory) throw new Error('Missing Git transaction directory');
  const result =
    action === 'recover'
      ? recoverGitCommit(jobDirectory)
      : await commitGitFiles(jobDirectory, JSON.parse(readFileSync(inputPath!, 'utf8')), (event) =>
          process.stdout.write(JSON.stringify({ type: 'hook', event }) + '\n'),
        );
  process.stdout.write(JSON.stringify({ type: 'result', result }) + '\n');
} catch (cause) {
  process.stderr.write(cause instanceof Error ? cause.message : 'Git transaction failed');
  process.exitCode = 1;
}
