import { createGit } from './index.ts';
import { safeError } from './command.ts';
const git = createGit();
try {
  const { action, args } = JSON.parse(process.argv[2]!);
  let result;
  switch (action) {
    case 'identify':
      result = await git.identify(args[0]);
      break;
    case 'inspect':
      result = await git.inspect(args[0]);
      break;
    case 'validate':
      await git.validate(args[0]);
      result = null;
      break;
    case 'reconcileWorktree':
      result = await git.reconcileWorktree(args[0], args[1], args[2]);
      break;
    case 'checkBranchName':
      await git.checkBranchName(args[0], args[1]);
      result = null;
      break;
    case 'createBranch':
      await git.createBranch(args[0], args[1], args[2], undefined, args[3]);
      result = null;
      break;
    default:
      throw new Error('Unknown Git repository operation');
  }
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (cause) {
  process.stderr.write(
    safeError(cause instanceof Error ? cause.message : 'Git repository operation failed'),
  );
  process.exitCode = 1;
}
