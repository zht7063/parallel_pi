export type RunState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'stopping'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type LaneState = 'ready' | 'paused' | 'recovering';
export interface ModelSelection {
  provider: string;
  model: string;
}

export const DEFAULT_CONCURRENCY = 2;
export const activeStates: readonly RunState[] = [
  'starting',
  'running',
  'waiting_input',
  'stopping',
];

const transitions: Record<RunState, readonly RunState[]> = {
  queued: ['starting', 'cancelled'],
  starting: ['running', 'stopping', 'failed', 'interrupted'],
  running: ['waiting_input', 'stopping', 'succeeded', 'failed', 'interrupted'],
  waiting_input: ['running', 'stopping', 'failed', 'interrupted'],
  stopping: ['cancelled', 'interrupted'],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export function transition(from: RunState, to: RunState): RunState {
  if (!transitions[from].includes(to)) throw new Error(`Invalid run transition: ${from} → ${to}`);
  return to;
}

export function concurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error('Concurrency must be a positive integer');
  return value;
}

export interface LaneCandidate {
  id: string;
  state: LaneState;
  directory: string | null;
  lastServed: number;
}
export interface QueuedCandidate {
  id: string;
  laneId: string;
  sequence: number;
}
export interface Occupancy {
  laneId: string;
  directory: string | null;
}

/** Select FIFO within each branch, then the least recently served ready branches. */
export function schedule(
  lanes: readonly LaneCandidate[],
  queue: readonly QueuedCandidate[],
  occupied: readonly Occupancy[],
  limit = DEFAULT_CONCURRENCY,
): string[] {
  concurrency(limit);
  const busyLanes = new Set(occupied.map((item) => item.laneId));
  const busyDirectories = new Set(
    occupied.flatMap((item) => (item.directory ? [item.directory] : [])),
  );
  const candidates = lanes
    .filter((lane) => lane.state === 'ready')
    .flatMap((lane) => {
      const run = queue
        .filter((item) => item.laneId === lane.id)
        .sort((a, b) => a.sequence - b.sequence)[0];
      return run ? [{ lane, run }] : [];
    })
    .sort((a, b) => a.lane.lastServed - b.lane.lastServed || a.run.sequence - b.run.sequence);
  const selected: string[] = [];
  for (const { lane, run } of candidates) {
    if (selected.length + occupied.length >= limit) break;
    if (busyLanes.has(lane.id) || (lane.directory && busyDirectories.has(lane.directory))) continue;
    selected.push(run.id);
    busyLanes.add(lane.id);
    if (lane.directory) busyDirectories.add(lane.directory);
  }
  return selected;
}

/** Copy at enqueue time: later defaults cannot mutate the queued choice. */
export function resolveModel(
  session?: ModelSelection,
  project?: ModelSelection,
  global?: ModelSelection,
): ModelSelection {
  const choice = session ?? project ?? global;
  if (!choice?.provider || !choice.model) throw new Error('Select an available provider and model');
  return { ...choice };
}
