import { onBeforeUnmount, ref } from 'vue';
import type { WorkspaceSnapshot, RunActivity } from '@parallel-pi/contracts';

export function useWorkspace() {
  const snapshot = ref<WorkspaceSnapshot | null>(null);
  const connection = ref<'loading' | 'connected' | 'offline'>('loading');
  const error = ref('');
  let stream: EventSource | null = null,
    reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined,
    disposed = false,
    attempts = 0;
  let refreshing: Promise<void> | null = null,
    refreshAgain = false;
  async function request<T>(path: string, input?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(path, {
      ...(input === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? `请求失败 (${response.status})`);
    return result;
  }
  function refresh(): Promise<void> {
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = request<WorkspaceSnapshot>('/api/snapshot')
      .then((value) => {
        if (!disposed && (!snapshot.value || value.cursor >= snapshot.value.cursor))
          snapshot.value = value;
      })
      .finally(() => {
        refreshing = null;
        if (refreshAgain && !disposed) {
          refreshAgain = false;
          void refresh().catch(disconnected);
        }
      });
    return refreshing;
  }
  function disconnected(cause?: unknown) {
    if (disposed) return;
    stream?.close();
    stream = null;
    connection.value = 'offline';
    error.value =
      cause instanceof Error
        ? cause.message
        : '连接已断开，后台任务可能仍在运行。重新连接不会再次发送消息。';
    if (attempts < 3) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(
        () => {
          attempts++;
          void connect(false);
        },
        1000 * 2 ** attempts,
      );
    }
  }
  async function connect(manual = true) {
    if (disposed) return;
    if (manual) attempts = 0;
    clearTimeout(reconnectTimer);
    stream?.close();
    connection.value = 'loading';
    error.value = '';
    try {
      await request('/api/session');
      await request('/api/status');
      await refresh();
      if (disposed) return;
      connection.value = 'connected';
      stream = new EventSource(`/api/events?after=${snapshot.value!.cursor}`);
      stream.onmessage = () => {
        if (!refreshTimer)
          refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            void refresh().catch(disconnected);
          }, 80);
      };
      stream.onerror = () => disconnected();
    } catch (cause) {
      disconnected(cause);
    }
  }
  async function command<T = Record<string, unknown>>(input: unknown): Promise<T> {
    if (connection.value !== 'connected') throw new Error('请先重新连接。输入已保留。');
    const result = await request<T>('/api/command', input);
    await refresh();
    return result;
  }
  async function activity(runId: string, after: number, signal?: AbortSignal) {
    return request<{ cursor: number; activity: RunActivity[]; more: boolean }>(
      `/api/activity?runId=${encodeURIComponent(runId)}&after=${after}`,
      undefined,
      signal,
    );
  }
  onBeforeUnmount(() => {
    disposed = true;
    stream?.close();
    clearTimeout(reconnectTimer);
    clearTimeout(refreshTimer);
  });
  return { snapshot, connection, error, request, refresh, connect, command, activity };
}
export type WorkspaceClient = ReturnType<typeof useWorkspace>;
export const stateLabel: Record<string, string> = {
  ready: '就绪',
  paused: '已暂停',
  recovering: '待核验',
  creating: '正在创建',
  error: '创建失败',
  queued: '排队中',
  starting: '正在准备',
  running: '执行中',
  waiting_input: '等待回答',
  stopping: '正在停止',
  succeeded: '执行完成',
  failed: '执行失败',
  cancelled: '已停止',
  interrupted: '已中断',
};
export const isActive = (state: string) =>
  ['starting', 'running', 'waiting_input', 'stopping'].includes(state);
