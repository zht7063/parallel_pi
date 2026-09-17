import { createGit } from './index.ts';
import { readFileSync } from 'node:fs';
import { commitGitFiles, recoverGitCommit, previewGitCommit, reviewGitCommit } from './commit.ts';
const [action, jobDirectory, inputPath] = process.argv.slice(2);
try {
  if (!jobDirectory) throw new Error('Missing Git transaction directory');
  const input = inputPath ? JSON.parse(readFileSync(inputPath, 'utf8')) : null;
  if (input?.binding) {
    const facts = await createGit().inspect(input.directory);
    if (
      facts.directory !== input.directory ||
      facts.repository !== input.binding.repository ||
      facts.ref !== input.binding.ref
    )
      throw new Error('Git workspace binding changed; inspect it before reconciling this commit');
  }
  const result =
    action === 'review'
      ? reviewGitCommit(jobDirectory)
      : action === 'preview'
        ? await (async () => {
            const input = JSON.parse(readFileSync(inputPath!, 'utf8'));
            return previewGitCommit(input.directory, input.revision, input.paths);
          })()
        : action === 'recover'
          ? recoverGitCommit(jobDirectory)
          : await commitGitFiles(jobDirectory, input, (event) =>
              process.stdout.write(JSON.stringify({ type: 'hook', event }) + '\n'),
            );
  process.stdout.write(JSON.stringify({ type: 'result', result }) + '\n');
} catch (cause) {
  process.stderr.write(cause instanceof Error ? cause.message : 'Git transaction failed');
  process.exitCode = 1;
}
