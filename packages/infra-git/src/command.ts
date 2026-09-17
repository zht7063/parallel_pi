import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const safeError = (value: string) =>
  value.replace(/(https?:\/\/)[^/\s@]+@/g, '$1<redacted>@');
export const pathLine = (value: string) => (value.endsWith('\n') ? value.slice(0, -1) : value);
export async function git(directory: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execute('git', ['--no-optional-locks', '-C', directory, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch (cause) {
    const error = cause as Error & { stderr?: string };
    throw new Error(safeError(error.stderr?.trim() || 'Git command failed'), { cause });
  }
}
