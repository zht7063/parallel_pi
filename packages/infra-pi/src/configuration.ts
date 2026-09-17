import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { FileAuthStorageBackend } from '../../../vendor/pi/packages/coding-agent/dist/core/auth-storage.js';
import { getAgentDir } from '../../../vendor/pi/packages/coding-agent/dist/config.js';
import type { ConfigurationAccess } from '@parallel-pi/application';

function object(text: string): Record<string, unknown> {
  // Never propagate JSON parser snippets: native files may contain credentials.
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* Preserve the original bytes and return a safe diagnostic below. */
  }
  throw new Error('Native configuration is invalid; repair the original file before saving');
}
function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '{}';
    throw new Error('Cannot read native configuration');
  }
}
export function createConfigurationAccess(agentDirectory = getAgentDir()): ConfigurationAccess {
  agentDirectory = resolve(agentDirectory);
  const settings = join(agentDirectory, 'settings.json');
  const auth = join(agentDirectory, 'auth.json');
  const trustPath = join(agentDirectory, 'trust.json');
  // Opaque, process-local revisions do not expose hashes of potentially weak secrets.
  // Restart deliberately invalidates an open edit form.
  const salt = randomBytes(32);
  const revision = (path: string, text: string) =>
    createHmac('sha256', salt).update(path).update('\0').update(text).digest('hex');
  function update(
    path: string,
    expected: string,
    change: (value: Record<string, unknown>) => void,
  ) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        writeFileSync(path, '{}', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      // Exclusive creation above avoids the native backend's exists/write creation race.
      // This native backend acquires the same proper-lockfile lock BEFORE reading,
      // including first creation. FileSettingsStorage reads a missing file before locking.
      new FileAuthStorageBackend(path).withLock((current) => {
        const text = current ?? '{}';
        if (revision(path, text) !== expected)
          throw new Error('Configuration changed; reload and compare before saving');
        const value = object(text);
        change(value);
        return { result: undefined, next: JSON.stringify(value, null, 2) + '\n' };
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /^(Configuration changed;|Native configuration is invalid;)/.test(error.message)
      )
        throw error;
      throw new Error('Cannot save native configuration; the file may be locked or unwritable');
    }
  }
  const defaultsOf = (value: Record<string, unknown>) => ({
    ...(typeof value.defaultProvider === 'string' ? { provider: value.defaultProvider } : {}),
    ...(typeof value.defaultModel === 'string' ? { model: value.defaultModel } : {}),
  });
  function changeDefaults(
    value: Record<string, unknown>,
    model: { provider: string; model: string } | null,
  ) {
    if (model) {
      value.defaultProvider = model.provider;
      value.defaultModel = model.model;
    } else {
      delete value.defaultProvider;
      delete value.defaultModel;
    }
  }
  function trustFile(text: string) {
    const value = object(text);
    if (Object.values(value).some((item) => item !== true && item !== false && item !== null))
      throw new Error('Native configuration is invalid; repair the trust file before saving');
    return value;
  }
  return {
    project(directory) {
      const canonical = realpathSync(directory);
      const path = join(canonical, '.pi/settings.json');
      const projectText = read(path),
        global = object(read(settings)),
        trustText = read(trustPath);
      const local = defaultsOf(object(projectText)),
        globalDefaults = defaultsOf(global),
        trust = trustFile(trustText);
      let ancestor = canonical;
      let decision: boolean | null = null,
        trustSource = 'global';
      while (true) {
        if (typeof trust[ancestor] === 'boolean') {
          decision = trust[ancestor] as boolean;
          trustSource = ancestor;
          break;
        }
        if (dirname(ancestor) === ancestor) break;
        ancestor = dirname(ancestor);
      }
      // Stored policy only. The application replaces this preview with the
      // actual supervised native resolver result, including global trust hooks.
      const trusted = decision ?? global.defaultProjectTrust === 'always';
      return {
        directory: canonical,
        settingsRevision: revision(path, projectText),
        trustRevision: revision(trustPath, trustText),
        defaults: local,
        globalDefaults,
        effective: trusted ? { ...globalDefaults, ...local } : globalDefaults,
        trusted,
        trustSource,
        decisionSource: trustSource,
        decision,
      };
    },
    projectDefaults(directory, expected, value) {
      update(join(realpathSync(directory), '.pi/settings.json'), expected, (settings) =>
        changeDefaults(settings, value),
      );
    },
    trust(directory, expected, decision) {
      const canonical = realpathSync(directory);
      update(trustPath, expected, (value) => {
        trustFile(JSON.stringify(value));
        if (decision === null) delete value[canonical];
        else value[canonical] = decision;
      });
    },
    read() {
      const settingsText = read(settings),
        authText = read(auth);
      const value = object(settingsText),
        credentials = object(authText);
      return {
        settingsRevision: revision(settings, settingsText),
        credentialsRevision: revision(auth, authText),
        defaults: {
          ...(typeof value.defaultProvider === 'string' ? { provider: value.defaultProvider } : {}),
          ...(typeof value.defaultModel === 'string' ? { model: value.defaultModel } : {}),
        },
        credentials: Object.entries(credentials).map(([provider, credential]) => ({
          provider,
          type:
            credential &&
            typeof credential === 'object' &&
            'type' in credential &&
            (credential.type === 'api_key' || credential.type === 'oauth')
              ? credential.type
              : 'unknown',
        })),
      };
    },
    defaults(expected, value) {
      update(settings, expected, (settings) => changeDefaults(settings, value));
    },
    credential(expected, provider, key) {
      update(auth, expected, (credentials) => {
        if (key === null) delete credentials[provider];
        else
          Object.defineProperty(credentials, provider, {
            value: { type: 'api_key', key },
            enumerable: true,
            configurable: true,
            writable: true,
          });
      });
    },
  };
}
