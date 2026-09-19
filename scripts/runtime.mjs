import { readFileSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
export function checkRuntime() {
  if (!['linux', 'darwin'].includes(process.platform))
    throw new Error('The backend requires Linux or macOS');
  const required = json('package.json').engines.node;
  if (process.versions.node !== required) throw new Error(`Node.js ${required} is required`);
  const git = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
  const version = git.match(/(\d+)\.(\d+)/);
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 43))
    throw new Error('Git 2.43 or newer is required');
  execFileSync(
    'python3',
    [
      '-c',
      `
import ctypes, os, sqlite3, sys
if sys.version_info < (3, 11): raise RuntimeError('Python 3.11 or newer is required')
if sys.platform == 'linux':
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0: raise RuntimeError('Linux subreaper unavailable')
    os.close(os.pidfd_open(os.getpid()))
else:
    import subprocess
    lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
    for symbol in ('proc_pidinfo', 'proc_listpids', 'coalition_info_resource_usage', '__proc_info'):
        getattr(lib, symbol)
    subprocess.run(['/bin/launchctl', 'print', f'gui/{os.getuid()}'], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'], check=True, stdout=subprocess.DEVNULL)
`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  for (const path of [
    'apps/web/dist/index.html',
    'vendor/pi/packages/coding-agent/dist/rpc-entry.js',
    'probes/.cache/mwf-source/packages/mwf/dist/cli.js',
    'node_modules/@parallel-pi/application/package.json',
  ])
    if (!existsSync(join(root, path))) throw new Error(`Missing build dependency: ${path}`);
  let build = 'source checkout';
  if (existsSync(join(root, 'build-info.json'))) {
    const info = json('build-info.json');
    if (info.format !== 1 || info.platform !== process.platform || info.arch !== process.arch)
      throw new Error('Installed package platform/architecture mismatch');
    build = `${info.applicationCommit}${info.development ? ' (development)' : ''}`;
  }
  if (existsSync(join(root, 'runtime-manifest.json'))) {
    const manifest = json('runtime-manifest.json');
    if (
      manifest.format !== 1 ||
      manifest.platform !== process.platform ||
      manifest.arch !== process.arch
    )
      throw new Error(
        'Runtime bundle platform/architecture mismatch; build inside the target platform environment',
      );
    for (const [path, expected] of Object.entries(manifest.files)) {
      const file = join(root, path);
      const stat = lstatSync(file);
      const actual = stat.isSymbolicLink()
        ? { link: readlinkSync(file) }
        : { sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Runtime integrity mismatch: ${path}`);
    }
    build = `${manifest.applicationCommit}${manifest.development ? ' (development)' : ''}`;
  }
  console.log(
    `Runtime ready: ${process.platform}/${process.arch}, Node ${required}, ${git}, build ${build}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check'))
      throw new Error('Usage: node scripts/runtime.mjs [--check]');
    checkRuntime();
    if (!process.argv[2]) await import('../apps/server/src/index.ts');
  } catch (error) {
    console.error(`Startup refused: ${error.message}`);
    process.exitCode = 1;
  }
}
