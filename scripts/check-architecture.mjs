import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const policy = {
  domain: [],
  contracts: [],
  application: ['domain'],
  transport: ['application', 'contracts'],
  web: ['contracts'],
  server: [
    'application',
    'transport',
    'infra-pi',
    'infra-git',
    'infra-storage',
    'infra-mwf',
    'infra-platform',
  ],
  'infra-pi': ['application', 'domain'],
  'infra-git': ['application', 'domain'],
  'infra-storage': ['application', 'domain'],
  'infra-mwf': ['application', 'domain'],
  'infra-platform': ['application', 'domain'],
};
const pure = new Set(['domain', 'application', 'contracts', 'web']);
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : /\.(?:[cm]?[jt]s|vue)$/.test(path) ? [path] : [];
  });
}

export function checkArchitecture(root) {
  const errors = [];
  const graph = new Map();
  const modules = [];
  for (const group of ['apps', 'packages']) {
    if (!existsSync(resolve(root, group))) continue;
    for (const entry of readdirSync(resolve(root, group))) {
      const directory = resolve(root, group, entry);
      if (!existsSync(resolve(directory, 'package.json'))) continue;
      const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
      modules.push({ name: entry, directory, manifest });
      if (!policy[entry]) errors.push(`Unknown architecture package: ${entry}`);
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        if (
          dependency.startsWith('@parallel-pi/') &&
          !policy[entry]?.includes(dependency.slice(13))
        )
          errors.push(`${entry}: forbidden dependency ${dependency}`);
      }
    }
  }
  for (const owner of modules) {
    const sourceRoot = resolve(owner.directory, 'src');
    if (!existsSync(sourceRoot)) continue;
    for (const file of walk(sourceRoot)) {
      const label = relative(root, file);
      const raw = readFileSync(file, 'utf8');
      const source = file.endsWith('.vue')
        ? [...raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
            .map((match) => match[1])
            .join('\n')
        : raw;
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const imports = [];
      function visit(node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
          imports.push(node.moduleSpecifier);
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
          imports.push(node.argument.literal);
        if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference) &&
          node.moduleReference.expression
        )
          imports.push(node.moduleReference.expression);
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        ) {
          if (node.arguments[0]) imports.push(node.arguments[0]);
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
      const edges = [];
      for (const specifier of imports) {
        if (!ts.isStringLiteralLike(specifier)) {
          errors.push(`${label}: computed imports are not allowed`);
          continue;
        }
        const name = specifier.text;
        if (name.startsWith('.')) {
          const target = resolve(dirname(file), name);
          // Pinned native boundary documented in docs/native-contracts.md.
          const nativeAdapterEntry =
            owner.name === 'infra-pi' &&
            [
              'core/session-manager.js',
              'core/auth-storage.js',
              'core/model-runtime.js',
              'core/model-config.js',
              'utils/json.js',
              'core/settings-manager.js',
              'core/trust-manager.js',
              'core/project-trust.js',
              'core/agent-session-services.js',
              'cli/args.js',
              'cli/project-trust.js',
              'config.js',
            ].some(
              (entry) => target === resolve(root, 'vendor/pi/packages/coding-agent/dist', entry),
            );
          if (!nativeAdapterEntry && !target.startsWith(sourceRoot + sep))
            errors.push(`${label}: relative import escapes package source: ${name}`);
          if (!existsSync(target)) errors.push(`${label}: unresolved import ${name}`);
          edges.push(target);
        } else if (name.startsWith('@parallel-pi/')) {
          const targetName = name.slice(13);
          const target = modules.find((module) => module.name === targetName);
          if (!target || !policy[owner.name]?.includes(targetName))
            errors.push(`${label}: forbidden package or private entry ${name}`);
          else {
            if (typeof target.manifest.exports !== 'string')
              errors.push(`${targetName}: expected one public entry`);
            else edges.push(resolve(target.directory, target.manifest.exports));
          }
          if (!owner.manifest.dependencies?.[name])
            errors.push(`${label}: undeclared dependency ${name}`);
        } else if (builtins.has(name.replace(/^node:/, ''))) {
          if (pure.has(owner.name)) errors.push(`${label}: platform dependency forbidden: ${name}`);
        } else {
          const dependency = name.startsWith('@')
            ? name.split('/').slice(0, 2).join('/')
            : name.split('/')[0];
          if (!owner.manifest.dependencies?.[dependency])
            errors.push(`${label}: undeclared external dependency ${name}`);
          if (['domain', 'application', 'contracts'].includes(owner.name))
            errors.push(`${label}: core package must stay platform independent: ${name}`);
        }
      }
      graph.set(file, edges);
    }
  }
  const done = new Set(),
    active = new Set();
  function visit(file, chain = []) {
    if (active.has(file)) {
      errors.push(
        `Import cycle: ${[...chain, file].map((path) => relative(root, path)).join(' → ')}`,
      );
      return;
    }
    if (done.has(file)) return;
    active.add(file);
    for (const target of graph.get(file) ?? []) visit(target, [...chain, file]);
    active.delete(file);
    done.add(file);
  }
  for (const file of graph.keys()) visit(file);
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkArchitecture(process.cwd());
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else
    console.log('Architecture: dependency directions, public entries and import cycles checked');
}
