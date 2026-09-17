<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { GitChangesSnapshot } from '@parallel-pi/contracts';
import type { WorkspaceClient } from '../workspace.ts';
import AppDialog from './AppDialog.vue';
const props = defineProps<{ client: WorkspaceClient; laneId: string }>();
const emit = defineEmits<{ close: [] }>();
const view = ref<GitChangesSnapshot | null>(null);
const selected = ref('');
const busy = ref(false),
  error = ref('');
const file = computed(() => view.value?.files.find((item) => item.path === selected.value));
async function load() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    view.value = (await props.client.command({
      type: 'git.inspect',
      laneId: props.laneId,
    })) as GitChangesSnapshot;
    if (!view.value.files.some((item) => item.path === selected.value))
      selected.value = view.value.files[0]?.path ?? '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取变更失败，请重试。';
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  void load();
});
</script>
<template>
  <AppDialog title="分支变更" :blocked="busy" @close="emit('close')">
    <p class="hint">
      这里展示分支工作区的当前变更，不代表所有修改都来自某个会话。重命名按删除和新增两个路径展示。
    </p>
    <p class="form-error" role="alert">{{ error }}</p>
    <p role="status">{{ busy ? '正在读取 Git 变更…' : '' }}</p>
    <button type="button" :disabled="busy" @click="load">重新读取变更</button>
    <p v-if="error && view" class="warning">下面保留上次读取的结果；请重新读取后核对当前内容。</p>
    <template v-if="view">
      <p class="mono message-text">{{ view.ref }} · {{ view.directory }}</p>
      <p class="mono message-text">基准 HEAD：{{ view.head }}</p>
      <p v-if="!view.files.length">工作区干净，没有待提交的变更。</p>
      <section v-else aria-label="变更文件">
        <h3>变更文件 · {{ view.files.length }}</h3>
        <div class="dialog-form">
          <button
            v-for="item in view.files"
            :key="item.path"
            class="message-text"
            type="button"
            :disabled="busy"
            :aria-pressed="selected === item.path"
            @click="selected = item.path"
          >
            {{ item.path }} · {{ item.staged ? '已暂存' : '' }}
            {{ item.untracked ? '未跟踪' : item.unstaged ? '未暂存' : ''
            }}{{ item.partial ? ' · 部分暂存' : '' }}
          </button>
        </div>
      </section>
      <section v-if="file" aria-label="文件变更内容">
        <h3 class="mono message-text">{{ file.path }}</h3>
        <p v-if="file.partial" class="warning">
          此文件的暂存区与工作区内容不同。请在外部 Git
          工具处理部分暂存，再重新读取；不会自动扩大为整文件提交。
        </p>
        <p v-if="file.unsupported" class="warning">{{ file.unsupported }}</p>
        <template v-else>
          <section v-if="file.staged" aria-label="已暂存内容">
            <h4>已暂存 · HEAD → 暂存区</h4>
            <pre>{{ file.stagedDiff || '没有文本差异。' }}</pre>
          </section>
          <section v-if="file.unstaged" aria-label="工作区内容">
            <h4>{{ file.untracked ? '未跟踪文件' : '未暂存 · 暂存区 → 工作区' }}</h4>
            <pre>{{ file.workingDiff || '没有文本差异。' }}</pre>
          </section>
        </template>
      </section>
    </template>
  </AppDialog>
</template>
