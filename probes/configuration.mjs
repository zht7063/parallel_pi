// V03 experiment: wrap the existing native settings storage lock with a revision check.
import { createHash } from 'node:crypto';
import { FileSettingsStorage, SettingsManager } from '../vendor/pi/packages/coding-agent/dist/core/settings-manager.js';
export const revision = text => createHash('sha256').update(text ?? '').digest('hex');
export function updateSettings(cwd, agentDir, scope, expectedRevision, update) {
  const storage = new FileSettingsStorage(cwd, agentDir);
  storage.withLock(scope, current => {
    if (revision(current) !== expectedRevision) throw Error('Configuration revision conflict');
    const value = JSON.parse(current ?? '{}');
    update(value);
    return JSON.stringify(value, null, 2);
  });
  return SettingsManager.create(cwd, agentDir);
}
