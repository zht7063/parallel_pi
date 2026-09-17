<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useWorkspace, isActive } from './workspace.ts';
import { useDrafts } from './drafts.ts';
import AppDialog from './components/AppDialog.vue';
import ModelPicker from './components/ModelPicker.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import ProjectSettingsDialog from './components/ProjectSettingsDialog.vue';
import Conversation from './components/Conversation.vue';
import type { WorkspaceSnapshot, ProjectConfigurationSnapshot } from '@parallel-pi/contracts';
import ProjectMap from './components/ProjectMap.vue';
import MapThumbnail from './components/MapThumbnail.vue';
const client = useWorkspace(),
  drafts = useDrafts(client);
const data = client.snapshot;
const mapOpen = ref(false),
  projectsOpen = ref(false);
const mapCloseButton = ref<HTMLButtonElement | null>(null);
const globalMap = ref<InstanceType<typeof ProjectMap> | null>(null),
  overlayMap = ref<InstanceType<typeof ProjectMap> | null>(null);
let mapTrigger: HTMLElement | null = null;
async function openMap() {
  if (mapOpen.value) return;
  mapTrigger = document.activeElement as HTMLElement;
  mapOpen.value = true;
  await nextTick();
  mapCloseButton.value?.focus();
}
function closeMap() {
  mapOpen.value = false;
  mapTrigger?.focus();
}
function escapeMap(event: KeyboardEvent) {
  if (event.key !== 'Escape' || dialog.value || event.isComposing) return;
  if (projectsOpen.value) {
    projectsOpen.value = false;
    document.querySelector<HTMLElement>('.projects-toggle')?.focus();
    return;
  }
  if ((mapOpen.value ? overlayMap.value : globalMap.value)?.closeTop()) {
    event.preventDefault();
    return;
  }
  if (mapOpen.value) {
    event.preventDefault();
    closeMap();
  }
}
const sessionConfigLoading = ref(false),
  sessionModelSource = ref('');
const selectedProject = ref(''),
  activeSession = ref(''),
  preview = ref('');
const dialog = ref<
    'project' | 'session' | 'settings' | 'project-settings' | 'model' | 'branch' | 'fork' | null
  >(null),
  busy = ref(false),
  commandBusy = ref(false),
  formError = ref('');
const form = reactive({
  directory: '',
  title: '',
  laneId: '',
  provider: '',
  model: '',
  requestId: '',
  parentSessionId: '',
  forkEntryId: '',
  branchName: '',
  startRef: '',
  track: false,
});
const project = computed(() =>
  data.value?.projects.find((item) => item.id === selectedProject.value),
);
const lanes = computed(
  () => data.value?.lanes.filter((item) => item.projectId === project.value?.id) ?? [],
);
function openBranch(remote?: { ref: string; name: string }) {
  const selected =
    lanes.value.find((lane) => lane.id === previewSession.value?.laneId) ?? lanes.value[0];
  if (!selected) return;
  open('branch', selected.id);
  form.branchName = remote?.name ?? '';
  form.startRef = remote?.ref ?? selected.ref;
  form.track = Boolean(remote);
}
const session = computed(() =>
  data.value?.sessions.find((item) => item.id === activeSession.value),
);
const sessionLane = computed(() =>
  data.value?.lanes.find((item) => item.id === session.value?.laneId),
);
const previewSession = computed(() =>
  data.value?.sessions.find((item) => item.id === preview.value),
);
const forkSource = computed(() =>
  data.value?.sessions.find((item) => item.id === form.parentSessionId),
);
const chosenForkPoint = ref<WorkspaceSnapshot['sessions'][number]['messages'][number] | null>(null);
const forkPoint = computed(
  () =>
    forkSource.value?.messages.find((message) => message.id === form.forkEntryId) ??
    chosenForkPoint.value,
);
function openFork(message: WorkspaceSnapshot['sessions'][number]['messages'][number]) {
  if (!session.value) return;
  open('fork', session.value.laneId, session.value.id);
  form.forkEntryId = message.id;
  chosenForkPoint.value = message;
}
function restoreSession(projectId: string) {
  let stored = '';
  try {
    stored = localStorage.getItem(`parallel_pi.view.${projectId}`) ?? '';
  } catch {}
  const laneIds = new Set(
    data.value?.lanes.filter((lane) => lane.projectId === projectId).map((lane) => lane.id),
  );
  return data.value?.sessions.some(
    (item) => item.id === stored && item.state === 'ready' && laneIds.has(item.laneId),
  )
    ? stored
    : '';
}
function chooseProject(id: string) {
  projectsOpen.value = false;
  selectedProject.value = id;
  activeSession.value = restoreSession(id);
  preview.value = '';
  mapOpen.value = false;
  try {
    localStorage.setItem('parallel_pi.project', id);
  } catch {}
}
function enter(id: string) {
  if (data.value?.sessions.find((item) => item.id === id)?.state !== 'ready') return false;
  activeSession.value = id;
  mapOpen.value = false;
  void nextTick(() => document.querySelector<HTMLElement>('.conversation-heading h2')?.focus());
  preview.value = '';
  try {
    localStorage.setItem(`parallel_pi.view.${selectedProject.value}`, id);
  } catch {}
  return true;
}
function back() {
  projectsOpen.value = false;
  mapOpen.value = false;
  activeSession.value = '';
  try {
    localStorage.removeItem(`parallel_pi.view.${selectedProject.value}`);
  } catch {}
}
function open(
  type: 'project' | 'session' | 'settings' | 'project-settings' | 'model' | 'branch' | 'fork',
  laneId = '',
  parentSessionId = '',
) {
  projectsOpen.value = false;
  formError.value = '';
  dialog.value = type;
  form.laneId = laneId;
  form.parentSessionId = parentSessionId;
  form.title = '';
  form.requestId = crypto.randomUUID();
  if (type === 'model') {
    const current = data.value?.sessions.find((item) => item.id === parentSessionId);
    form.provider = current?.model.provider ?? '';
    form.model = current?.model.model ?? '';
  }
  if (type === 'session') {
    sessionConfigLoading.value = true;
    sessionModelSource.value = '';
    form.provider = '';
    form.model = '';
    const requestId = form.requestId;
    void client
      .command<ProjectConfigurationSnapshot>({ type: 'project.configuration', laneId })
      .then((value) => {
        if (dialog.value !== 'session' || form.requestId !== requestId) return;
        sessionModelSource.value =
          value.trusted && (value.defaults.provider || value.defaults.model)
            ? '工作区 .pi/settings.json（缺省字段沿用全局）'
            : 'pi 全局默认';
        if (!form.provider && !form.model) {
          form.provider = value.effective.provider ?? '';
          form.model = value.effective.model ?? '';
        }
      })
      .catch((cause) => {
        if (dialog.value === 'session' && form.requestId === requestId)
          formError.value = cause instanceof Error ? cause.message : '无法读取工作区配置。';
      })
      .finally(() => {
        if (form.requestId === requestId) sessionConfigLoading.value = false;
      });
  }
}
async function submit() {
  if (busy.value) return;
  if (dialog.value === 'project' && !form.directory.trim()) {
    formError.value = '请输入本机 Git 项目目录。';
    await nextTick();
    document.getElementById('project-directory')?.focus();
    return;
  }
  if (
    (dialog.value === 'session' || dialog.value === 'model') &&
    (!form.provider.trim() || !form.model.trim())
  ) {
    formError.value = '请填写 provider 和模型 ID；凭据沿用本机 pi 配置。';
    await nextTick();
    document.getElementById(!form.provider.trim() ? 'provider' : 'model')?.focus();
    return;
  }
  if (dialog.value === 'branch' && (!form.branchName.trim() || !form.startRef)) {
    formError.value = '请填写分支名称并选择起点。';
    await nextTick();
    document.getElementById('branch-name')?.focus();
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
    } else if (dialog.value === 'model') {
      await client.command({
        type: 'session.model',
        sessionId: form.parentSessionId,
        model: { provider: form.provider.trim(), model: form.model.trim() },
      });
    } else if (dialog.value === 'session') {
      const result = await client.command<{ id: string }>({
        type: 'session.create',
        laneId: form.laneId,
        title: form.title,
        requestId: form.requestId,
        ...(form.parentSessionId ? { parentSessionId: form.parentSessionId } : {}),
        model: { provider: form.provider.trim(), model: form.model.trim() },
      });
      if (!enter(result.id)) throw new Error('会话创建尚未确认，请先核验分支恢复。输入已保留。');
    } else if (dialog.value === 'fork') {
      const result = await client.command<{ id: string }>({
        type: 'session.fork',
        sessionId: form.parentSessionId,
        entryId: form.forkEntryId,
        title: form.title,
        requestId: form.requestId,
      });
      if (!enter(result.id)) throw new Error('会话创建尚未确认，请先核验分支恢复。输入已保留。');
    } else if (dialog.value === 'branch') {
      await client.command({
        type: 'branch.create',
        requestId: form.requestId,
        laneId: form.laneId,
        name: form.branchName.trim(),
        startRef: form.startRef,
        track: form.track,
      });
    }
    dialog.value = null;
  } catch (cause) {
    formError.value = cause instanceof Error ? cause.message : '操作失败，输入已保留。';
  } finally {
    busy.value = false;
  }
}
async function command(input: unknown) {
  if (commandBusy.value) return;
  commandBusy.value = true;
  client.error.value = '';
  try {
    await client.command(input);
  } catch (cause) {
    client.error.value = cause instanceof Error ? cause.message : '操作失败';
  } finally {
    commandBusy.value = false;
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
watch(data, (value) => {
  if (!selectedProject.value && value?.projects.length) {
    let stored = '';
    try {
      stored = localStorage.getItem('parallel_pi.project') ?? '';
    } catch {}
    selectedProject.value = value.projects.some((item) => item.id === stored)
      ? stored
      : value.projects[0]!.id;
    activeSession.value = restoreSession(selectedProject.value);
  }
});
onMounted(() => {
  window.addEventListener('keydown', escapeMap);
  void client.connect();
});
onBeforeUnmount(() => window.removeEventListener('keydown', escapeMap));
</script>
<template>
  <div class="shell">
    <aside
      id="project-sidebar"
      class="sidebar"
      :class="{ 'projects-open': projectsOpen }"
      aria-label="项目导航"
    >
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
          <button
            class="projects-toggle"
            type="button"
            :aria-expanded="projectsOpen"
            aria-controls="project-sidebar"
            @click="projectsOpen = !projectsOpen"
          >
            {{ projectsOpen ? '关闭项目' : '项目' }}
          </button>
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
          <button
            v-if="project && !session"
            type="button"
            :disabled="commandBusy || client.connection.value !== 'connected'"
            @click="openBranch()"
          >
            新建 Git 分支
          </button>
          <button
            v-if="project && !session"
            type="button"
            :disabled="commandBusy || !lanes.length || client.connection.value !== 'connected'"
            :aria-busy="commandBusy"
            @click="command({ type: 'project.fetch', laneId: lanes[0]?.id })"
          >
            刷新远端
          </button>
        </div>
      </header>
      <div v-if="client.error.value" class="error global-error" role="alert">
        {{ client.error.value }}
      </div>
      <section v-if="session && sessionLane && data && project" class="focus-workspace">
        <nav class="map-navigation" aria-label="会话地图导航">
          <MapThumbnail
            :snapshot="data"
            :project-id="project.id"
            :active-session="session.id"
            :expanded="mapOpen"
            @open="openMap"
            @back="back"
          />
          <button
            type="button"
            :aria-expanded="mapOpen"
            aria-controls="session-map-panel"
            @click="openMap"
          >
            查看地图
          </button>
          <button type="button" @click="back">← 返回全局地图</button>
        </nav>
        <div class="focus-body">
          <Conversation
            :key="session.id"
            :session="session"
            :lane="sessionLane"
            :client="client"
            :drafts="drafts"
            @fork="openFork"
            @model="open('model', session.laneId, session.id)"
          />
          <section
            v-if="mapOpen"
            id="session-map-panel"
            class="map-overlay"
            aria-label="会话中的项目地图"
          >
            <div class="map-overlay-heading">
              <h2>项目地图</h2>
              <button ref="mapCloseButton" type="button" @click="closeMap">关闭地图</button>
            </div>
            <ProjectMap
              ref="overlayMap"
              :key="`${project.id}-overlay`"
              :snapshot="data"
              :project-id="project.id"
              scope="overlay"
              :active-session="session.id"
              :connected="client.connection.value === 'connected'"
              :busy="commandBusy"
              @enter="enter"
              @create="(laneId, parentId) => open('session', laneId, parentId)"
              @command="command"
              @remote="openBranch"
              @settings="(laneId) => open('project-settings', laneId)"
            />
          </section>
        </div>
      </section>
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
      <section v-else class="map-area" aria-label="项目工作台">
        <div class="map-caption">
          <h2>分支地图</h2>
          <span>全局并发 {{ data?.concurrency }} · 选择会话预览，双击或通过按钮进入</span>
        </div>
        <ProjectMap
          ref="globalMap"
          v-if="data"
          :key="`${project.id}-global`"
          :snapshot="data"
          :project-id="project.id"
          scope="global"
          :connected="client.connection.value === 'connected'"
          :busy="commandBusy"
          @select="preview = $event"
          @enter="enter"
          @create="(laneId, parentId) => open('session', laneId, parentId)"
          @command="command"
          @remote="openBranch"
          @settings="(laneId) => open('project-settings', laneId)"
        />
      </section>
    </main>
    <ProjectSettingsDialog
      v-if="dialog === 'project-settings'"
      :client="client"
      :lane-id="form.laneId"
      :branch="data?.lanes.find((item) => item.id === form.laneId)?.ref ?? ''"
      @close="dialog = null"
    />
    <SettingsDialog
      v-else-if="dialog === 'settings'"
      :client="client"
      :concurrency="data?.concurrency ?? 2"
      @close="dialog = null"
    />
    <AppDialog
      v-else-if="dialog"
      :title="
        dialog === 'model'
          ? '切换会话模型'
          : dialog === 'fork'
            ? '从历史消息分叉'
            : dialog === 'project'
              ? '添加本机项目'
              : dialog === 'session'
                ? form.parentSessionId
                  ? '新建接续会话'
                  : '新建独立会话'
                : dialog === 'branch'
                  ? form.track
                    ? '拉取远端分支到本地'
                    : '新建 Git 分支'
                  : '新建 Git 分支'
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
        ><template v-else-if="dialog === 'session' || dialog === 'model'"
          ><p v-if="dialog === 'session' && form.parentSessionId" class="hint">
            接续自“{{
              data?.sessions.find((item) => item.id === form.parentSessionId)?.title
            }}”。建立新上下文，不复制聊天或自动运行；使用当前代码。
          </p>
          <template v-if="dialog === 'session'"
            ><label for="session-title">会话标题</label
            ><input
              id="session-title"
              v-model="form.title"
              autofocus
              placeholder="描述这条思路"
              maxlength="200" /></template
          ><ModelPicker
            :client="client"
            :disabled="busy"
            @select="
              (value) => {
                form.provider = value.provider;
                form.model = value.model;
              }
            "
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
            {{
              dialog === 'model'
                ? '仅作用于此会话下一次发送。运行中和已排队任务保持原模型'
                : sessionConfigLoading
                  ? '正在读取工作区默认模型…'
                  : `初始来源：${sessionModelSource || '尚未设置'}`
            }}。可在这里修改；每次发送固定当前模型，不可用时明确报错。
          </p></template
        ><template v-else-if="dialog === 'fork'">
          <p>来源会话：{{ forkSource?.title }}</p>
          <p id="fork-help" class="hint">
            继承这条消息之前的历史。下方消息及图片会放入新会话草稿，等待你编辑并发送；不会自动执行。使用当前代码，不回滚工作区。
          </p>
          <blockquote class="message-text">{{ forkPoint?.text || '图片消息' }}</blockquote>
          <p v-if="forkPoint?.images.length" class="hint">
            包含 {{ forkPoint.images.length }} 张图片。
          </p>
          <p class="hint">
            初始模型：{{ forkSource?.model.provider }} /
            {{ forkSource?.model.model }}；进入后可修改。
          </p>
          <label for="fork-title">分叉会话标题</label>
          <input
            id="fork-title"
            v-model="form.title"
            maxlength="200"
            autofocus
            aria-describedby="fork-help form-error"
            placeholder="描述新的思路"
          /> </template
        ><template v-else-if="dialog === 'branch'">
          <label for="branch-name">本地分支名称</label
          ><input
            id="branch-name"
            v-model="form.branchName"
            autofocus
            maxlength="256"
            :aria-invalid="Boolean(formError)"
            aria-describedby="form-error branch-help"
          />
          <p v-if="form.track" class="mono">
            来源：{{ form.startRef.replace('refs/remotes/', '') }}
          </p>
          <template v-else
            ><label for="branch-start">起点分支</label
            ><select id="branch-start" v-model="form.startRef">
              <option v-for="lane in lanes" :key="lane.id" :value="lane.ref">
                {{ lane.ref.replace('refs/heads/', '') }}
              </option>
            </select></template
          >
          <p id="branch-help" class="hint">
            {{
              form.track
                ? '先获取所选远端，再创建跟踪分支；不合并到当前分支。'
                : '从起点的已提交 HEAD 创建；未提交改动不会复制。'
            }}当前工作区不会切换。名称冲突时可使用已有分支，或修改名称。
          </p>
        </template>
        <p id="form-error" class="form-error" role="alert">{{ formError }}</p>
        <div class="dialog-actions">
          <button type="button" :disabled="busy" @click="dialog = null">取消</button
          ><button
            type="submit"
            class="primary"
            :disabled="
              busy ||
              (dialog === 'session' && sessionConfigLoading) ||
              client.connection.value !== 'connected'
            "
            :aria-busy="busy"
          >
            {{
              busy
                ? '正在保存…'
                : dialog === 'model'
                  ? '保存会话模型'
                  : dialog === 'fork'
                    ? '创建分叉会话'
                    : dialog === 'branch'
                      ? '创建本地分支'
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
