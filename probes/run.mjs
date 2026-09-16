import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['v01.test.mjs', 'v01-upgrade.test.mjs', 'v02.test.mjs', 'v03.test.mjs', 'v04.test.mjs', 'v04-adapter.test.mjs', 'v04-jobs.test.mjs'];
const evidenceFiles = [
  'package.json', 'package-lock.json',
  ...readdirSync(join(root, 'probes')).filter(f => f.endsWith('.mjs') || f === 'versions.json').map(f => `probes/${f}`),
  ...readdirSync(join(root, 'probes/fixtures')).map(f => `probes/fixtures/${f}`),
];
const sourceHashes = () => Object.fromEntries(evidenceFiles.map(file => [file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex')]));
const beforeHashes = sourceHashes();
const started = new Date().toISOString();
const command = ['--test', '--test-reporter=tap', ...files.map(f => `probes/${f}`)];
const result = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
const unchanged = JSON.stringify(beforeHashes) === JSON.stringify(sourceHashes());
const output = (result.stdout ?? '') + (result.stderr ?? '');
process.stdout.write(output);
const destination = join(root, 'probes/results/local', process.platform);
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(`${destination}.tap`, output);
writeFileSync(`${destination}.json`, JSON.stringify({
  started, finished: new Date().toISOString(), platform: process.platform, arch: process.arch,
  node: process.version, command: [process.execPath, ...command],
  piCommit: execFileSync('git', ['-C', 'vendor/pi', 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  status: !unchanged ? 'source-changed-during-run' : (result.status === 0 ? 'passed' : 'failed'), exitCode: result.status, signal: result.signal,
  ...(result.error ? { error: result.error.message } : {}),
  sourceHashes: beforeHashes,
  excluded: ['real provider (run probe:live explicitly)', 'platforms other than the recorded platform'],
}, null, 2) + '\n');
process.exitCode = unchanged ? (result.status ?? 1) : 1;
