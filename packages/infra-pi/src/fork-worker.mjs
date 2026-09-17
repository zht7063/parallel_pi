import {
  readFileSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { SessionManager } from '../../../vendor/pi/packages/coding-agent/dist/core/session-manager.js';

// Fixed native SessionManager contract. No prompt, tools, checkout, or source mutation.
const [encoded, receiptPath, scratch] = process.argv.slice(2);
const input = JSON.parse(encoded);
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const sourceHeader = JSON.parse(readFileSync(input.sourceRef, 'utf8').split('\n')[0]);
if (
  sourceHeader.type !== 'session' ||
  sourceHeader.version !== 3 ||
  sourceHeader.cwd !== input.directory
)
  throw new Error('Fork source is incompatible with this workspace');
const manager = SessionManager.open(input.sourceRef, scratch);
const header = manager.getHeader();
if (header?.version !== 3 || header.cwd !== input.directory)
  throw new Error('Fork source is incompatible with this workspace');
const selected = manager.getEntry(input.entryId);
if (selected?.type !== 'message' || selected.message.role !== 'user')
  throw new Error('Fork requires a native user message');
const draft = selected.message.content;
if (selected.parentId) manager.createBranchedSession(selected.parentId);
else manager.newSession({ parentSession: input.sourceRef });
const nativeContent =
  [manager.getHeader(), ...manager.getEntries()].map((value) => JSON.stringify(value)).join('\n') +
  '\n';
// Native fork defers files without assistant messages. Capture its complete native
// snapshot durably so first-message forks need no synthetic assistant or model call.
const body = JSON.stringify({ version: 1, input, nativeContent, draft });
const temporary = join(dirname(receiptPath), `.${input.operationId}.tmp`);
const fd = openSync(temporary, 'wx', 0o600);
try {
  writeFileSync(fd, body);
  fsyncSync(fd);
} finally {
  closeSync(fd);
}
linkSync(temporary, receiptPath);
const directoryFd = openSync(dirname(receiptPath), 'r');
try {
  fsyncSync(directoryFd);
} finally {
  closeSync(directoryFd);
}
unlinkSync(temporary);
