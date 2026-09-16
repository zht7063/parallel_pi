import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const versions = JSON.parse(readFileSync(new URL('./versions.json', import.meta.url)));
const target = `${root}probes/.cache/mwf-source`;
mkdirSync(`${root}probes/.cache`, { recursive: true });
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });
if (!existsSync(target)) run('git', ['clone', '--no-checkout', versions.mwf.repository, target]);
run('git', ['checkout', '--detach', versions.mwf.commit], target);
run('git', ['diff', '--quiet', 'HEAD'], target);
run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], `${target}/packages/mwf`);
run('npm', ['run', 'build'], `${target}/packages/mwf`);
