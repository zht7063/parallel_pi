<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useWorkspace, stateLabel, isActive } from './workspace.ts';
import { useDrafts } from './drafts.ts';
import AppDialog from './components/AppDialog.vue';
import Conversation from './components/Conversation.vue';
const client = useWorkspace(),
  drafts = useDrafts(client);
const data = client.snapshot;
const selectedProject = ref(''),
  activeSession = ref(''),
  preview = ref('');
const dialog = ref<'project' | 'session' | 'settings' | null>(null),
  busy = ref(false),
  formError = ref('');
const form = reactive({
  directory: '',
  title: '',
  laneId: '',
  provider: '',
  model: '',
  requestId: '',
  concurrency: 2,
});
const project = computed(() =>
  data.value?.projects.find((item) => item.id === selectedProject.value),
);
const lanes = computed(
  () => data.value?.lanes.filter((item) => item.projectId === project.value?.id) ?? [],
);
const session = computed(() =>
  data.value?.sessions.find((item) => item.id === activeSession.value),
);
const sessionLane = computed(() =>
  data.value?.lanes.find((item) => item.id === session.value?.laneId),
);
const previewSession = computed(() =>
  data.value?.sessions.find((item) => item.id === preview.value),
);
function chooseProject(id: string) {
  selectedProject.value = id;
  activeSession.value = '';
  preview.value = '';
  try {
    localStorage.setItem('parallel_pi.project', id);
  } catch {}
}
function enter(id: string) {
  activeSession.value = id;
  preview.value = '';
  try {
    localStorage.setItem(`parallel_pi.view.${selectedProject.value}`, id);
  } catch {}
}
function back() {
  activeSession.value = '';
  try {
    localStorage.removeItem(`parallel_pi.view.${selectedProject.value}`);
  } catch {}
}
function open(type: 'project' | 'session' | 'settings', laneId = '') {
  formError.value = '';
  dialog.value = type;
  form.laneId = laneId;
  form.title = '';
  form.requestId = crypto.randomUUID();
  if (type === 'session') {
    const previous = data.value?.sessions.find((item) => item.laneId === laneId);
    form.provider = project.value?.model?.provider ?? previous?.model.provider ?? '';
    form.model = project.value?.model?.model ?? previous?.model.model ?? '';
  }
  if (type === 'settings') form.concurrency = data.value?.concurrency ?? 2;
}
async function submit() {
  if (busy.value) return;
  if (dialog.value === 'project' && !form.directory.trim()) {
    formError.value = '请输入本机 Git 项目目录。';
    await nextTick();
    document.getElementById('project-directory')?.focus();
    return;
  }
  if (dialog.value === 'session' && (!form.provider.trim() || !form.model.trim())) {
    formError.value = '请填写 provider 和模型 ID；凭据沿用本机 pi 配置。';
    await nextTick();
    document.getElementById(!form.provider.trim() ? 'provider' : 'model')?.focus();
    return;
  }
  busy.value = true;
  formError.value = '';
  try {
    if (dialog.value === 'project') {
      const result = await client.command<{ id: string }>({
        type: 'project.add',
        directory: form.directory,
      });
      chooseProject(result.id);
    } else if (dialog.value === 'session') {
      const result = await client.command<{ id: string }>({
        type: 'session.create',
        laneId: form.laneId,
        title: form.title,
        requestId: form.requestId,
        model: { provider: form.provider.trim(), model: form.model.trim() },
      });
      enter(result.id);
    } else await client.command({ type: 'concurrency.set', value: form.concurrency });
    dialog.value = null;
  } catch (cause) {
    formError.value = cause instanceof Error ? cause.message : '操作失败，输入已保留。';
  } finally {
    busy.value = false;
  }
}
async function command(input: unknown) {
  try {
    await client.command(input);
  } catch (cause) {
    client.error.value = cause instanceof Error ? cause.message : '操作失败';
  }
}
function projectStatus(id: string) {
  const ids =
    data.value?.lanes.filter((item) => item.projectId === id).map((item) => item.id) ?? [];
  const runs = data.value?.runs.filter((item) => ids.includes(item.laneId)) ?? [];
  if (runs.some((item) => item.state === 'waiting_input')) return '等待回答';
  const active = runs.filter((item) => isActive(item.state)).length;
  if (active) return `${active} 个执行中`;
  if (data.value?.lanes.some((item) => ids.includes(item.id) && item.state !== 'ready'))
    return '需要处理';
  return '就绪';
}
function lastState(id: string) {
  const run = data.value?.runs.filter((item) => item.sessionId === id).at(-1);
  return run ? stateLabel[run.state] : '尚未运行';
}
watch(data, (value) => {
  if (!selectedProject.value && value?.projects.length) {
    let stored = '';
    try {
      stored = localStorage.getItem('parallel_pi.project') ?? '';
    } catch {}
    selectedProject.value = value.projects.some((item) => item.id === stored)
      ? stored
      : value.projects[0]!.id;
    try {
      activeSession.value = localStorage.getItem(`parallel_pi.view.${selectedProject.value}`) ?? '';
    } catch {}
  }
});
onMounted(() => {
  void client.connect();
});
</script>
<template>
  <div class="shell">
    <aside class="sidebar" aria-label="项目导航">
      <button type="button" class="wordmark" aria-label="parallel pi 全局地图" @click="back">
        p<span>∥</span>pi</button
      ><span class="nav-note">分支工作台</span>
      <div class="project-navigation">
        <button
          type="button"
          class="add-project"
          :disabled="client.connection.value !== 'connected'"
          @click="open('project')"
        >
          ＋ 添加项目</button
        ><button
          v-for="item in data?.projects"
          :key="item.id"
          type="button"
          class="project-link"
          :class="{ selected: item.id === selectedProject }"
          :aria-current="item.id === selectedProject ? 'page' : undefined"
          @click="chooseProject(item.id)"
        >
          <strong>{{ item.title }}</strong
          ><span>{{ projectStatus(item.id) }}</span></button
        ><button type="button" @click="open('settings')">设置</button>
      </div>
    </aside>
    <main class="workbench">
      <header class="topbar">
        <div>
          <h1>{{ project?.title ?? 'parallel_pi' }}</h1>
          <span v-if="project" class="project-path mono">{{ project.directory }}</span>
        </div>
        <div class="toolbar">
          <span role="status">{{
            client.connection.value === 'loading'
              ? '正在连接…'
              : client.connection.value === 'connected'
                ? '本地服务已连接'
                : '连接已断开'
          }}</span
          ><button
            type="button"
            :disabled="client.connection.value === 'loading'"
            @click="client.connect()"
          >
            重新连接</button
          ><button
            v-if="project && !session"
            type="button"
            :disabled="client.connection.value !== 'connected'"
            @click="command({ type: 'project.refresh', projectId: project.id })"
          >
            刷新分支
          </button>
        </div>
      </header>
      <div v-if="client.error.value" class="error global-error" role="alert">
        {{ client.error.value }}
      </div>
      <Conversation
        v-if="session && sessionLane"
        :key="session.id"
        :session="session"
        :lane="sessionLane"
        :client="client"
        :drafts="drafts"
        @back="back"
      />
      <section v-else-if="!project" class="empty" aria-labelledby="workspace-heading">
        <div class="branch-mark" aria-hidden="true">┬ ┬ ┬</div>
        <h2 id="workspace-heading">把项目放到地图上</h2>
        <p>按 Git 分支组织工作，让不同思路在同一份当前代码上接续。</p>
        <button
          class="primary"
          type="button"
          :disabled="client.connection.value !== 'connected'"
          @click="open('project')"
        >
          添加第一个项目
        </button>
        <p class="hint">已有修改会保留 · 同分支串行 · 不同分支并行</p>
      </section>
      <section v-else class="map-area" aria-label="全局分支地图">
        <div class="map-caption">
          <h2>分支地图</h2>
          <span>全局并发 {{ data?.concurrency }} · 选择会话预览，双击或通过按钮进入</span>
        </div>
        <div class="branch-map">
          <section
            v-for="lane in lanes"
            :key="lane.id"
            class="branch-lane"
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
              <span class="status-chip">{{ stateLabel[lane.state] }}</span>
            </div>
            <p class="lane-detail">
              {{ lane.directory ? '工作区已就绪' : '首次使用时准备工作区' }} ·
              {{
                data?.runs.filter((run) => run.laneId === lane.id && run.state === 'queued').length
              }}
              项排队
            </p>
            <div v-if="lane.state !== 'ready'" class="lane-warning">
              <p>{{ lane.reason }}</p>
              <button
                v-if="lane.state === 'recovering'"
                type="button"
                @click="command({ type: 'lane.recover', laneId: lane.id })"
              >
                核验恢复</button
              ><button
                v-else
                type="button"
                @click="command({ type: 'lane.resume', laneId: lane.id })"
              >
                恢复队列
              </button>
            </div>
            <div class="session-track">
              <article
                v-for="item in data?.sessions.filter((item) => item.laneId === lane.id)"
                :key="item.id"
                class="session-node"
                :class="{ selected: preview === item.id }"
              >
                <button
                  type="button"
                  class="node-main"
                  :aria-label="`预览 ${item.title}`"
                  @click="preview = item.id"
                  @dblclick="enter(item.id)"
                >
                  <strong>{{ item.title }}</strong
                  ><span>{{
                    item.state === 'ready' ? lastState(item.id) : stateLabel[item.state]
                  }}</span>
                  <p>
                    {{
                      item.messages
                        .filter((message) => message.role === 'assistant')
                        .at(-1)
                        ?.text.slice(0, 90) || '从当前分支继续工作'
                    }}
                  </p></button
                ><button
                  type="button"
                  class="node-enter"
                  :disabled="item.state !== 'ready'"
                  @click="enter(item.id)"
                >
                  进入会话 →
                </button>
              </article>
              <p v-if="!data?.sessions.some((item) => item.laneId === lane.id)" class="lane-empty">
                这条分支还没有会话。
              </p>
            </div>
            <button
              type="button"
              class="new-session"
              :disabled="lane.state === 'recovering' || client.connection.value !== 'connected'"
              @click="open('session', lane.id)"
            >
              ＋ 新建独立会话
            </button>
          </section>
        </div>
        <section v-if="previewSession" class="session-preview" aria-label="会话预览">
          <button type="button" @click="preview = ''">关闭预览</button>
          <h2>{{ previewSession.title }}</h2>
          <p>{{ lastState(previewSession.id) }}</p>
          <p class="message-text">
            {{
              previewSession.messages
                .filter((message) => message.role === 'assistant')
                .at(-1)
                ?.text.slice(0, 1200) || '尚无执行结果。进入会话后可以发送消息。'
            }}
          </p>
          <button
            type="button"
            class="primary"
            :disabled="previewSession.state !== 'ready'"
            @click="enter(previewSession.id)"
          >
            进入会话
          </button>
        </section>
      </section>
    </main>
    <AppDialog
      v-if="dialog"
      :title="
        dialog === 'project' ? '添加本机项目' : dialog === 'session' ? '新建独立会话' : '执行设置'
      "
      :blocked="busy"
      @close="dialog = null"
      ><form novalidate class="dialog-form" @submit.prevent="submit">
        <template v-if="dialog === 'project'"
          ><label for="project-directory">Git 项目目录</label
          ><input
            id="project-directory"
            v-model="form.directory"
            autofocus
            :aria-invalid="Boolean(formError)"
            aria-describedby="form-error project-help"
            placeholder="/home/you/project"
          />
          <p id="project-help" class="hint">
            输入本机已检出的 Git 仓库路径。不会移动或清除未提交修改。
          </p></template
        ><template v-else-if="dialog === 'session'"
          ><label for="session-title">会话标题</label
          ><input
            id="session-title"
            v-model="form.title"
            autofocus
            placeholder="描述这条思路"
            maxlength="200"
          /><label for="provider">Provider</label
          ><input
            id="provider"
            v-model="form.provider"
            placeholder="例如 deepseek"
            :aria-invalid="Boolean(formError)"
            aria-describedby="form-error model-help"
          /><label for="model">模型 ID</label
          ><input
            id="model"
            v-model="form.model"
            placeholder="例如 deepseek-flash"
            :aria-invalid="Boolean(formError)"
            aria-describedby="form-error model-help"
          />
          <p id="model-help" class="hint">
            沿用本机 pi 凭据。每次发送固定当前模型，不可用时明确报错。
          </p></template
        ><template v-else
          ><label for="concurrency">全局并发上限</label
          ><input
            id="concurrency"
            v-model.number="form.concurrency"
            type="number"
            min="1"
            step="1"
          />
          <p class="hint">同一 Git 分支始终串行；等待回答的任务仍占名额。</p></template
        >
        <p id="form-error" class="form-error" role="alert">{{ formError }}</p>
        <div class="dialog-actions">
          <button type="button" @click="dialog = null">取消</button
          ><button
            type="submit"
            class="primary"
            :disabled="busy || client.connection.value !== 'connected'"
            :aria-busy="busy"
          >
            {{
              busy
                ? '正在保存…'
                : dialog === 'settings'
                  ? '保存设置'
                  : dialog === 'project'
                    ? '添加项目'
                    : '创建会话'
            }}
          </button>
        </div>
      </form></AppDialog
    >
  </div>
</template>
