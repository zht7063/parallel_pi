// Use the same pinned startup services and trust resolver as pi's RPC entry.
// A branch maintenance operation supervises this process: global trust hooks
// and trusted project extensions may execute code while resources are loaded.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from '../../../vendor/pi/packages/coding-agent/dist/cli/args.js';
import { createProjectTrustContext } from '../../../vendor/pi/packages/coding-agent/dist/cli/project-trust.js';
import { SettingsManager } from '../../../vendor/pi/packages/coding-agent/dist/core/settings-manager.js';
import {
  ProjectTrustStore,
  hasTrustRequiringProjectResources,
} from '../../../vendor/pi/packages/coding-agent/dist/core/trust-manager.js';
import { resolveProjectTrusted } from '../../../vendor/pi/packages/coding-agent/dist/core/project-trust.js';
import { createAgentSessionServices } from '../../../vendor/pi/packages/coding-agent/dist/core/agent-session-services.js';
try {
  const [cwd, agentDir, output, args] = process.argv.slice(2);
  const parsed = parseArgs(JSON.parse(args));
  const trustStore = new ProjectTrustStore(agentDir);
  const requiresTrust = hasTrustRequiringProjectResources(cwd);
  const shouldResolve = parsed.projectTrustOverride === undefined && requiresTrust;
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: shouldResolve
      ? false
      : (parsed.projectTrustOverride ?? (!requiresTrust || trustStore.get(cwd) === true)),
  });
  const paths = (values) => (values ?? []).map((path) => resolve(cwd, path));
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    modelRuntimeSignal: AbortSignal.timeout(20000),
    extensionFlagValues: parsed.unknownFlags,
    resourceLoaderOptions: {
      additionalExtensionPaths: paths(parsed.extensions),
      noExtensions: parsed.noExtensions,
      additionalSkillPaths: paths(parsed.skills),
      noSkills: parsed.noSkills,
      additionalPromptTemplatePaths: paths(parsed.promptTemplates),
      noPromptTemplates: parsed.noPromptTemplates,
      additionalThemePaths: paths(parsed.themes),
      noThemes: parsed.noThemes,
      noContextFiles: parsed.noContextFiles,
    },
    resourceLoaderReloadOptions: shouldResolve
      ? {
          resolveProjectTrust: ({ extensionsResult }) =>
            resolveProjectTrusted({
              cwd,
              trustStore,
              extensionsResult,
              defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
              projectTrustContext: createProjectTrustContext({
                cwd,
                mode: 'rpc',
                settingsManager,
                hasUI: false,
              }),
            }),
        }
      : undefined,
  });
  if (
    services.modelRuntime.getError() ||
    settingsManager.drainErrors().length ||
    services.diagnostics.some((item) => item.type === 'error') ||
    services.resourceLoader.getExtensions().errors.length
  )
    throw new Error('Native configuration could not be loaded');
  writeFileSync(
    output,
    JSON.stringify({
      trusted: settingsManager.isProjectTrusted(),
      effective: {
        provider: settingsManager.getDefaultProvider(),
        model: settingsManager.getDefaultModel(),
      },
    }),
    { flag: 'wx', mode: 0o600 },
  );
} catch {
  process.exitCode = 1;
}

// Resource inspection has no live session to shut down. Native extensions may
// start MCP children while loading; the supervisor reaps them after this exit.
process.exit(process.exitCode ?? 0);
