import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const versions = JSON.parse(readFileSync(new URL('./versions.json', import.meta.url)));
const cwd = `${root}vendor/pi`;
execFileSync('git', ['submodule', 'update', '--init', 'vendor/pi'], { cwd: root, stdio: 'inherit' });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
if (commit !== versions.pi.commit) throw Error(`Unexpected pi commit: ${commit}`);
execFileSync('git', ['diff', '--quiet', 'HEAD'], { cwd });
const archive = readFileSync(new URL('./fixtures/pi-model-data.json.gz', import.meta.url));
if (createHash('sha256').update(archive).digest('hex') !== versions.pi.modelDataSha256) throw Error('Model data checksum mismatch');
const target = `${cwd}/packages/ai/src/providers/data`;
mkdirSync(target, { recursive: true });
for (const [name, text] of Object.entries(JSON.parse(gunzipSync(archive)))) {
  if (!/^[.a-z0-9-]+\.json$/.test(name)) throw Error(`Unsafe model data filename: ${name}`);
  writeFileSync(`${target}/${name}`, text);
}
execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, stdio: 'inherit' });
execFileSync('npm', ['run', 'build:offline'], { cwd, stdio: 'inherit' });
