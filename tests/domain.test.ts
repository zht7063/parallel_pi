import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, transition, resolveModel } from '@parallel-pi/domain';
import type { LaneCandidate } from '@parallel-pi/domain';

test('FIFO, fair branches, occupied directories, pause and global slots are respected', () => {
  const lanes: LaneCandidate[] = [
    { id: 'a', directory: '/a', state: 'ready', lastServed: 2 },
    { id: 'b', directory: '/b', state: 'ready', lastServed: 0 },
    { id: 'alias', directory: '/b', state: 'ready', lastServed: 1 },
    { id: 'paused', directory: '/p', state: 'paused', lastServed: 0 },
  ];
  const queue = [
    { id: 'a2', laneId: 'a', sequence: 2 },
    { id: 'a1', laneId: 'a', sequence: 1 },
    { id: 'b1', laneId: 'b', sequence: 3 },
    { id: 'alias1', laneId: 'alias', sequence: 4 },
    { id: 'p1', laneId: 'paused', sequence: 0 },
  ];
  assert.deepEqual(schedule(lanes, queue, []), ['b1', 'a1']);
  assert.deepEqual(schedule(lanes, queue, [{ laneId: 'b', directory: '/b' }]), ['a1']);
  assert.deepEqual(schedule(lanes, queue, [{ laneId: 'b', directory: '/b' }], 1), []);
  assert.throws(() => schedule(lanes, queue, [], 0));
});

test('terminal runs cannot restart and cancellation cannot claim model success', () => {
  assert.equal(transition('running', 'waiting_input'), 'waiting_input');
  assert.equal(transition('waiting_input', 'stopping'), 'stopping');
  assert.equal(transition('stopping', 'cancelled'), 'cancelled');
  assert.throws(() => transition('interrupted', 'running'));
  assert.throws(() => transition('stopping', 'succeeded'));
  const project = { provider: 'provider', model: 'first' };
  const queued = resolveModel(undefined, project);
  project.model = 'second';
  assert.equal(queued.model, 'first');
  assert.throws(() => resolveModel());
});
