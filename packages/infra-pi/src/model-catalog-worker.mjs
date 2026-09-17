// Pinned native catalog, no extensions/session/prompt. Credential resolution may
// use the user's native command expressions, so run only under supervision.
import { join } from 'node:path';
import { ModelRuntime } from '../../../vendor/pi/packages/coding-agent/dist/core/model-runtime.js';
try {
  const directory = process.argv[2];
  const runtime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath: join(directory, 'models.json'),
    allowModelNetwork: false,
    signal: AbortSignal.timeout(20000),
  });
  if (runtime.getError()) throw new Error('Invalid native model configuration');
  const available = new Set(
    runtime.getAvailableSnapshot().map((model) => JSON.stringify([model.provider, model.id])),
  );
  const models = runtime.getModels().map((model) => ({
    provider: model.provider,
    model: model.id,
    name: model.name,
    images: model.input.includes('image'),
    available: available.has(JSON.stringify([model.provider, model.id])),
  }));
  process.stdout.write(JSON.stringify(models));
} catch {
  // Never emit native parser/auth errors: they may contain credential values.
  process.exitCode = 1;
}
