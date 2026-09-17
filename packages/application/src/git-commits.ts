import type {
  AppState,
  AppStore,
  GitCommitJob,
  GitCommitResult,
  ProcessSupervisor,
  Runtime,
  WorkspaceAccess,
} from './ports.ts';
export const gitBlocked = (state: AppState, laneId: string) =>
  state.gitCommits.some(
    (job) => job.laneId === laneId && ['pending', 'uncertain'].includes(job.state),
  );
function selection(revision: string, paths: string[]) {
  if (!/^[a-f0-9]{64}$/.test(revision))
    throw new Error('Reload Git changes before selecting files');
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.some((path) => typeof path !== 'string' || !path || path.includes('\0')) ||
    new Set(paths).size !== paths.length
  )
    throw new Error('Select distinct whole files');
  return [...paths].sort();
}
export function createGitCommits(deps: {
  store: AppStore;
  git: WorkspaceAccess;
  supervisor: ProcessSupervisor;
  runtime: Runtime;
  withLane<T>(laneId: string, work: () => Promise<T>): Promise<T>;
  prepare(laneId: string): Promise<string>;
}) {
  const { store, git, supervisor, runtime, withLane, prepare } = deps;
  const state = () => store.snapshot().state;
  const find = (id: string) => {
    const job = state().gitCommits.find((item) => item.id === id);
    if (!job) throw new Error('Git commit request not found');
    return job;
  };
  function finish(jobId: string, result: GitCommitResult) {
    store.transaction((tx) => {
      const job = tx.state.gitCommits.find((item) => item.id === jobId)!;
      const previous = { state: job.state, commit: job.commit, error: job.error };
      Object.assign(job, result, { phase: 'done', hook: null });
      if (result.state === 'reviewed' && previous.error)
        job.error = previous.error + '\n' + result.error;
      for (const operation of tx.state.operations.filter(
        (item) => item.gitCommitId === jobId && ['pending', 'uncertain'].includes(item.state),
      )) {
        operation.state =
          result.state === 'uncertain'
            ? 'uncertain'
            : result.state === 'committed' || operation.kind === 'recover-git-commit'
              ? 'completed'
              : 'failed';
        operation.error = result.error;
      }
      const lane = tx.state.lanes.find((item) => item.id === job.laneId)!;
      if (result.state === 'uncertain') {
        lane.state = 'recovering';
        lane.reason = 'Git 提交结果未确认；请核对提交结果，勿重复提交。';
      } else if (result.state === 'failed' || result.error) {
        lane.state = 'paused';
        lane.reason = 'Git 提交或钩子需要处理；请查看结果，再明确恢复队列。';
      }
      tx.emit(result.state === 'reviewed' ? 'git.commit-reviewed' : 'git.commit-result', {
        jobId,
        ...(result.state === 'reviewed' ? { previous } : {}),
      });
    });
    return find(jobId);
  }
  /** Caller owns lane maintenance and has reaped every prior operation in that lane. */
  async function reconcile(jobId: string, review = false) {
    const job = find(jobId);
    if (!['pending', 'uncertain'].includes(job.state)) return job;
    const operationId = runtime.id();
    store.transaction((tx) => {
      tx.state.operations.push({
        id: operationId,
        laneId: job.laneId,
        kind: review ? 'review-git-commit' : 'recover-git-commit',
        gitCommitId: job.id,
        target: job.directory,
        state: 'pending',
        error: null,
        createdAt: runtime.now(),
      });
      tx.state.gitCommits.find((item) => item.id === jobId)!.phase = 'reconciling';
      tx.emit('git.commit-reconciling', { jobId });
    });
    try {
      const current = state(),
        lane = current.lanes.find((item) => item.id === job.laneId)!,
        owner = current.projects.find((item) => item.id === lane.projectId)!;
      if (lane.directory !== job.directory)
        throw new Error('Git workspace binding changed; inspect it before reconciling this commit');
      const binding = { repository: owner.repository, ref: lane.ref };
      return finish(
        jobId,
        await (review
          ? git.reviewCommit({ directory: job.directory, operationId, jobId, binding })
          : git.recoverCommit({ directory: job.directory, operationId, jobId, binding })),
      );
    } catch (cause) {
      const proof = await supervisor.recover(operationId);
      return finish(jobId, {
        state: 'uncertain',
        commit: find(jobId).commit,
        error: proof.settled
          ? cause instanceof Error
            ? cause.message
            : 'Git recovery failed'
          : proof.reason,
      });
    }
  }
  return {
    reconcile,
    async previewGitCommit(laneId: string, revision: string, paths: string[]) {
      paths = selection(revision, paths);
      return withLane(laneId, async () => {
        const directory = await prepare(laneId),
          operationId = runtime.id();
        store.transaction((tx) => {
          tx.state.operations.push({
            id: operationId,
            laneId,
            kind: 'preview-git-commit',
            target: directory,
            state: 'pending',
            error: null,
            createdAt: runtime.now(),
          });
          tx.emit('git.commit-previewing', { laneId });
        });
        try {
          const view = await git.previewCommit({ directory, operationId, revision, paths });
          store.transaction((tx) => {
            tx.state.operations.find((item) => item.id === operationId)!.state = 'completed';
            tx.emit('git.commit-previewed', { laneId });
          });
          return view;
        } catch (cause) {
          const proof = await supervisor.recover(operationId);
          store.transaction((tx) => {
            tx.state.operations.find((item) => item.id === operationId)!.state = proof.settled
              ? 'failed'
              : 'uncertain';
            if (!proof.settled) {
              const lane = tx.state.lanes.find((item) => item.id === laneId)!;
              lane.state = 'recovering';
              lane.reason = proof.reason;
            }
            tx.emit('git.commit-preview-failed', { laneId });
          });
          throw cause;
        }
      });
    },
    async commitGit(input: {
      laneId: string;
      requestId: string;
      revision: string;
      tree: string;
      paths: string[];
      message: string;
    }) {
      const paths = selection(input.revision, input.paths);
      if (
        !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.tree)
      )
        throw new Error('Invalid commit confirmation');
      if (
        typeof input.message !== 'string' ||
        !input.message.trim() ||
        input.message.includes('\0') ||
        input.message.length > 65536
      )
        throw new Error('Enter a valid commit message');
      const existing = state().gitCommits.find((job) => job.requestId === input.requestId);
      if (existing) {
        if (
          existing.laneId !== input.laneId ||
          existing.revision !== input.revision ||
          existing.tree !== input.tree ||
          existing.message !== input.message ||
          JSON.stringify(existing.paths) !== JSON.stringify(paths)
        )
          throw new Error('Commit request ID conflicts with earlier content');
        return existing;
      }
      return withLane(input.laneId, async () => {
        if (gitBlocked(state(), input.laneId))
          throw new Error('Resolve the pending Git commit before submitting another');
        const directory = await prepare(input.laneId),
          operationId = runtime.id();
        const job: GitCommitJob = {
          ...input,
          paths,
          id: runtime.id(),
          directory,
          state: 'pending',
          phase: 'preparing',
          hook: null,
          commit: null,
          error: null,
          createdAt: runtime.now(),
        };
        store.transaction((tx) => {
          tx.state.gitCommits.push(job);
          tx.state.operations.push({
            id: operationId,
            laneId: job.laneId,
            kind: 'commit-git',
            gitCommitId: job.id,
            target: directory,
            state: 'pending',
            error: null,
            createdAt: runtime.now(),
          });
          tx.emit('git.commit-accepted', { jobId: job.id });
        });
        try {
          const result = await git.commitFiles(
            { ...input, paths, directory, operationId, jobId: job.id },
            (event) => {
              store.transaction((tx) => {
                const saved = tx.state.gitCommits.find((item) => item.id === job.id)!;
                saved.phase = event.phase === 'started' ? 'hook' : 'committing';
                saved.hook = event.phase === 'started' ? event.name : null;
                tx.emit('git.commit-hook', { jobId: job.id, ...event });
              });
            },
          );
          return finish(job.id, result);
        } catch (cause) {
          const proof = await supervisor.recover(operationId);
          if (proof.settled) return reconcile(job.id);
          return finish(job.id, { state: 'uncertain', commit: null, error: proof.reason });
        }
      });
    },
  };
}
