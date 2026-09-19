// Build a self-contained package from the pinned, already-built native dependencies.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(process.argv[2] ?? 'dist/npm');
if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Unsupported build platform');
if (existsSync(destination)) throw new Error('Output directory must not exist');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const manifest = readJson(join(root, 'package.json'));
const versions = readJson(join(root, 'probes/versions.json'));
for (const [directory, expected] of [
  ['vendor/pi', versions.pi.commit],
  ['probes/.cache/mwf-source', versions.mwf.commit],
]) {
  const cwd = join(root, directory);
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim() !== expected)
    throw new Error(`Unexpected native revision: ${directory}`);
  execFileSync('git', ['diff', '--quiet', 'HEAD'], { cwd });
}
mkdirSync(destination, { recursive: true });
const modules = join(destination, 'node_modules');
const installed = new Map();
const dependencies = {};
const tracked = new Set(
  execFileSync('git', ['ls-files', '-z', 'packages', 'apps/server/src'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0'),
);

function findPackage(name, from) {
  for (let current = from; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(current) === current) throw new Error(`Missing dependency ${name} from ${from}`);
  }
}

function install(source, owner = destination) {
  source = realpathSync(source);
  const pkg = readJson(join(source, 'package.json'));
  let target = join(modules, pkg.name);
  // Respect the nearest installed dependency, including nested version overrides.
  for (let current = owner; ; current = dirname(current)) {
    const visible = join(current, 'node_modules', pkg.name);
    if (installed.has(visible)) {
      if (installed.get(visible) === source) return visible;
      target = join(owner, 'node_modules', pkg.name);
      break;
    }
    if (current === destination) break;
  }
  if (installed.has(target)) throw new Error(`Dependency collision: ${target}`);
  installed.set(target, source);
  mkdirSync(target, { recursive: true });
  if (
    source.startsWith(join(root, 'vendor/pi/packages') + sep) ||
    source.endsWith('/mwf-source/packages/mwf')
  ) {
    const [pack] = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: source,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
    for (const { path } of pack.files) {
      if (path.startsWith('node_modules/')) continue;
      mkdirSync(dirname(join(target, path)), { recursive: true });
      cpSync(join(source, path), join(target, path), { dereference: true });
    }
    // The fixed pi checkout has unbundled RPC builds; package exports may also name a bundle.
  } else {
    cpSync(source, target, {
      recursive: true,
      dereference: true,
      filter: (path) => {
        const parts = relative(source, path).split(sep);
        return !parts.some((part) => ['node_modules', '.git', '.env', '.npmrc'].includes(part));
      },
    });
  }
  // All install-time build work is performed before release, never on the user's machine.
  delete pkg.scripts;
  delete pkg.devDependencies;
  delete pkg.workspaces;
  const resolved = {};
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    let child;
    try {
      child = findPackage(name, source);
    } catch (error) {
      if (pkg.optionalDependencies?.[name]) continue;
      throw error;
    }
    install(child, target);
    resolved[name] = readJson(join(child, 'package.json')).version;
  }
  pkg.dependencies = resolved;
  delete pkg.optionalDependencies;
  writeFileSync(join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  if (target === join(modules, pkg.name)) dependencies[pkg.name] = pkg.version;
  return target;
}

install(join(root, 'vendor/pi/packages/coding-agent'));
install(join(root, 'probes/.cache/mwf-source/packages/mwf'));
install(findPackage('pi-mcp-adapter', root));

function rewrite(text, file) {
  return text.replace(/(['"])([^'"\n]+)\1/g, (literal, quote, value) => {
    let next = value;
    if (value.startsWith('@parallel-pi/')) {
      next = relative(dirname(file), join(root, 'packages', value.slice(13), 'src/index.js'))
        .split(sep)
        .join('/');
      if (!next.startsWith('.')) next = './' + next;
    }
    next = next.replace(
      'vendor/pi/packages/coding-agent/',
      'node_modules/@earendil-works/pi-coding-agent/',
    );
    next = next.replace('probes/.cache/mwf-source/packages/mwf/', 'node_modules/@zht7063/mwf/');
    if (next.startsWith('.') && next.endsWith('.ts')) next = next.slice(0, -3) + '.js';
    return quote + next + quote;
  });
}
function copySource(directory) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      copySource(path);
      continue;
    }
    if (!tracked.has(path.split(sep).join('/'))) continue;
    if (!/\.(ts|mjs|py)$/.test(path)) throw new Error(`Unclassified runtime resource: ${path}`);
    const source = join(root, path);
    const target = join(destination, path.replace(/\.ts$/, '.js'));
    mkdirSync(dirname(target), { recursive: true });
    let text = readFileSync(source, 'utf8');
    if (path.endsWith('.ts'))
      text = ts.transpileModule(text, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ESNext,
          verbatimModuleSyntax: true,
        },
      }).outputText;
    writeFileSync(target, path.endsWith('.py') ? text : rewrite(text, source));
  }
}
for (const name of readdirSync(join(root, 'packages'))) copySource(`packages/${name}/src`);
copySource('apps/server/src');
for (const name of ['cli.mjs', 'runtime.mjs', 'backup.py']) {
  mkdirSync(join(destination, 'scripts'), { recursive: true });
  const file = join(root, 'scripts', name);
  let text = readFileSync(file, 'utf8');
  if (name === 'runtime.mjs')
    text = text.replace(
      'node_modules/@parallel-pi/application/package.json',
      'packages/application/src/index.js',
    );
  writeFileSync(
    join(destination, 'scripts', name),
    name.endsWith('.py') ? text : rewrite(text, file),
    { mode: 0o755 },
  );
}
cpSync(join(root, 'apps/web/dist'), join(destination, 'apps/web/dist'), { recursive: true });
cpSync(join(root, 'docs/npm-delivery.md'), join(destination, 'README.md'));
writeFileSync(
  join(destination, 'package.json'),
  JSON.stringify(
    {
      name: manifest.name,
      private: true,
      version: manifest.version,
      description: 'Local agent service core with a Web UI',
      type: 'module',
      bin: manifest.bin,
      engines: manifest.engines,
      os: [process.platform],
      cpu: [process.arch],
      files: ['apps', 'packages', 'scripts', 'build-info.json'],
      dependencies,
      bundleDependencies: Object.keys(dependencies),
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  join(destination, 'build-info.json'),
  JSON.stringify(
    {
      format: 1,
      platform: process.platform,
      arch: process.arch,
      versions,
      dependencyLockSha256: createHash('sha256')
        .update(readFileSync(join(root, 'package-lock.json')))
        .digest('hex'),
      development: Boolean(
        execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
          cwd: root,
          encoding: 'utf8',
        }).trim(),
      ),
      applicationCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    },
    null,
    2,
  ) + '\n',
);
console.log(`Prepared npm candidate: ${destination}`);
