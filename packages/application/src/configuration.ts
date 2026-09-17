export interface ModelCatalog {
  list(): Promise<
    { provider: string; model: string; name: string; images: boolean; available: boolean }[]
  >;
  close(): Promise<void>;
}
/** Native configuration metadata only: credentials never enter application state or events. */
export interface ConfigurationView {
  settingsRevision: string;
  credentialsRevision: string;
  defaults: { provider?: string; model?: string };
  credentials: { provider: string; type: string }[];
}
export interface ProjectConfigurationView {
  directory: string;
  settingsRevision: string;
  trustRevision: string;
  defaults: { provider?: string; model?: string };
  globalDefaults: { provider?: string; model?: string };
  effective: { provider?: string; model?: string };
  trusted: boolean;
  trustSource: string;
  decisionSource: string;
  decision: boolean | null;
}
export interface ConnectionsView {
  revision: string;
  providers: {
    provider: string;
    baseUrl?: string;
    hiddenBaseUrl: boolean;
    api?: string;
    hasInlineCredential: boolean;
    models: { id: string; images: boolean }[];
  }[];
}
export interface ConnectionChange {
  provider: string;
  remove: boolean;
  baseUrl?: string;
  api?: string;
  model?: { id: string; images: boolean };
}
export interface ConfigurationAccess {
  project(directory: string): ProjectConfigurationView;
  projectDefaults(
    directory: string,
    revision: string,
    value: { provider: string; model: string } | null,
  ): void;
  trust(directory: string, revision: string, decision: boolean | null): void;
  connections(): Promise<ConnectionsView>;
  connection(revision: string, change: ConnectionChange): Promise<void>;
  read(): ConfigurationView;
  defaults(revision: string, value: { provider: string; model: string } | null): void;
  credential(revision: string, provider: string, key: string | null): void;
}
export function validateConfigurationRevision(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new Error('Reload configuration before saving');
}
export function validateDefaultModel(value: unknown): { provider: string; model: string } | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw new Error('Provider and model IDs are required');
  const { provider, model } = value as Record<string, unknown>;
  if (
    ![provider, model].every(
      (item) =>
        typeof item === 'string' &&
        item.length > 0 &&
        item.length <= 256 &&
        !/[\x00-\x20]/.test(item),
    )
  )
    throw new Error('Provider and model IDs are required');
  return { provider: provider as string, model: model as string };
}
export function createConfiguration(access: ConfigurationAccess, catalog?: ModelCatalog) {
  return {
    read: () => access.read(),
    connections: () => access.connections(),
    async updateConnection(input: unknown) {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Invalid connection request');
      const value = input as Record<string, unknown>;
      validateConfigurationRevision(value.revision);
      const identifier = (item: unknown): item is string =>
        typeof item === 'string' &&
        item.length > 0 &&
        item.length <= 256 &&
        !/[\x00-\x20\x7f]/.test(item);
      if (
        !identifier(value.provider) ||
        ['__proto__', 'constructor', 'prototype'].includes(value.provider)
      )
        throw new Error('Invalid provider ID');
      if (typeof value.remove !== 'boolean') throw new Error('Choose a connection operation');
      const change: ConnectionChange = { provider: value.provider, remove: value.remove };
      if (!change.remove) {
        if (value.baseUrl !== undefined) {
          if (
            typeof value.baseUrl !== 'string' ||
            value.baseUrl.length > 2048 ||
            /[\x00-\x20\x7f]/.test(value.baseUrl)
          )
            throw new Error(
              'Enter an HTTP or HTTPS base URL without credentials, query or fragment',
            );
          let url: URL;
          try {
            url = new URL(value.baseUrl);
          } catch {
            throw new Error('Enter a valid base URL');
          }
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            throw new Error(
              'Enter an HTTP or HTTPS base URL without credentials, query or fragment',
            );
          change.baseUrl = value.baseUrl;
        }
        if (value.api !== undefined) {
          if (
            !['openai-completions', 'openai-responses', 'anthropic-messages'].includes(
              value.api as string,
            )
          )
            throw new Error('Choose a supported API family');
          change.api = value.api as string;
        }
        if (value.model !== undefined) {
          if (!value.model || typeof value.model !== 'object' || Array.isArray(value.model))
            throw new Error('Invalid model');
          const model = value.model as Record<string, unknown>;
          if (!identifier(model.id) || typeof model.images !== 'boolean')
            throw new Error('Invalid model');
          change.model = { id: model.id, images: model.images };
        }
        if (!change.baseUrl && !change.api && !change.model)
          throw new Error('Enter a connection change');
      }
      await access.connection(value.revision, change);
      return access.connections();
    },
    models: () => {
      if (!catalog) throw new Error('Native models are unavailable');
      return catalog.list();
    },
    update(input: unknown) {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Invalid configuration request');
      const value = input as Record<string, unknown>;
      validateConfigurationRevision(value.revision);
      const identifier = (item: unknown): item is string =>
        typeof item === 'string' &&
        item.length > 0 &&
        item.length <= 256 &&
        !/[\x00-\x20]/.test(item);
      if (value.kind === 'defaults') {
        access.defaults(value.revision, validateDefaultModel(value.clear === true ? null : value));
      } else if (value.kind === 'credential') {
        if (
          !identifier(value.provider) ||
          ['__proto__', 'constructor', 'prototype'].includes(value.provider)
        )
          throw new Error('Invalid provider ID');
        if (
          value.key !== null &&
          (typeof value.key !== 'string' ||
            !value.key.trim() ||
            value.key.length > 16384 ||
            value.key.startsWith('!') ||
            /[\x00-\x1f\x7f]/.test(value.key))
        )
          throw new Error('Enter an API key; command expressions must be configured externally');
        access.credential(value.revision, value.provider, value.key as string | null);
      } else throw new Error('Unknown configuration operation');
      return access.read();
    },
  };
}
export type Configuration = ReturnType<typeof createConfiguration>;
