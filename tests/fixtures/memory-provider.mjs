import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '../../vendor/pi/packages/ai/dist/index.js';
export default function (pi) {
  const faux = fauxProvider({ provider: 'memory-probe', models: [{ id: 'memory-model' }] });
  pi.registerProvider(faux.provider.id, {
    api: faux.api,
    baseUrl: faux.getModel().baseUrl,
    apiKey: 'local-fixture',
    models: faux.models,
    streamSimple: faux.provider.streamSimple,
  });
  pi.on('before_agent_start', (event, ctx) => {
    const context = (value) =>
      fauxAssistantMessage(
        JSON.stringify({
          messages: value.messages.filter((message) => message.role !== 'assistant'),
          tools: value.tools?.map((tool) => tool.name),
          mcpSource: pi.getAllTools().find((tool) => tool.name === 'mcp')?.sourceInfo.path,
        }),
      );
    if (event.prompt === 'memory-recall')
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall('mcp', {
            server: 'parallel_mwf',
            tool: 'mwf_recall',
            args: { project_root: ctx.cwd, path: 'code' },
          }),
          { stopReason: 'toolUse' },
        ),
        context,
      ]);
    else if (event.prompt === 'memory-write')
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall('mcp', {
            server: 'parallel_mwf',
            tool: 'mwf_add',
            args: {
              project_root: ctx.cwd,
              request_id: 'agent-verified-memory',
              type: 'knowledge',
              title: 'Agent tool evidence',
              summary: 'Native MCP write verified',
              body: 'Written by the real pi tool execution loop with a controlled provider.',
              scope: { paths: ['code'] },
            },
          }),
          { stopReason: 'toolUse' },
        ),
        context,
      ]);
    else if (event.prompt.startsWith('memory-cross-root:'))
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall('mcp', {
            server: 'parallel_mwf',
            tool: 'mwf_recall',
            args: { project_root: event.prompt.slice('memory-cross-root:'.length) },
          }),
          { stopReason: 'toolUse' },
        ),
        context,
      ]);
    else faux.setResponses([context]);
  });
}
