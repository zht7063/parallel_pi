import { reactive, ref, watch, onBeforeUnmount } from 'vue';
import type { WorkspaceClient } from './workspace.ts';

type PendingSend = { requestId: string; sessionId: string; text: string; attachmentIds: string[] };
export interface LocalDraft {
  text: string;
  attachmentIds: string[];
  revision: number;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  error: string;
  pending: PendingSend | null;
}
export interface Upload {
  id: string;
  sessionId: string;
  name: string;
  data: string;
  mimeType: string;
  error: string;
  uploading: boolean;
}
export function useDrafts(client: WorkspaceClient) {
  const uploads = ref<Upload[]>([]);
  const composing = new Set<string>();
  const drafts = reactive<Record<string, LocalDraft>>({});
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Map<string, Promise<void>>();
  function cache(id: string) {
    try {
      localStorage.setItem(`parallel_pi.draft.${id}`, JSON.stringify(drafts[id]));
    } catch {
      drafts[id]!.error = '本地草稿缓存不可用，请保持此页面打开并保存到后端。';
    }
  }
  function get(id: string): LocalDraft {
    if (!drafts[id]) {
      const remote = client.snapshot.value?.drafts.find((item) => item.sessionId === id);
      let cached: Partial<LocalDraft> = {};
      try {
        cached = JSON.parse(localStorage.getItem(`parallel_pi.draft.${id}`) ?? '{}') ?? {};
      } catch {
        /* A damaged cache never replaces server state. */
      }
      const useLocal = cached && (cached.dirty || cached.pending);
      drafts[id] = {
        text: useLocal && typeof cached.text === 'string' ? cached.text : (remote?.text ?? ''),
        attachmentIds:
          useLocal && Array.isArray(cached.attachmentIds)
            ? cached.attachmentIds
            : (remote?.attachmentIds ?? []),
        revision:
          useLocal && typeof cached.revision === 'number'
            ? cached.revision
            : (remote?.revision ?? 0),
        dirty: Boolean(useLocal),
        saving: false,
        conflict: Boolean(useLocal && (cached.revision ?? 0) !== (remote?.revision ?? 0)),
        error: '',
        pending: cached?.pending ?? null,
      };
    }
    return drafts[id]!;
  }
  function schedule(id: string) {
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        void save(id);
      }, 500),
    );
  }
  function edit(id: string, update: Partial<Pick<LocalDraft, 'text' | 'attachmentIds'>>) {
    const draft = get(id);
    Object.assign(draft, update);
    draft.dirty = true;
    cache(id);
    if (!draft.conflict && !composing.has(id)) schedule(id);
  }
  async function save(id: string): Promise<void> {
    clearTimeout(timers.get(id));
    if (inFlight.has(id)) {
      await inFlight.get(id);
      if (get(id).dirty && !get(id).conflict && !get(id).error) return save(id);
      return;
    }
    const draft = get(id);
    if (
      composing.has(id) ||
      !draft.dirty ||
      draft.conflict ||
      client.connection.value !== 'connected'
    )
      return;
    const text = draft.text,
      ids = [...draft.attachmentIds];
    draft.saving = true;
    draft.error = '';
    const job = (async () => {
      try {
        const result = await client.request<{ revision: number }>('/api/command', {
          type: 'draft.save',
          sessionId: id,
          revision: draft.revision,
          text,
          attachmentIds: ids,
        });
        draft.revision = result.revision;
        draft.dirty =
          draft.text !== text || JSON.stringify(draft.attachmentIds) !== JSON.stringify(ids);
      } catch (cause) {
        draft.error = cause instanceof Error ? cause.message : '草稿保存失败';
        draft.conflict = draft.error.includes('conflict');
      } finally {
        draft.saving = false;
        cache(id);
      }
    })();
    inFlight.set(id, job);
    await job;
    inFlight.delete(id);
    if (draft.dirty && !draft.error && !draft.conflict) schedule(id);
  }
  function loadRemote(id: string) {
    const remote = client.snapshot.value?.drafts.find((item) => item.sessionId === id);
    const draft = get(id);
    Object.assign(draft, {
      text: remote?.text ?? '',
      attachmentIds: remote?.attachmentIds ?? [],
      revision: remote?.revision ?? 0,
      dirty: false,
      conflict: false,
      error: '',
    });
    cache(id);
  }
  async function keepLocal(id: string) {
    await client.refresh();
    const draft = get(id);
    draft.revision =
      client.snapshot.value?.drafts.find((item) => item.sessionId === id)?.revision ?? 0;
    draft.conflict = false;
    draft.error = '';
    draft.dirty = true;
    await save(id);
  }
  async function send(id: string) {
    const draft = get(id);
    await save(id);
    if (draft.conflict) throw new Error('请先处理草稿冲突，再发送。');
    if (!draft.pending) {
      if (!draft.text.trim() && !draft.attachmentIds.length)
        throw new Error('请输入消息或添加图片。');
      draft.pending = {
        requestId: crypto.randomUUID(),
        sessionId: id,
        text: draft.text,
        attachmentIds: [...draft.attachmentIds],
      };
      cache(id);
    }
    await client.command({ type: 'run.enqueue', ...draft.pending });
    const sent = draft.pending;
    draft.pending = null;
    if (
      draft.text === sent.text &&
      JSON.stringify(draft.attachmentIds) === JSON.stringify(sent.attachmentIds)
    ) {
      draft.text = '';
      draft.attachmentIds = [];
      draft.dirty = true;
    }
    cache(id);
    await save(id);
  }
  watch(client.snapshot, (value) => {
    for (const [id, draft] of Object.entries(drafts)) {
      const remote = value?.drafts.find((item) => item.sessionId === id);
      if (draft.saving || !remote || remote.revision <= draft.revision) continue;
      if (draft.dirty || draft.pending) {
        draft.conflict = true;
        cache(id);
      } else loadRemote(id);
    }
  });
  watch(client.connection, (value) => {
    if (value === 'connected')
      for (const id of Object.keys(drafts)) if (get(id).dirty) schedule(id);
  });
  onBeforeUnmount(() => {
    for (const timer of timers.values()) clearTimeout(timer);
  });
  return {
    get,
    edit,
    save,
    send,
    loadRemote,
    keepLocal,
    uploads,
    pauseSave(id: string) {
      composing.add(id);
      clearTimeout(timers.get(id));
    },
    resumeSave(id: string) {
      composing.delete(id);
      schedule(id);
    },
  };
}
export type DraftManager = ReturnType<typeof useDrafts>;
