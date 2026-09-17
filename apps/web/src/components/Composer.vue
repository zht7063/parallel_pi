<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DraftManager, Upload } from '../drafts.ts';
import type { WorkspaceClient } from '../workspace.ts';
const props = defineProps<{
  sessionId: string;
  client: WorkspaceClient;
  drafts: DraftManager;
  occupied: boolean;
  disabled: boolean;
}>();
const expanded = ref(false);
const draft = computed(() => props.drafts.get(props.sessionId));
const sending = ref(false),
  error = ref(''),
  composing = ref(false);
const textInput = ref<HTMLTextAreaElement | null>(null);
const uploads = props.drafts.uploads;
const visibleUploads = computed(() =>
  uploads.value.filter((item) => item.sessionId === props.sessionId),
);
async function upload(item: Upload) {
  item.uploading = true;
  item.error = '';
  try {
    const result = await props.client.command<{ id: string }>({
      type: 'attachment.upload',
      mimeType: item.mimeType,
      data: item.data.split(',')[1],
    });
    const target = props.drafts.get(item.sessionId);
    props.drafts.edit(item.sessionId, { attachmentIds: [...target.attachmentIds, result.id] });
    uploads.value = uploads.value.filter((value) => value.id !== item.id);
  } catch (cause) {
    item.error = cause instanceof Error ? cause.message : '图片上传失败，请重试。';
  } finally {
    item.uploading = false;
  }
}
async function selectFiles(files: File[]) {
  error.value = '';
  const id = props.sessionId;
  for (const file of files) {
    if (
      props.drafts.get(id).attachmentIds.length +
        uploads.value.filter((item) => item.sessionId === id).length >=
      10
    ) {
      error.value = '每条消息最多添加 10 张图片。';
      break;
    }
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      !file.size ||
      file.size > 10 * 1024 * 1024
    ) {
      error.value = `${file.name}：请选择不超过 10 MiB 的 PNG、JPEG 或 WebP 图片。`;
      continue;
    }
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('无法读取图片'));
      reader.readAsDataURL(file);
    });
    const item: Upload = {
      id: crypto.randomUUID(),
      sessionId: id,
      name: file.name,
      data,
      mimeType: file.type,
      error: '',
      uploading: false,
    };
    uploads.value.push(item);
    void upload(uploads.value.at(-1)!);
  }
}
function fileChanged(event: Event) {
  const input = event.target as HTMLInputElement;
  void selectFiles(Array.from(input.files ?? [])).catch((cause) => {
    error.value = String(cause);
  });
  input.value = '';
}
function paste(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length) {
    event.preventDefault();
    void selectFiles(files).catch((cause) => {
      error.value = String(cause);
    });
  }
}
const inputText = computed({
  get: () => draft.value.text,
  set: (value) => props.drafts.edit(props.sessionId, { text: value }),
});
function compositionEnd() {
  composing.value = false;
  props.drafts.resumeSave(props.sessionId);
}
async function send() {
  if (sending.value || composing.value || props.disabled || visibleUploads.value.length) return;
  sending.value = true;
  error.value = '';
  try {
    await props.drafts.send(props.sessionId);
    textInput.value?.focus();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '发送结果未确认，输入已保留。';
  } finally {
    sending.value = false;
  }
}
function shortcut(event: KeyboardEvent) {
  if (
    event.key === 'Enter' &&
    (event.ctrlKey || event.metaKey) &&
    !event.isComposing &&
    !composing.value
  ) {
    event.preventDefault();
    void send();
  }
}
</script>
<template>
  <form class="composer" novalidate @submit.prevent="send">
    <label :for="`message-${sessionId}`">消息</label>
    <textarea
      class="resize-none"
      :id="`message-${sessionId}`"
      ref="textInput"
      v-model="inputText"
      :readonly="sending || Boolean(draft.pending)"
      :rows="expanded ? 10 : 4"
      aria-describedby="composer-help"
      @compositionstart="
        composing = true;
        drafts.pauseSave(sessionId);
      "
      @compositionend="compositionEnd"
      @keydown="shortcut"
      @paste="paste"
    />
    <div v-if="draft.attachmentIds.length || visibleUploads.length" class="attachments">
      <figure v-for="id in draft.attachmentIds" :key="id">
        <a :href="`/api/attachment?id=${id}`" target="_blank" rel="noopener"
          ><img
            :src="`/api/attachment?id=${id}`"
            alt="待发送图片，打开查看原图"
            width="96"
            height="72" /></a
        ><button
          type="button"
          :disabled="sending || Boolean(draft.pending)"
          @click="
            drafts.edit(sessionId, {
              attachmentIds: draft.attachmentIds.filter((value) => value !== id),
            })
          "
        >
          移除图片
        </button>
      </figure>
      <figure v-for="item in visibleUploads" :key="item.id">
        <img :src="item.data" :alt="item.name" width="96" height="72" />
        <figcaption>{{ item.uploading ? '上传中…' : item.error }}</figcaption>
        <button v-if="!item.uploading" type="button" @click="upload(item)">重试上传</button
        ><button
          v-if="!item.uploading"
          type="button"
          @click="uploads = uploads.filter((value) => value.id !== item.id)"
        >
          移除
        </button>
      </figure>
    </div>
    <p id="composer-help" class="hint">
      Ctrl / ⌘ + Enter 发送 · 可粘贴图片 · PNG / JPEG / WebP，每张不超过 10 MiB，合计不超过 12 MiB
    </p>
    <div class="composer-actions">
      <button type="button" :aria-expanded="expanded" @click="expanded = !expanded">
        {{ expanded ? '收起输入' : '展开输入' }}
      </button>
      <label class="file-button"
        >添加图片<input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          :disabled="sending || Boolean(draft.pending)"
          @change="fileChanged" /></label
      ><span class="draft-status">{{
        draft.conflict
          ? '草稿冲突'
          : draft.saving
            ? '正在保存草稿…'
            : draft.dirty
              ? '草稿已保留在此浏览器，待同步'
              : '草稿已保存'
      }}</span
      ><button
        class="primary"
        type="submit"
        :disabled="disabled || sending || Boolean(visibleUploads.length) || draft.conflict"
        :aria-busy="sending"
      >
        {{
          sending ? '正在提交…' : draft.pending ? '核对并重试发送' : occupied ? '加入队列' : '发送'
        }}
      </button>
    </div>
    <p v-if="draft.pending && !sending" class="warning">
      上次发送结果未确认。重试会沿用同一请求，不会重复启动任务。
    </p>
    <div v-if="draft.conflict" class="warning">
      <p>另一个标签页保存了新草稿。你的输入仍保留，请选择要继续的版本。</p>
      <button type="button" @click="drafts.loadRemote(sessionId)">采用后端草稿</button
      ><button type="button" @click="drafts.keepLocal(sessionId)">以我的草稿替换后端版本</button>
    </div>
    <p v-if="error || draft.error" role="alert" class="error">
      {{ error || draft.error
      }}<button v-if="draft.error && !draft.conflict" type="button" @click="drafts.save(sessionId)">
        重试保存草稿
      </button>
    </p>
  </form>
</template>
