<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref } from 'vue';
import type { WorkspaceSnapshot } from '@parallel-pi/contracts';
import { stateLabel, isActive } from '../workspace.ts';
import { layoutSessions } from '../map-layout.ts';
const props = defineProps<{
  snapshot: WorkspaceSnapshot;
  projectId: string;
  scope: 'global' | 'overlay';
  activeSession?: string;
  connected: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{
  remote: [branch: { ref: string; name: string }];
  enter: [id: string];
  create: [laneId: string, parentId?: string];
  command: [input: unknown];
  select: [id: string];
}>();
const key = `parallel_pi.map.${props.projectId}.${props.scope}`;
const view = reactive({ zoom: 1, left: 0, top: 0, selected: '', preview: false, limit: 40 });
try {
  const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
  if (Number.isFinite(saved.zoom)) view.zoom = Math.min(1.5, Math.max(0.5, saved.zoom));
  for (const field of ['left', 'top'] as const)
    if (Number.isFinite(saved[field])) view[field] = Math.max(0, saved[field]);
  if (typeof saved.selected === 'string') view.selected = saved.selected;
  view.preview = saved.preview === true;
  if (Number.isSafeInteger(saved.limit)) view.limit = Math.max(40, saved.limit);
} catch {}
const viewport = ref<HTMLElement | null>(null),
  canvas = ref<HTMLElement | null>(null);
const size = reactive({ width: 0, height: 0 });
const lanes = computed(() =>
  props.snapshot.lanes
    .filter((lane) => lane.projectId === props.projectId)
    .map((lane) => {
      const sessions = props.snapshot.sessions.filter((session) => session.laneId === lane.id);
      return {
        ...lane,
        total: sessions.length,
        layout: layoutSessions(sessions.slice(0, view.limit)),
      };
    }),
);
const project = computed(() => props.snapshot.projects.find((item) => item.id === props.projectId));
const remoteBranches = computed(
  () =>
    project.value?.remoteBranches.filter(
      (remote) => !lanes.value.some((lane) => lane.upstream === remote.ref),
    ) ?? [],
);
const selected = computed(() =>
  props.snapshot.sessions.find(
    (session) =>
      session.id === view.selected && lanes.value.some((lane) => lane.id === session.laneId),
  ),
);
const selectedLane = computed(() => lanes.value.find((lane) => lane.id === selected.value?.laneId));
function save() {
  try {
    localStorage.setItem(key, JSON.stringify(view));
  } catch {}
}
function scroll() {
  if (!viewport.value || restoring) return;
  view.left = viewport.value.scrollLeft;
  view.top = viewport.value.scrollTop;
  save();
}
let restoring = true,
  observer: ResizeObserver | undefined;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previous: HTMLElement | null = null;
function select(id: string, event: MouseEvent) {
  clearTimeout(previewTimer);
  previous = event.currentTarget as HTMLElement;
  view.selected = id;
  emit('select', id);
  save();
  // Opening an overlapping preview must not intercept the second pointer click.
  if (event.detail === 0) {
    view.preview = true;
    save();
  } else
    previewTimer = setTimeout(() => {
      view.preview = true;
      save();
    }, 400);
}
function enter(id: string) {
  clearTimeout(previewTimer);
  if (props.snapshot.sessions.find((session) => session.id === id)?.state === 'ready')
    emit('enter', id);
}
function closePreview() {
  clearTimeout(previewTimer);
  view.preview = false;
  save();
  previous?.focus();
}
function closeTop() {
  if (!view.preview) return false;
  closePreview();
  return true;
}
defineExpose({ closeTop });
function escape(event: KeyboardEvent) {
  if (event.key === 'Escape' && view.preview && !event.isComposing) {
    event.stopPropagation();
    closePreview();
  }
}
async function zoom(delta: number) {
  const el = viewport.value;
  if (!el) return;
  const old = view.zoom,
    next = Math.round(Math.min(1.5, Math.max(0.5, old + delta)) * 100) / 100;
  const centerX = (el.scrollLeft + el.clientWidth / 2) / old;
  const centerY = (el.scrollTop + el.clientHeight / 2) / old;
  view.zoom = next;
  await nextTick();
  el.scrollLeft = centerX * next - el.clientWidth / 2;
  el.scrollTop = centerY * next - el.clientHeight / 2;
  scroll();
  save();
}
async function locate() {
  const id = props.activeSession || view.selected;
  const session = props.snapshot.sessions.find((item) => item.id === id);
  if (!session) return;
  const index = props.snapshot.sessions
    .filter((item) => item.laneId === session.laneId)
    .findIndex((item) => item.id === id);
  view.limit = Math.max(view.limit, Math.ceil((index + 1) / 40) * 40);
  await nextTick();
  if (canvas.value) {
    size.width = canvas.value.offsetWidth;
    size.height = canvas.value.offsetHeight;
  }
  await nextTick();
  const el = viewport.value,
    target = canvas.value?.querySelector<HTMLElement>(`[data-session="${CSS.escape(id)}"]`);
  if (!el || !target) return;
  const rect = target.getBoundingClientRect(),
    bounds = el.getBoundingClientRect();
  el.scrollLeft += rect.left - bounds.left - (el.clientWidth - rect.width) / 2;
  el.scrollTop += rect.top - bounds.top - (el.clientHeight - rect.height) / 2;
  scroll();
}
function pan(x: number, y: number) {
  viewport.value?.scrollBy(x, y);
}
function keys(event: KeyboardEvent) {
  if (event.target !== viewport.value || event.isComposing) return;
  const directions: Record<string, [number, number]> = {
    ArrowLeft: [-120, 0],
    ArrowRight: [120, 0],
    ArrowUp: [0, -120],
    ArrowDown: [0, 120],
  };
  const direction = directions[event.key];
  if (direction) {
    event.preventDefault();
    pan(...direction);
  }
}
let drag: { x: number; y: number; left: number; top: number; pointer: number } | undefined;
function pointerDown(event: PointerEvent) {
  if (
    event.pointerType === 'touch' ||
    event.button !== 0 ||
    (event.target as Element).closest('button,a,input,select,summary,.session-node,.lane-warning')
  )
    return;
  const el = viewport.value!;
  drag = {
    x: event.clientX,
    y: event.clientY,
    left: el.scrollLeft,
    top: el.scrollTop,
    pointer: event.pointerId,
  };
  el.setPointerCapture(event.pointerId);
}
function pointerMove(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointer || !viewport.value) return;
  viewport.value.scrollLeft = drag.left - event.clientX + drag.x;
  viewport.value.scrollTop = drag.top - event.clientY + drag.y;
}
function pointerUp() {
  drag = undefined;
}
function laneStatus(id: string, state: string) {
  const active = props.snapshot.runs.find((run) => run.laneId === id && isActive(run.state));
  return stateLabel[active?.state ?? state];
}
function lastRun(id: string) {
  return props.snapshot.runs.filter((run) => run.sessionId === id).at(-1);
}
function summary(id: string) {
  return (
    props.snapshot.sessions
      .find((session) => session.id === id)
      ?.messages.filter((message) => message.role === 'assistant')
      .at(-1)?.text ?? ''
  );
}
onMounted(async () => {
  observer = new ResizeObserver(() => {
    if (!canvas.value) return;
    size.width = canvas.value.offsetWidth;
    size.height = canvas.value.offsetHeight;
  });
  if (canvas.value) {
    size.width = canvas.value.offsetWidth;
    size.height = canvas.value.offsetHeight;
    observer.observe(canvas.value);
  }
  await nextTick();
  if (viewport.value) {
    viewport.value.scrollLeft = view.left;
    viewport.value.scrollTop = view.top;
  }
  restoring = false;
  emit('select', view.selected);
});
onBeforeUnmount(() => {
  clearTimeout(previewTimer);
  observer?.disconnect();
  scroll();
  save();
});
</script>
<template>
  <section
    class="project-map"
    :aria-label="scope === 'global' ? '全局分支地图' : '浮层分支地图'"
    @keydown="escape"
  >
    <div class="map-controls" aria-label="地图视口控制">
      <button type="button" aria-label="缩小地图" :disabled="view.zoom <= 0.5" @click="zoom(-0.1)">
        −
      </button>
      <span class="mono">{{ Math.round(view.zoom * 100) }}%</span>
      <button type="button" aria-label="放大地图" :disabled="view.zoom >= 1.5" @click="zoom(0.1)">
        ＋
      </button>
      <button type="button" @click="zoom(1 - view.zoom)">原始比例</button>
      <button type="button" aria-label="向左平移地图" @click="pan(-240, 0)">←</button>
      <button type="button" aria-label="向右平移地图" @click="pan(240, 0)">→</button>
      <button type="button" :disabled="!activeSession && !selected" @click="locate">
        {{ activeSession ? '定位当前会话' : '定位选中会话' }}
      </button>
      <span class="hint">滚动或拖动空白处浏览 · Enter 预览</span>
    </div>
    <details class="remote-branches">
      <summary>仅远端分支 · {{ remoteBranches.length }}</summary>
      <p class="hint">
        {{
          project?.remoteFetchedAt
            ? `上次远端刷新：${new Date(project?.remoteFetchedAt).toLocaleString('zh-CN')}`
            : '显示本地已知引用；尚未通过应用刷新远端。'
        }}
      </p>
      <p v-if="project?.remoteError" class="error">
        刷新失败，保留的列表可能过期：{{ project?.remoteError }}
      </p>
      <p v-if="!remoteBranches.length" class="hint">没有尚未跟踪的远端分支。</p>
      <div v-for="remote in remoteBranches" :key="remote.ref" class="remote-branch-row">
        <span class="mono">{{ remote.remote }}/{{ remote.name }}</span>
        <button type="button" :disabled="busy || !connected" @click="emit('remote', remote)">
          拉取到本地
        </button>
      </div>
    </details>
    <div
      ref="viewport"
      class="map-viewport"
      tabindex="0"
      aria-label="地图画布，方向键平移"
      @scroll="scroll"
      @keydown="keys"
      @pointerdown="pointerDown"
      @pointermove="pointerMove"
      @pointerup="pointerUp"
      @pointercancel="pointerUp"
      @wheel="
        (event) => {
          if (event.ctrlKey) {
            event.preventDefault();
            zoom(event.deltaY < 0 ? 0.1 : -0.1);
          }
        }
      "
    >
      <div
        class="map-space"
        :style="{ width: `${size.width * view.zoom}px`, height: `${size.height * view.zoom}px` }"
      >
        <div ref="canvas" class="branch-map" :style="{ transform: `scale(${view.zoom})` }">
          <section
            v-for="lane in lanes"
            :key="lane.id"
            class="branch-lane"
            :style="{ width: `${lane.layout.width}px` }"
            :aria-label="lane.ref.replace('refs/heads/', '')"
          >
            <div class="lane-heading">
              <svg
                class="branch-symbol"
                aria-hidden="true"
                width="18"
                height="22"
                viewBox="0 0 18 22"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
              >
                <path d="M5 5v12M5 11c7 0 8-2 8-6" />
                <circle cx="5" cy="3" r="2" />
                <circle cx="13" cy="3" r="2" />
                <circle cx="5" cy="19" r="2" />
              </svg>
              <h3 class="mono">{{ lane.ref.replace('refs/heads/', '') }}</h3>
              <span class="status-chip">{{ laneStatus(lane.id, lane.state) }}</span>
            </div>
            <p class="lane-detail">
              {{ lane.directory ? '工作区已就绪' : '首次使用时准备工作区' }} ·
              {{
                snapshot.runs.filter((run) => run.laneId === lane.id && run.state === 'queued')
                  .length
              }}
              项排队
            </p>
            <div v-if="lane.state !== 'ready'" class="lane-warning">
              <p>{{ lane.reason }}</p>
              <button
                type="button"
                :disabled="busy || !connected"
                @click="
                  emit('command', {
                    type: lane.state === 'recovering' ? 'lane.recover' : 'lane.resume',
                    laneId: lane.id,
                  })
                "
              >
                {{ lane.state === 'recovering' ? '核验恢复' : '恢复队列' }}
              </button>
            </div>
            <div class="session-track" :style="{ height: `${lane.layout.height}px` }">
              <svg
                class="session-edges"
                :width="lane.layout.width"
                :height="lane.layout.height"
                aria-hidden="true"
              >
                <g
                  v-for="edge in lane.layout.edges"
                  :key="edge.id"
                  :data-source="edge.source"
                  :data-target="edge.id"
                  :class="edge.kind"
                >
                  <path :d="edge.path" />
                  <text :x="edge.x" :y="edge.y">{{ edge.label }}</text>
                </g>
              </svg>
              <article
                v-for="node in lane.layout.nodes"
                :key="node.session.id"
                class="session-node"
                :data-session="node.session.id"
                :class="{
                  selected: view.selected === node.session.id,
                  current: activeSession === node.session.id,
                }"
                :style="{ left: `${node.x}px`, top: `${node.y}px` }"
              >
                <button
                  type="button"
                  class="node-main"
                  :aria-label="`预览 ${node.session.title}`"
                  @click="select(node.session.id, $event)"
                  @dblclick.stop="enter(node.session.id)"
                >
                  <span v-if="node.session.origin" class="node-origin"
                    >{{ node.session.origin.kind === 'fork' ? '分叉自' : '接续自' }}
                    {{
                      snapshot.sessions.find((item) => item.id === node.session.origin?.sessionId)
                        ?.title
                    }}</span
                  ><span v-else class="node-origin">独立思路</span>
                  <strong :title="node.session.title">{{ node.session.title }}</strong
                  ><span>{{
                    node.session.state === 'ready'
                      ? stateLabel[lastRun(node.session.id)?.state ?? ''] || '尚未运行'
                      : stateLabel[node.session.state]
                  }}</span>
                  <time
                    class="hint"
                    :datetime="new Date(node.session.lastActivityAt).toISOString()"
                    >{{ new Date(node.session.lastActivityAt).toLocaleString('zh-CN') }}</time
                  >
                  <p>{{ summary(node.session.id).slice(0, 90) || '从当前分支继续工作' }}</p>
                </button>
                <button
                  type="button"
                  class="node-enter"
                  :disabled="node.session.state !== 'ready'"
                  @click="enter(node.session.id)"
                >
                  进入会话 →
                </button>
                <button
                  type="button"
                  class="node-enter"
                  :disabled="
                    node.session.state !== 'ready' || lane.state === 'recovering' || !connected
                  "
                  @click="emit('create', lane.id, node.session.id)"
                >
                  新建接续会话
                </button>
              </article>
              <p v-if="!lane.total" class="lane-empty">这条分支还没有会话。</p>
            </div>
            <button
              v-if="lane.total > view.limit"
              type="button"
              @click="
                view.limit += 40;
                save();
              "
            >
              加载更多会话（已显示 {{ view.limit }} / {{ lane.total }}）
            </button>
            <button
              type="button"
              class="new-session"
              :disabled="lane.state === 'recovering' || !connected"
              @click="emit('create', lane.id)"
            >
              ＋ 新建独立会话
            </button>
          </section>
        </div>
      </div>
    </div>
    <section v-if="view.preview && selected" class="session-preview" aria-label="会话预览">
      <button type="button" @click="closePreview">关闭预览</button>
      <h2>{{ selected.title }}</h2>
      <p class="mono">{{ selectedLane?.ref.replace('refs/heads/', '') }}</p>
      <p>{{ stateLabel[lastRun(selected.id)?.state ?? ''] || '尚未运行' }}</p>
      <p v-if="selected.origin">
        {{ selected.origin.kind === 'fork' ? '分叉' : '接续' }}来源：{{
          snapshot.sessions.find((item) => item.id === selected?.origin?.sessionId)?.title
        }}<span v-if="selected.origin.kind === 'fork'" class="mono">
          · {{ selected.origin.entryId }}</span
        >
      </p>
      <p class="message-text">
        {{ summary(selected.id).slice(0, 1200) || '尚无执行结果。进入会话后可以发送消息。' }}
      </p>
      <button
        type="button"
        class="primary"
        :disabled="selected.state !== 'ready'"
        @click="enter(selected.id)"
      >
        进入会话
      </button>
      <button
        type="button"
        :disabled="!connected || selected.state !== 'ready' || selectedLane?.state === 'recovering'"
        @click="emit('create', selected.laneId, selected.id)"
      >
        新建接续会话
      </button>
    </section>
  </section>
</template>
