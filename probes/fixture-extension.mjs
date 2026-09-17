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
  let askBeforeTool = false, structuredQuestions = false;
  pi.on('tool_call', async (event, ctx) => {
    if (structuredQuestions && event.toolName === 'bash') {
      structuredQuestions = false;
      const choice = await ctx.ui.select('选择下一步', ['查看', '继续']);
      const confirmed = await ctx.ui.confirm('确认测试操作', '只运行测试命令，保留已有文件。');
      const edited = await ctx.ui.editor('编辑测试说明', '原生预填第一行\n原生预填第二行');
      ctx.ui.notify(JSON.stringify({ choice, confirmed, edited }), 'info');
    }
    if (askBeforeTool && event.toolName === 'bash') {
      askBeforeTool = false;
      await ctx.ui.input('Continue probe tool?');
    }
  });
  pi.on('before_agent_start', (event) => {
    askBeforeTool = event.prompt === 'probe-question-tool';
    structuredQuestions = event.prompt === 'probe-structured-questions';
    if (event.prompt === 'probe-tool' || askBeforeTool || structuredQuestions) {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('bash', { command: 'pwd; printf probe-tool-output' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('tool complete'),
      ]);
    } else if (event.prompt === 'probe-failed-turn') {
      faux.setResponses([fauxAssistantMessage('partial before failure', { stopReason: 'error', errorMessage: 'Injected terminal model failure' })]);
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
