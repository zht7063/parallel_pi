<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type {
  GitChangesSnapshot,
  GitCommitPreview,
  GitCommitSnapshot,
} from '@parallel-pi/contracts';
import type { WorkspaceClient } from '../workspace.ts';
import AppDialog from './AppDialog.vue';
const props = defineProps<{ client: WorkspaceClient; laneId: string }>();
const emit = defineEmits<{ close: [] }>();
const view = ref<GitChangesSnapshot | null>(null);
const selected = ref(''),
  paths = ref<string[]>([]),
  message = ref('');
const approved = ref<GitCommitPreview | null>(null);
const confirmingReview = ref(false);
const missingPaths = computed(() =>
  view.value
    ? paths.value.filter((path) => !view.value!.files.some((file) => file.path === path))
    : [],
);
const busy = ref(false),
  error = ref(''),
  notice = ref('');
const jobs = computed(
  () => props.client.snapshot.value?.gitCommits.filter((job) => job.laneId === props.laneId) ?? [],
);
const latest = computed(() => jobs.value.at(-1));
const pending = computed(() =>
  jobs.value.find((job) => ['pending', 'uncertain'].includes(job.state)),
);
const intent = ref<{
  requestId: string;
  revision: string;
  tree: string;
  paths: string[];
  message: string;
} | null>(null);
const blocked = computed(() => busy.value || Boolean(pending.value) || Boolean(intent.value));
const file = computed(() => view.value?.files.find((item) => item.path === selected.value));
const dirty = computed(
  () => !pending.value && Boolean(message.value || paths.value.length || intent.value),
);
const jobLabel = computed(() => {
  const job = latest.value;
  if (!job) return '';
  if (job.state === 'committed') return '提交已创建';
  if (job.state === 'reviewed') return '已记录外部核对';
  if (job.state === 'failed') return '提交未完成';
  if (job.state === 'uncertain') return '提交结果需要核对';
  if (job.phase === 'hook') return `正在运行钩子：${job.hook}`;
  if (job.phase === 'reconciling') return '正在核对已有提交，不重复运行钩子';
  return job.phase === 'preparing' ? '正在准备提交' : '正在创建提交';
});
watch(
  () => JSON.stringify([...paths.value].sort()),
  () => {
    approved.value = null;
  },
);
async function read() {
  view.value = (await props.client.command({
    type: 'git.inspect',
    laneId: props.laneId,
  })) as GitChangesSnapshot;
  if (!view.value.files.some((item) => item.path === selected.value))
    selected.value = view.value.files[0]?.path ?? '';
}
async function load() {
  if (blocked.value) return;
  busy.value = true;
  error.value = '';
  approved.value = null;
  try {
    await read();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取变更失败，请重试。';
  } finally {
    busy.value = false;
  }
}
async function previewCommit() {
  if (blocked.value || !view.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  approved.value = null;
  try {
    approved.value = (await props.client.command({
      type: 'git.preview-commit',
      laneId: props.laneId,
      revision: view.value.revision,
      paths: paths.value,
    })) as GitCommitPreview;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '预览失败，请重新读取变更。';
  } finally {
    busy.value = false;
  }
}
async function acceptResult(job: GitCommitSnapshot) {
  if (job.state === 'pending') return;
  intent.value = null;
  approved.value = null;
  if (job.state === 'committed') {
    paths.value = [];
    message.value = '';
    notice.value = `已创建提交 ${job.commit}`;
    await read();
  } else if (job.state === 'reviewed') {
    confirmingReview.value = false;
    notice.value = '已保留当前 Git 状态；分支仍暂停，请检查后明确恢复队列。';
    await read();
  } else if (job.state === 'failed')
    error.value = job.error ?? '提交失败；选择和消息已保留，请重新读取再预览。';
  else error.value = job.error ?? '提交结果尚未确认，请核对后再操作。';
}
async function submit() {
  if (busy.value || pending.value) return;
  if (!intent.value) {
    if (!approved.value || !message.value.trim()) {
      error.value = '请填写提交消息并先预览实际提交内容。';
      return;
    }
    intent.value = {
      requestId: crypto.randomUUID(),
      revision: approved.value.revision,
      tree: approved.value.tree,
      paths: [...approved.value.paths],
      message: message.value,
    };
  }
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const job = (await props.client.command({
      type: 'git.commit',
      laneId: props.laneId,
      ...intent.value,
    })) as GitCommitSnapshot;
    await acceptResult(job);
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : '请求结果未确认；可核对已有结果或重试同一请求。';
  } finally {
    busy.value = false;
  }
}
async function reconcile(reviewed = false) {
  const job = pending.value;
  if (!job || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await acceptResult(
      (await props.client.command({
        type: reviewed ? 'git.review' : 'git.reconcile',
        jobId: job.id,
        confirmed: reviewed,
      })) as GitCommitSnapshot,
    );
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '核对失败，请稍后重试。';
  } finally {
    busy.value = false;
  }
}
watch(
  () => latest.value?.state,
  async (state, previous) => {
    if (busy.value || previous !== 'pending' || !latest.value || state === 'pending') return;
    try {
      await acceptResult(latest.value);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '请重新读取变更。';
    }
  },
);
onMounted(() => {
  if (latest.value && ['failed', 'pending', 'uncertain', 'reviewed'].includes(latest.value.state)) {
    paths.value = [...latest.value.paths];
    message.value = latest.value.message;
  }
  if (!pending.value) void load();
});
</script>
<template>
  <AppDialog title="分支变更" :blocked="busy" :dirty="dirty" @close="emit('close')">
    <p class="hint">
      这里展示分支工作区的当前变更，不代表所有修改都来自某个会话。重命名按删除和新增两个路径展示。
    </p>
    <p class="form-error" role="alert">{{ error }}</p>
    <p role="status">{{ busy && !pending ? '正在处理 Git 请求…' : notice }}</p>
    <section v-if="latest" class="git-section" aria-label="最近提交结果">
      <h3>{{ jobLabel }}</h3>
      <p class="message-text">{{ latest.message }}</p>
      <p v-if="latest.commit" class="mono message-text">Commit：{{ latest.commit }}</p>
      <p v-if="latest.error" class="warning message-text">{{ latest.error }}</p>
      <p v-if="latest.state === 'failed'">
        选择和消息已保留。请重新读取并预览内容后再提交；这会创建新的请求。
      </p>
      <p v-if="pending">提交意图已保存。关闭网页不会撤销提交；核对结果不会重新执行钩子。</p>
      <button v-if="pending" type="button" :disabled="busy" @click="reconcile()">
        核对提交结果
      </button>
      <button
        v-if="latest.state === 'uncertain'"
        type="button"
        :disabled="busy"
        @click="confirmingReview = true"
      >
        已在外部 Git 核对，保留当前状态
      </button>
      <div
        v-if="confirmingReview && latest.state === 'uncertain'"
        class="warning"
        role="group"
        aria-label="确认外部 Git 核对"
      >
        <p>
          请确认已在外部 Git
          工具检查分支、暂存区和工作区。此操作不会撤销或重做提交，只保留当前状态并停止自动修复；分支仍需明确恢复队列。
        </p>
        <button type="button" :disabled="busy" @click="confirmingReview = false">
          继续保留待核对状态
        </button>
        <button type="button" :disabled="busy" @click="reconcile(true)">
          确认已核对并保留当前状态
        </button>
      </div>
    </section>
    <div v-if="intent && !pending" class="warning" role="group" aria-label="未确认的提交请求">
      <p>响应尚未确认。重试会沿用同一请求，不会再次提交已完成的操作。</p>
      <button type="button" :disabled="busy" @click="submit">重试同一提交请求</button>
      <button
        type="button"
        :disabled="busy"
        @click="
          intent = null;
          approved = null;
          notice = '已停止重试，请重新读取并检查最近提交结果；已创建的提交不会撤销。';
        "
      >
        停止重试并重新检查
      </button>
    </div>
    <button type="button" :disabled="blocked" @click="load">重新读取变更</button>
    <p v-if="error && view" class="warning">下面保留上次读取的结果；请重新读取后核对当前内容。</p>
    <template v-if="view">
      <p class="mono message-text">{{ view.ref }} · {{ view.directory }}</p>
      <p class="mono message-text">基准 HEAD：{{ view.head }}</p>
      <p v-if="!view.files.length">工作区干净，没有待提交的变更。</p>
      <section v-else aria-label="变更文件">
        <h3>变更文件 · {{ view.files.length }}</h3>
        <p class="hint">
          勾选整文件提交；未选中的暂存内容保持原样。部分暂存文件请先在外部 Git 工具处理。
        </p>
        <div class="dialog-form">
          <div v-for="item in view.files" :key="item.path" class="git-file">
            <input
              v-model="paths"
              type="checkbox"
              :value="item.path"
              :aria-label="`提交 ${item.path}`"
              :disabled="
                blocked ||
                ((item.partial || Boolean(item.unsupported)) && !paths.includes(item.path))
              "
            />
            <button
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
      <section v-if="missingPaths.length" class="warning" aria-label="已不在变更列表中的选择">
        <p>这些已选路径不在当前变更列表中，请移除后重新预览：</p>
        <button
          v-for="path in missingPaths"
          :key="path"
          type="button"
          class="message-text"
          :disabled="blocked"
          @click="paths = paths.filter((item) => item !== path)"
        >
          移除选择 {{ path }}
        </button>
      </section>
      <form
        v-if="view.files.length || message"
        class="dialog-form git-section"
        novalidate
        @submit.prevent="previewCommit"
      >
        <label for="git-message">提交消息</label>
        <textarea
          id="git-message"
          v-model="message"
          class="resize-none"
          rows="3"
          maxlength="65536"
          :disabled="blocked"
        />
        <p class="hint">已选择 {{ paths.length }} 个整文件。只创建本地提交，不推送或合并。</p>
        <button type="submit" :disabled="blocked || !paths.length">预览实际提交内容</button>
      </form>
      <section v-if="approved" class="git-section" aria-label="确认提交内容">
        <h3>确认提交内容</h3>
        <p class="hint">下面是实际将写入提交的内容。若文件或暂存区改变，必须重新预览。</p>
        <ul>
          <li v-for="path in approved.paths" :key="path" class="mono message-text">{{ path }}</li>
        </ul>
        <pre>{{ approved.diff }}</pre>
        <p class="message-text">提交消息：{{ message || '请填写提交消息' }}</p>
        <button
          type="button"
          class="primary"
          :disabled="blocked || !message.trim()"
          @click="submit"
        >
          确认创建本地提交
        </button>
      </section>
    </template>
  </AppDialog>
</template>
<style scoped>
.git-section {
  border-top: 1px solid var(--border);
  margin-top: 20px;
  padding-top: 16px;
}
.git-file {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}
.git-file input {
  width: auto;
}
p {
  overflow-wrap: anywhere;
}
</style>
