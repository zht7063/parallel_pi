import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutSessions, NODE_HEIGHT } from '../apps/web/src/map-layout.ts';
import type { WorkspaceSnapshot } from '@parallel-pi/contracts';
test('map forest retains multiple roots and typed edges without changing path identity or crossing lanes', () => {
  const make = (id: string, origin?: WorkspaceSnapshot['sessions'][number]['origin']) => ({
    id,
    pathId: id === 'continued' ? 'root' : id,
    laneId: 'main',
    title: id,
    createdAt: 1,
    lastActivityAt: 1,
    model: { provider: 'test', model: 'test' },
    state: 'ready' as const,
    messages: [],
    messageCount: 0,
    origin,
  });
  const sessions = [
    make('root'),
    make('independent'),
    make('fork', { kind: 'fork', sessionId: 'root', entryId: 'entry' }),
    make('continued', { kind: 'continue', sessionId: 'root' }),
    { ...make('other', { kind: 'continue', sessionId: 'root' }), laneId: 'other' },
  ];
  const layout = layoutSessions(sessions);
  assert.equal(layout.nodes.length, 5);
  assert.deepEqual(
    layout.edges.map(({ source, id, kind }) => ({ source, id, kind })),
    [
      { source: 'root', id: 'fork', kind: 'fork' },
      { source: 'root', id: 'continued', kind: 'continue' },
    ],
  );
  assert.equal(
    layout.nodes.find((node) => node.session.id === 'continued')?.session.pathId,
    'root',
  );
  for (let i = 1; i < layout.nodes.length; i++)
    assert.ok(layout.nodes[i]!.y >= layout.nodes[i - 1]!.y + NODE_HEIGHT);
  const broken = [
    make('a', { kind: 'continue', sessionId: 'b' }),
    make('b', { kind: 'continue', sessionId: 'a' }),
  ];
  assert.equal(layoutSessions(broken).nodes.length, 2);
});
