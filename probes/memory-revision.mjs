// Fixed-version experiment: public CLI lacks compare-and-set, so reuse native
// storage internals and the same lock as CLI/MCP. This seam needs upgrade tests.
import { schemas, operate } from './.cache/mwf-source/packages/mwf/dist/core.js';
import { canonicalRoot, withProjectLock, recover, Transaction, hash } from './.cache/mwf-source/packages/mwf/dist/storage.js';
import { records } from './.cache/mwf-source/packages/mwf/dist/protocol.js';

export function updateMemory(input, expectedRevision, beforeCommit = () => {}) {
  if (input.request_id) throw Error('Revision update retries require application reconciliation, not a native request receipt');
  const args = schemas.update.parse({ ...input, apply: true });
  const root = canonicalRoot(args.project_root);
  return withProjectLock(root, () => {
    recover(root);
    const tx = new Transaction(root);
    const record = records(tx).find(r => r.metadata.id === args.id);
    if (!record) throw Error('Memory record not found');
    if (hash(tx.get(record.path)) !== expectedRevision) throw Error('Memory revision conflict');
    const result = operate(tx, 'update', args);
    beforeCommit();
    tx.commit();
    return result;
  });
}
