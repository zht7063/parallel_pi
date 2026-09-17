<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue';
import type { WorkspaceSnapshot, RunActivity } from '@parallel-pi/contracts';
import type { WorkspaceClient } from '../workspace.ts';
import { stateLabel, isActive } from '../workspace.ts';
import type { DraftManager } from '../drafts.ts';
import Composer from './Composer.vue';
const props = defineProps<{
  session: WorkspaceSnapshot['sessions'][number];
  lane: WorkspaceSnapshot['lanes'][number];
  client: WorkspaceClient;
  drafts: DraftManager;
}>();
const emit = defineEmits<{
  model: [];
  fork: [message: WorkspaceSnapshot['sessions'][number]['messages'][number]];
}>();
const runs = computed(
  () => props.client.snapshot.value?.runs.filter((run) => run.sessionId === props.session.id) ?? [],
);
const pendingHandoffs = computed(
  () =>
    props.client.snapshot.value?.runs.filter(
      (run) =>
        run.laneId === props.lane.id &&
        run.handoff &&
        ['pending', 'failed'].includes(run.handoff.state),
    ) ?? [],
);
const pendingMemories = computed(
  () =>
    props.client.snapshot.value?.memorySaves.filter(
      (job) => job.laneId === props.lane.id && ['pending', 'failed'].includes(job.state),
    ) ?? [],
);
const current = computed(() => [...runs.value].reverse().find((run) => isActive(run.state)));
const occupied = computed(
  () =>
    props.client.snapshot.value?.runs.some(
      (run) => run.laneId === props.lane.id && (isActive(run.state) || run.state === 'queued'),
    ) ?? false,
);
const branchRuns = computed(
  () => props.client.snapshot.value?.runs.filter((run) => run.laneId === props.lane.id) ?? [],
);
const otherActive = computed(() =>
  branchRuns.value.find((run) => run.sessionId !== props.session.id && isActive(run.state)),
);
function queuePosition(id: string) {
  return (
    branchRuns.value.filter((run) => run.state === 'queued').findIndex((run) => run.id === id) + 1
  );
}
const activity = ref<RunActivity[]>([]),
  cursor = ref(0),
  runId = ref(''),
  error = ref(''),
  busy = ref(false),
  answer = ref('');
const messages = ref<HTMLElement | null>(null),
  follow = ref(true);
const historyLimit = ref(40),
  historyBusy = ref(false),
  historyError = ref('');
const visibleMessages = ref(props.session.messages);
const scrollKey = `parallel_pi.conversation.${props.session.id}`;
let savedTop: number | null = null,
  restoringHistory = true;
let historyRequest: AbortController | null = null;
let pendingPrepend = false;
try {
  const saved = JSON.parse(sessionStorage.getItem(scrollKey) ?? '{}');
  if (Number.isFinite(saved.top)) savedTop = Math.max(0, saved.top);
  if (typeof saved.follow === 'boolean') follow.value = saved.follow;
  if (Number.isSafeInteger(saved.limit)) historyLimit.value = Math.max(40, saved.limit);
  if (!follow.value && Number.isSafeInteger(saved.count))
    historyLimit.value += Math.max(0, props.session.messageCount - saved.count);
} catch {}
function saveScroll() {
  if (!messages.value || restoringHistory) return;
  try {
    sessionStorage.setItem(
      scrollKey,
      JSON.stringify({
        top: messages.value.scrollTop,
        follow: follow.value,
        limit: historyLimit.value,
        count: props.session.messageCount,
      }),
    );
  } catch {}
}
async function loadHistory(prepend = pendingPrepend) {
  pendingPrepend = prepend;
  historyRequest?.abort();
  const controller = new AbortController();
  historyRequest = controller;
  historyBusy.value = true;
  historyError.value = '';
  const el = messages.value,
    oldHeight = el?.scrollHeight ?? 0,
    oldTop = el?.scrollTop ?? 0;
  const anchorElement = [...(el?.querySelectorAll<HTMLElement>('.message') ?? [])].find(
    (item) => item.getBoundingClientRect().bottom > (el?.getBoundingClientRect().top ?? 0),
  );
  const anchor = anchorElement
    ? {
        id: anchorElement.dataset.entry!,
        top: anchorElement.getBoundingClientRect().top - el!.getBoundingClientRect().top,
      }
    : null;
  try {
    let page = await props.client.history(props.session.id, undefined, controller.signal);
    let loaded = page.messages;
    while (page.more && loaded.length < historyLimit.value && loaded[0]) {
      page = await props.client.history(props.session.id, loaded[0].id, controller.signal);
      loaded = [...page.messages, ...loaded];
    }
    if (controller.signal.aborted || disposed) return;
    visibleMessages.value = loaded;
    await nextTick();
    const target = messages.value;
    if (target) {
      if (restoringHistory && savedTop !== null && !follow.value) target.scrollTop = savedTop;
      else if ((prepend || !follow.value) && anchor) {
        const item = target.querySelector<HTMLElement>(`[data-entry="${CSS.escape(anchor.id)}"]`);
        if (item)
          target.scrollTop +=
            item.getBoundingClientRect().top - target.getBoundingClientRect().top - anchor.top;
      } else if (prepend) target.scrollTop = oldTop + target.scrollHeight - oldHeight;
      else if (follow.value) target.scrollTop = target.scrollHeight;
      else target.scrollTop = oldTop;
    }
    pendingPrepend = false;
    restoringHistory = false;
    saveScroll();
  } catch (cause) {
    if (!controller.signal.aborted)
      historyError.value = cause instanceof Error ? cause.message : '历史读取失败';
  } finally {
    if (historyRequest === controller) historyBusy.value = false;
  }
}
async function earlier() {
  historyLimit.value += 40;
  await loadHistory(true);
}
let activityRequest: AbortController | null = null;
let disposed = false;
onBeforeUnmount(() => {
  saveScroll();
  disposed = true;
  activityRequest?.abort();
  historyRequest?.abort();
});
let fetching = false,
  reload = false;
const streamedText = computed(() =>
  activity.value
    .filter((item) => item.kind === 'text')
    .map((item) => item.text)
    .join(''),
);
const tools = computed(() => activity.value.filter((item) => item.kind === 'tool'));
const notices = computed(() => activity.value.filter((item) => item.kind === 'notice'));
async function loadActivity() {
  if (disposed) return;
  const target = current.value?.id ?? runs.value.at(-1)?.id;
  if (!target) {
    activityRequest?.abort();
    runId.value = '';
    cursor.value = 0;
    activity.value = [];
    return;
  }
  if (runId.value !== target) {
    activityRequest?.abort();
    runId.value = target;
    cursor.value = 0;
    activity.value = [];
  }
  if (fetching) {
    reload = true;
    return;
  }
  fetching = true;
  const controller = new AbortController();
  activityRequest = controller;
  try {
    let more = true;
    while (more && runId.value === target) {
      const page = await props.client.activity(target, cursor.value, controller.signal);
      if (runId.value !== target) break;
      activity.value.push(...page.activity.filter((item) => item.cursor > cursor.value));
      cursor.value = page.cursor;
      more = page.more;
    }
    if (follow.value) {
      await nextTick();
      messages.value?.scrollTo({ top: messages.value.scrollHeight });
    }
  } catch (cause) {
    if (!controller.signal.aborted && !disposed)
      error.value = cause instanceof Error ? cause.message : '活动记录读取失败';
  } finally {
    fetching = false;
    if (reload) {
      reload = false;
      void loadActivity();
    }
  }
}
watch(
  () => props.session.messageCount,
  (count, previous) => {
    if (previous !== undefined && !follow.value)
      historyLimit.value += Math.max(0, count - previous);
    void loadHistory();
  },
  { immediate: true },
);
watch(
  () => [props.session.id, props.client.snapshot.value?.cursor],
  () => {
    void loadActivity();
  },
  { immediate: true },
);
watch(
  () => current.value?.question?.id,
  () => {
    answer.value = current.value?.question?.prefill ?? '';
  },
);
function scrolled() {
  if (restoringHistory) return;
  const el = messages.value;
  if (el) follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  saveScroll();
}
async function command(input: unknown) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await props.client.command(input);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '操作失败';
  } finally {
    busy.value = false;
  }
}
function reply(value: string | boolean | null) {
  if (current.value?.question)
    void command({
      type: 'run.answer',
      runId: current.value.id,
      questionId: current.value.question.id,
      value,
    });
}
</script>
<template>
  <section class="conversation" :aria-label="`会话 ${session.title}`">
    <div class="conversation-heading">
      <div>
        <h2 tabindex="-1">{{ session.title }}</h2>
        <span class="hint mono"
          >{{ lane.ref.replace('refs/heads/', '') }} · {{ session.model.provider }} /
          {{ session.model.model }}</span
        >
      </div>
      <button
        type="button"
        :disabled="client.connection.value !== 'connected'"
        @click="emit('model')"
      >
        切换会话模型
      </button>
      <span class="status-chip">{{
        current ? stateLabel[current.state] : stateLabel[lane.state]
      }}</span>
    </div>
    <div
      ref="messages"
      class="messages"
      tabindex="0"
      aria-label="会话历史和运行记录"
      @scroll="scrolled"
    >
      <p v-if="otherActive" class="branch-occupancy hint">
        当前分支由“{{
          client.snapshot.value?.sessions.find((item) => item.id === otherActive?.sessionId)?.title
        }}”占用（{{ stateLabel[otherActive.state] }}）。可以继续编辑，新消息将加入队列。
      </p>
      <p class="history-status hint" role="status">{{ historyBusy ? '正在读取历史…' : '' }}</p>
      <div v-if="historyError" class="error" role="alert">
        {{ historyError }} <button type="button" @click="loadHistory()">重试读取历史</button>
      </div>
      <div v-if="lane.state !== 'ready'" class="warning">
        <span>{{ stateLabel[lane.state] }}：{{ lane.reason }}</span
        ><button
          v-if="lane.state === 'recovering'"
          type="button"
          :disabled="busy"
          @click="command({ type: 'lane.recover', laneId: lane.id })"
        >
          核验并收束进程</button
        ><button
          v-else-if="!pendingHandoffs.length && !pendingMemories.length"
          type="button"
          :disabled="busy"
          @click="command({ type: 'lane.resume', laneId: lane.id })"
        >
          恢复未启动的队列
        </button>
      </div>
      <section v-if="pendingHandoffs.length" class="warning" aria-label="待保存的交接记录">
        <div v-for="run in pendingHandoffs" :key="run.id">
          <p><strong>交接记录尚未保存</strong> · {{ run.text.slice(0, 100) || '图片消息' }}</p>
          <p>执行结果已保留。重试仅保存记录，不会重新运行任务；暂不保存会保留缺失标记。</p>
          <p v-if="run.handoff?.error" class="error">{{ run.handoff.error }}</p>
          <button
            type="button"
            :disabled="busy || lane.state === 'recovering'"
            @click="command({ type: 'handoff.retry', runId: run.id })"
          >
            重试保存交接
          </button>
          <button
            type="button"
            :disabled="busy || lane.state === 'recovering'"
            @click="command({ type: 'handoff.continue', runId: run.id })"
          >
            暂不保存，允许恢复队列
          </button>
        </div>
      </section>
      <section v-if="pendingMemories.length" class="warning" aria-label="待保存的长期记忆">
        <div v-for="job in pendingMemories" :key="job.id">
          <p><strong>长期记忆尚未保存</strong> · {{ job.title }}</p>
          <p>重试沿用原保存请求，不会重新运行任务。暂不保存会保留缺失标记。</p>
          <p v-if="job.error" class="error">{{ job.error }}</p>
          <button
            type="button"
            :disabled="busy || lane.state === 'recovering'"
            @click="command({ type: 'memory.retry', saveId: job.id })"
          >
            重试保存长期记忆
          </button>
          <button
            type="button"
            :disabled="busy || lane.state === 'recovering'"
            @click="command({ type: 'memory.continue', saveId: job.id })"
          >
            暂不保存这条记忆
          </button>
        </div>
      </section>
      <div v-if="!session.messages.length && !runs.length" class="conversation-empty">
        <h3>从这条分支开始</h3>
        <p>描述要完成的工作。会话使用当前工作区，已有修改会保留。</p>
      </div>
      <button
        v-if="session.messageCount > visibleMessages.length"
        type="button"
        :disabled="historyBusy"
        @click="earlier"
      >
        加载更早消息（还有 {{ session.messageCount - visibleMessages.length }} 条）
      </button>
      <article
        v-for="message in visibleMessages"
        :key="message.id"
        :data-entry="message.id"
        class="message"
        :class="message.role"
      >
        <span class="message-role">{{
          message.role === 'user' ? '你' : message.role === 'assistant' ? 'pi' : '工具记录'
        }}</span>
        <details v-if="message.role === 'tool'">
          <summary>查看工具输出</summary>
          <pre>{{ message.text }}</pre>
        </details>
        <p v-else class="message-text">{{ message.text }}</p>
        <div class="message-images">
          <a
            v-for="(image, index) in message.images"
            :key="index"
            :href="`data:${image.mimeType};base64,${image.data}`"
            target="_blank"
            rel="noopener"
            ><img
              :src="`data:${image.mimeType};base64,${image.data}`"
              alt="会话中的图片"
              width="240"
              height="180"
          /></a>
        </div>
        <button
          v-if="message.forkable"
          type="button"
          :disabled="
            occupied || lane.state === 'recovering' || client.connection.value !== 'connected'
          "
          @click="emit('fork', message)"
        >
          从此处分叉
        </button>
      </article>
      <section v-if="notices.length" class="warning" aria-label="运行通知">
        <h3>运行通知</h3>
        <p v-for="item in notices" :key="item.cursor" class="message-text">{{ item.text }}</p>
      </section>
      <section v-if="current" class="live-run" aria-label="当前执行">
        <h3>{{ stateLabel[current.state] }}</h3>
        <p class="message-text">{{ current.text }}</p>
        <pre v-if="streamedText" class="stream-text">{{ streamedText }}</pre>
        <details v-if="tools.length" open>
          <summary>工具活动</summary>
          <div v-for="item in tools" :key="item.cursor" class="tool-event">
            <strong
              >{{ item.name }} ·
              {{ item.phase === 'start' ? '开始' : item.phase === 'end' ? '结束' : '输出' }}</strong
            >
            <pre>{{ item.text }}</pre>
          </div>
        </details>
        <button
          type="button"
          class="danger-outline"
          :disabled="busy || current.state === 'stopping'"
          @click="command({ type: 'run.stop', runId: current.id })"
        >
          停止当前执行
        </button>
      </section>
      <section v-if="current?.question && current.state === 'waiting_input'" class="question">
        <h3>{{ current.question.title }}</h3>
        <template v-if="current.question.kind === 'confirm'"
          ><button type="button" :disabled="busy" @click="reply(false)">否</button
          ><button type="button" class="primary" :disabled="busy" @click="reply(true)">
            是
          </button></template
        >
        <form v-else novalidate @submit.prevent="reply(answer)">
          <label for="question-answer">回答</label
          ><select v-if="current.question.kind === 'select'" id="question-answer" v-model="answer">
            <option value="" disabled>请选择</option>
            <option v-for="option in current.question.options" :key="option">
              {{ option }}
            </option></select
          ><textarea
            class="resize-none"
            v-else
            id="question-answer"
            v-model="answer"
            rows="3"
          /><button type="submit" :disabled="busy || !answer">回复当前任务</button>
        </form>
      </section>
      <section v-if="runs.length" class="run-history" aria-label="运行队列">
        <h3>运行队列与结果</h3>
        <article v-for="run in [...runs].reverse()" :key="run.id" class="run-row">
          <div>
            <strong>{{ stateLabel[run.state] }}</strong
            ><span class="hint mono">{{ run.model.provider }} / {{ run.model.model }}</span>
            <p>{{ run.text.slice(0, 180) || '图片消息' }}</p>
            <p v-if="run.state === 'queued'" class="hint">
              该分支等待序列第 {{ queuePosition(run.id) }} 项
            </p>
            <p v-if="run.handoff" class="hint">
              交接记录：{{
                {
                  pending: '待保存',
                  saved: '已保存',
                  failed: '保存失败',
                  continued: '已明确暂不保存',
                }[run.handoff.state]
              }}
            </p>
            <p v-if="run.error" class="error">{{ run.error }}</p>
          </div>
          <button
            v-if="run.state === 'queued'"
            type="button"
            :disabled="busy"
            @click="command({ type: 'run.stop', runId: run.id })"
          >
            取消排队
          </button>
        </article>
      </section>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
    </div>
    <button
      :class="{ hidden: follow }"
      class="latest"
      type="button"
      @click="
        follow = true;
        messages?.scrollTo({ top: messages.scrollHeight });
      "
    >
      查看最新内容 ↓
    </button>
    <Composer
      :key="session.id"
      :session-id="session.id"
      :client="client"
      :drafts="drafts"
      :occupied="occupied"
      :disabled="client.connection.value !== 'connected' || session.state !== 'ready'"
    />
  </section>
</template>
