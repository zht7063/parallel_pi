import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createBackend } from '../apps/server/src/bootstrap.ts';

const fixture = fileURLToPath(new URL('./fixtures/memory-provider.mjs', import.meta.url));
async function terminal(app: Awaited<ReturnType<typeof createBackend>>['app'], id: string) {
  for (let i = 0; i < 1000; i++) {
    const run = app.snapshot().state.runs.find((item) => item.id === id)!;
    if (['succeeded', 'failed', 'cancelled'].includes(run.state)) return run;
    await delay(25);
  }
  const run = app.snapshot().state.runs.find((item) => item.id === id)!;
  throw new Error(
    'Memory agent did not finish: ' +
      JSON.stringify({
        state: run.state,
        question: run.question,
        error: run.error,
        events: app
          .events(0)
          .slice(-8)
          .map((event) => event.type),
      }),
  );
}

test(
  'application pi runs bootstrap current memory and execute root-bound native MCP reads and writes',
  { timeout: 90000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'parallel-memory-agent-'));
    const directory = join(root, 'repository');
    mkdirSync(directory);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', directory, ...args], { stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(directory, 'code'), 'original');
    git('add', '.');
    git('commit', '-m', 'initial');
    git('branch', 'other');
    const backend = await createBackend({
      dataDirectory: join(root, 'data'),
      agentDirectory: join(root, 'agent'),
      engineArgs: ['--no-extensions', '--no-skills', '--no-prompt-templates', '-e', fixture],
    });
    t.after(async () => {
      await backend.close();
      rmSync(root, { recursive: true, force: true });
    });
    const { app } = backend;
    await app.addProject(directory);
    const lane = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/main')!;
    assert.equal(
      (
        await app.changeMemory({
          laneId: lane.id,
          requestId: 'initialize',
          change: { kind: 'init', gitMode: 'track' },
        })
      ).state,
      'saved',
    );
    const session = await app.createSession(lane.id, 'Native memory', {
      provider: 'memory-probe',
      model: 'memory-model',
    });
    const saved = await app.saveMemory({
      requestId: 'seed-memory',
      sessionId: session.id,
      content: {
        type: 'knowledge',
        title: 'Workspace marker',
        summary: 'native-memory-marker-one',
        body: 'native-memory-marker-one belongs to this workspace',
        candidate: false,
        scope: { paths: ['code'] },
      },
    });
    assert.equal(saved.state, 'saved');
    const run = async (text: string) => {
      const next = app.enqueue({
        requestId: randomUUID(),
        sessionId: session.id,
        text,
        attachmentIds: [],
      });
      const result = await terminal(app, next.id);
      assert.equal(result.state, 'succeeded', result.error ?? 'run failed');
      return app.snapshot().state.sessions.find((item) => item.id === session.id)!.messages;
    };
    let messages = await run('memory-recall');
    assert.match(messages.at(-1)!.text, /native-memory-marker-one/);
    assert.ok(
      messages.some(
        (item) => item.role === 'tool' && item.text.includes('native-memory-marker-one'),
      ),
    );
    const nativeRef = app
      .snapshot()
      .state.sessions.find((item) => item.id === session.id)!.nativeRef;
    const entries = () =>
      readFileSync(nativeRef, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    assert.equal(
      entries().filter(
        (item) => item.type === 'custom_message' && item.customType === 'parallel-mwf-bootstrap',
      ).length,
      1,
    );
    await run('memory-write');
    const view = await app.inspectMemory(lane.id);
    assert.ok(view.records.some((item) => item.summary === 'Native MCP write verified'));
    assert.equal(
      entries().filter(
        (item) => item.type === 'custom_message' && item.customType === 'parallel-mwf-bootstrap',
      ).length,
      2,
      'new pi process bootstraps on resume',
    );
    const other = app.snapshot().state.lanes.find((item) => item.ref === 'refs/heads/other')!;
    const otherSession = await app.createSession(other.id, 'No implicit memory', {
      provider: 'memory-probe',
      model: 'memory-model',
    });
    const otherDirectory = app
      .snapshot()
      .state.lanes.find((item) => item.id === other.id)!.directory!;
    messages = await run(`memory-cross-root:${otherDirectory}`);
    assert.ok(
      messages.some((item) => item.role === 'tool' && item.text.includes('ROOT_NOT_ALLOWED')),
    );
    const otherRun = app.enqueue({
      requestId: 'other-workspace',
      sessionId: otherSession.id,
      text: 'Inspect available tools',
      attachmentIds: [],
    });
    assert.equal((await terminal(app, otherRun.id)).state, 'succeeded');
    assert.equal(existsSync(join(otherDirectory, '.mwf')), false);
    const otherMessages = app
      .snapshot()
      .state.sessions.find((item) => item.id === otherSession.id)!.messages;
    assert.doesNotMatch(otherMessages.at(-1)!.text, /native-memory-marker-one|mwf-bootstrap/);
    assert.equal(
      existsSync(join(directory, '.pi')),
      false,
      'application integration does not install or modify project extensions',
    );
  },
);

test(
  'existing native bootstrap is not duplicated and the loaded MCP adapter is reused',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'parallel-memory-existing-'));
    const directory = join(root, 'repository'),
      agent = join(root, 'agent');
    mkdirSync(directory);
    mkdirSync(join(agent, 'extensions'), { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', directory, ...args], { stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(directory, 'code'), 'original');
    git('add', '.');
    git('commit', '-m', 'initial');
    const cli = fileURLToPath(
      new URL('../probes/.cache/mwf-source/packages/mwf/dist/cli.js', import.meta.url),
    );
    const adapter = fileURLToPath(
      new URL('../node_modules/pi-mcp-adapter/index.ts', import.meta.url),
    );
    const globalExtension = join(agent, 'extensions/native-mcp.js');
    const mcpConfig = {
      mcpServers: {
        user_mwf: {
          command: process.execPath,
          args: [cli, 'mcp', '--root', directory],
          lifecycle: 'eager',
          directTools: false,
        },
      },
    };
    writeFileSync(
      globalExtension,
      `import { createMcpAdapter } from ${JSON.stringify(adapter)};\nexport default createMcpAdapter({config:${JSON.stringify(mcpConfig)}});\n`,
    );
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always' }));
    const backend = await createBackend({
      dataDirectory: join(root, 'data'),
      agentDirectory: agent,
      engineArgs: ['--no-skills', '--no-prompt-templates', '-e', fixture],
    });
    t.after(async () => {
      await backend.close();
      rmSync(root, { recursive: true, force: true });
    });
    const { app } = backend;
    await app.addProject(directory);
    const lane = app.snapshot().state.lanes[0]!;
    await app.changeMemory({
      laneId: lane.id,
      requestId: 'initialize-existing',
      change: { kind: 'init', gitMode: 'track' },
    });
    const template = readFileSync(
      fileURLToPath(
        new URL('../probes/.cache/mwf-source/packages/mwf/dist/pi-adapter.js', import.meta.url),
      ),
      'utf8',
    );
    const generated =
      '// Generated MWF adapter v2. Business logic lives in the installed CLI.\n' +
      template.replace(/(["'])__MWF_CONFIG__\1/g, () =>
        JSON.stringify(JSON.stringify({ root: directory, node: process.execPath, cli })),
      );
    mkdirSync(join(directory, '.pi/extensions'), { recursive: true });
    const projectExtension = join(directory, '.pi/extensions/mwf.js');
    writeFileSync(projectExtension, generated);
    // Configuration inspection must finish even when resource loading starts an eager MCP child.
    assert.equal((await app.projectConfiguration(lane.id)).trusted, true);
    const session = await app.createSession(lane.id, 'Reuse native adapter', {
      provider: 'memory-probe',
      model: 'memory-model',
    });
    const run = app.enqueue({
      requestId: 'reuse-memory',
      sessionId: session.id,
      text: 'memory-recall',
      attachmentIds: [],
    });
    const result = await terminal(app, run.id);
    assert.equal(result.state, 'succeeded', result.error ?? '');
    const updated = app.snapshot().state.sessions.find((item) => item.id === session.id)!;
    const response = JSON.parse(updated.messages.at(-1)!.text);
    assert.equal(response.mcpSource, globalExtension, 'the existing adapter owns the proxy tool');
    assert.equal(response.tools.filter((name: string) => name === 'mcp').length, 1);
    const entries = readFileSync(updated.nativeRef, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      entries.filter(
        (item) => item.type === 'custom_message' && item.customType === 'mwf-bootstrap',
      ).length,
      1,
    );
    assert.equal(
      readFileSync(projectExtension, 'utf8'),
      generated,
      'project integration remains untouched',
    );
    // A tracked native setup extension can retain the old root after a worktree copy.
    execFileSync(process.execPath, [cli, 'init', '--root', root, '--git-mode', 'ignore']);
    const foreignInput = join(root, 'foreign-input.json');
    writeFileSync(
      foreignInput,
      JSON.stringify({
        project_root: root,
        type: 'knowledge',
        title: 'Foreign memory',
        summary: 'foreign-worktree-marker',
        body: 'foreign-worktree-marker must not enter the nested worktree context',
      }),
    );
    execFileSync(process.execPath, [cli, 'add', '--input-file', foreignInput]);
    writeFileSync(
      projectExtension,
      '// Generated MWF adapter v2. Business logic lives in the installed CLI.\n' +
        template.replace(/(["'])__MWF_CONFIG__\1/g, () =>
          JSON.stringify(JSON.stringify({ root, node: process.execPath, cli })),
        ),
    );
    const nested = app.enqueue({
      requestId: 'nested-worktree',
      sessionId: session.id,
      text: 'Inspect current memory context',
      attachmentIds: [],
    });
    assert.equal((await terminal(app, nested.id)).state, 'succeeded');
    const nestedMessages = app
      .snapshot()
      .state.sessions.find((item) => item.id === session.id)!.messages;
    assert.doesNotMatch(nestedMessages.at(-1)!.text, /foreign-worktree-marker/);
    assert.match(nestedMessages.at(-1)!.text, /parallel_mwf/);
    const savedHistory = readFileSync(updated.nativeRef, 'utf8');
    assert.match(
      savedHistory,
      /foreign-worktree-marker/,
      'filtering model input does not rewrite native history',
    );
    writeFileSync(projectExtension, generated);
    // Native bootstrap errors must also reach the application's visible notice channel.
    writeFileSync(join(directory, '.mwf/config.json'), '{broken config');
    const badRun = app.enqueue({
      requestId: 'invalid-memory',
      sessionId: session.id,
      text: 'Inspect memory failure',
      attachmentIds: [],
    });
    assert.equal((await terminal(app, badRun.id)).state, 'succeeded');
    assert.ok(
      app.events(0).some((item) => {
        const data = item.data as { runId?: string; event?: { type: string; text?: string } };
        return (
          data.runId === badRun.id &&
          data.event?.type === 'notice' &&
          data.event.text?.includes('MWF bootstrap unavailable')
        );
      }),
    );
  },
);
