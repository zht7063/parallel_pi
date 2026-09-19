#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkRuntime } from './runtime.mjs';

const help = `Usage: parallel-pi <command> [options]

Commands:
  serve       Run the core and Web UI in the foreground (127.0.0.1 only)
  doctor      Check runtime requirements without starting the service

Options:
  --port <number>        HTTP port (default: PARALLEL_PI_PORT or 4317)
  --data-dir <path>      Application data, separate from the installation
  --agent-dir <path>     Native pi configuration directory
  --help                Show this help
  --version             Show application version

Stop serve with Ctrl+C. Projects and tools run on this machine.
Existing PARALLEL_PI_* environment settings remain supported.
`;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      'data-dir': { type: 'string' },
      'agent-dir': { type: 'string' },
      help: { type: 'boolean' },
      version: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(help);
  } else if (values.version) {
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  } else {
    const [command] = positionals;
    if (positionals.length !== 1 || !['serve', 'doctor'].includes(command))
      throw new Error('Expected serve or doctor. Use --help for usage.');
    if (values.port !== undefined) {
      if (!/^\d+$/.test(values.port) || Number(values.port) > 65535)
        throw new Error('--port must be an integer between 0 and 65535');
      process.env.PARALLEL_PI_PORT = values.port;
    }
    for (const [option, variable] of [
      ['data-dir', 'PARALLEL_PI_DATA_DIR'],
      ['agent-dir', 'PARALLEL_PI_AGENT_DIR'],
    ]) {
      if (values[option] !== undefined) {
        if (!values[option].trim()) throw new Error(`--${option} must not be empty`);
        process.env[variable] = resolve(values[option]);
      }
    }
    checkRuntime();
    if (command === 'serve') await import('../apps/server/src/index.ts');
  }
} catch (error) {
  console.error(`parallel-pi: ${error.message}`);
  process.exitCode = 1;
}
