import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '../vendor/pi/packages/ai/dist/index.js';

// This provider tests the real kernel with deterministic responses, not model quality.
export default function (pi) {
  const faux = fauxProvider({ provider: 'parallel-probe', models: [
    { id: 'probe-a', input: ['text', 'image'] },
    { id: 'probe-b', input: ['text', 'image'] },
  ] });
  pi.registerProvider(faux.provider.id, {
    api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: 'local-fixture',
    models: faux.models, streamSimple: faux.provider.streamSimple,
  });
  pi.on('before_agent_start', (event) => {
    if (event.prompt === 'probe-tool') {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('bash', { command: 'printf probe-tool-output' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('tool complete'),
      ]);
    } else if (event.prompt === 'probe-slow-tool') {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('bash', { command: 'echo $$ > tool.pid; printf started; sleep 30; echo unsafe > late-write' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('slow tool complete'),
      ]);
    } else {
      faux.setResponses([(context) => fauxAssistantMessage(JSON.stringify({
        userMessages: context.messages.filter(m => m.role === 'user'),
      }))]);
    }
  });
  pi.registerCommand('probe-question', {
    description: 'Exercise correlated RPC questions',
    handler: async (_args, ctx) => {
      const answer = await ctx.ui.input('Probe question');
      ctx.ui.notify(`answer:${answer}`, 'info');
    },
  });
}
