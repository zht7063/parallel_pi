import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  config,
  operate,
  schemas,
} from '../../../probes/.cache/mwf-source/packages/mwf/dist/core.js';
import {
  canonicalRoot,
  hash,
  MWFError,
  recover,
  Transaction,
  withProjectLock,
} from '../../../probes/.cache/mwf-source/packages/mwf/dist/storage.js';
import {
  boundaries,
  requireSafe,
  TYPES,
  validRecords,
} from '../../../probes/.cache/mwf-source/packages/mwf/dist/protocol.js';

function inspect(tx, input) {
  const settings = config(tx, false);
  if (settings.schema_version === undefined)
    return { initialized: false, gitMode: null, records: [], total: 0, record: null };
  // The native read checks schema/runtime applicability without constructing a second index.
  operate(tx, 'status', schemas.status.parse({ project_root: tx.root }));
  if (settings.schema_version !== 1)
    throw new MWFError('MIGRATION_REQUIRED', 'Explicit migration required');
  if (!['track', 'ignore'].includes(settings.git_mode))
    throw new MWFError('INVALID_CONFIG', 'Invalid existing Git mode');
  const all = validRecords(tx);
  let selected = all;
  let matches;
  if (input.query !== undefined) {
    matches = operate(
      tx,
      'recall',
      schemas.recall.parse({ project_root: tx.root, ...input.query, limit: 100 }),
    );
    const byId = new Map(all.map((record) => [record.metadata.id, record]));
    selected = matches.map((match) => byId.get(match.id));
  }
  const metadata = (record) => ({
    id: record.metadata.id,
    type: record.metadata.type,
    status: record.metadata.status,
    title: record.title,
    summary: record.metadata.summary,
    scope: record.metadata.scope,
    path: record.path,
    revision: hash(tx.get(record.path)),
    statuses: TYPES[record.metadata.type].statuses,
    reasons: matches?.find((match) => match.id === record.metadata.id)?.reasons ?? [],
  });
  const record = input.recordId
    ? all.find((record) => record.metadata.id === input.recordId)
    : null;
  if (input.recordId && !record) throw new MWFError('NOT_FOUND', 'Memory record not found');
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new MWFError('INVALID_INPUT', 'Invalid offset');
  const result = {
    initialized: true,
    gitMode: settings.git_mode,
    records: selected.slice(offset, offset + 20).map(metadata),
    total: selected.length,
    record: record
      ? {
          ...metadata(record),
          body: record.body.startsWith(`# ${record.title}\n`)
            ? record.body.slice(record.title.length + 3).trimStart()
            : record.body,
          boundaries: boundaries(record),
        }
      : null,
  };
  requireSafe(JSON.stringify(result));
  return result;
}
function modify(tx, input) {
  const change = input.change;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId))
    throw new MWFError('INVALID_INPUT', 'Invalid request ID');
  let args;
  if (change.kind === 'init')
    args = schemas.init.parse({ project_root: tx.root, git_mode: change.gitMode });
  else if (change.kind === 'update') {
    if (!/^[a-f0-9]{64}$/.test(change.revision))
      throw new MWFError('INVALID_INPUT', 'Invalid revision');
    args = schemas.update.parse({
      project_root: tx.root,
      id: change.id,
      status: change.status,
      summary: change.summary,
      body: change.body,
      scope: change.scope,
      apply: true,
    });
  } else throw new MWFError('INVALID_INPUT', 'Invalid memory operation');
  const fingerprint = hash(JSON.stringify({ kind: change.kind, args, revision: change.revision }));
  const receiptPath = `.mwf/local/parallel-pi/${input.requestId}.json`;
  const previous = tx.get(receiptPath);
  if (previous) {
    const receipt = JSON.parse(previous);
    if (receipt.fingerprint !== fingerprint)
      throw new MWFError('IDEMPOTENCY_CONFLICT', 'Request content differs');
    return { ...receipt.result, replayed: true };
  }
  let result;
  if (change.kind === 'init') {
    const existing = config(tx, false);
    if (existing.git_mode !== undefined && !['track', 'ignore'].includes(existing.git_mode))
      throw new MWFError('INVALID_CONFIG', 'Invalid existing Git mode');
    // Initialization is explicit, but never changes an existing project's policy.
    operate(tx, 'init', {
      ...args,
      git_mode: existing.git_mode ?? args.git_mode,
      language: existing.language ?? args.language,
    });
    result = { kind: 'init', gitMode: config(tx).git_mode, replayed: false };
  } else {
    const record = validRecords(tx).find((record) => record.metadata.id === change.id);
    if (!record) throw new MWFError('NOT_FOUND', 'Memory record not found');
    if (hash(tx.get(record.path)) !== change.revision)
      throw new MWFError('REVISION_CONFLICT', 'Memory changed; reload before saving');
    const updated = operate(tx, 'update', args);
    result = {
      kind: 'update',
      id: updated.id,
      path: updated.path,
      revision: hash(tx.get(updated.path)),
      replayed: false,
    };
  }
  // The receipt and native record/index changes share the same recoverable file
  // transaction. A retry observes the receipt before comparing an old revision.
  tx.set(receiptPath, JSON.stringify({ fingerprint, result }) + '\n');
  tx.commit();
  return result;
}
try {
  const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const root = canonicalRoot(input.directory);
  config(new Transaction(root), false);
  const run = () => {
    recover(root);
    const tx = new Transaction(root);
    if (input.kind === 'inspect') return inspect(tx, input);
    if (input.kind === 'modify') return modify(tx, input);
    throw new MWFError('INVALID_INPUT', 'Invalid memory operation');
  };
  const result =
    input.kind === 'inspect' && !existsSync(join(root, '.mwf'))
      ? inspect(new Transaction(root), input)
      : withProjectLock(root, run);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  const code = error instanceof MWFError ? error.code : 'MEMORY_FAILED';
  const message =
    code === 'REVISION_CONFLICT'
      ? 'Memory changed; reload and compare before saving'
      : `MWF operation failed (${code}); existing content is preserved or recoverable`;
  process.stderr.write(JSON.stringify({ error: { code, message } }));
  process.exitCode = 1;
}
