<script setup lang="ts">
import { computed, onMounted, ref, nextTick } from 'vue';
import type { WorkspaceClient } from '../workspace.ts';
import type { ProjectConfigurationSnapshot } from '@parallel-pi/contracts';
import AppDialog from './AppDialog.vue';
import ModelPicker from './ModelPicker.vue';
const props = defineProps<{ client: WorkspaceClient; laneId: string; branch: string }>();
const emit = defineEmits<{ close: [] }>();
const view = ref<ProjectConfigurationSnapshot | null>(null);
const busy = ref(false),
  error = ref(''),
  notice = ref('');
const provider = ref(''),
  model = ref('');
const trust = ref('inherit');
const currentTrust = computed(() =>
  !view.value || view.value.decisionSource !== view.value.directory
    ? 'inherit'
    : view.value.decision
      ? 'trust'
      : 'deny',
);
const dirty = computed(() =>
  Boolean(
    view.value &&
    (provider.value !== (view.value.defaults.provider ?? '') ||
      model.value !== (view.value.defaults.model ?? '') ||
      trust.value !== currentTrust.value),
  ),
);
async function load() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const next = await props.client.command<ProjectConfigurationSnapshot>({
      type: 'project.configuration',
      laneId: props.laneId,
    });
    const initial = !view.value;
    view.value = next;
    if (initial) {
      provider.value = next.defaults.provider ?? '';
      model.value = next.defaults.model ?? '';
      trust.value = currentTrust.value;
    } else notice.value = '已读取当前配置。输入已保留，请对照后再保存。';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取失败，请重试。';
  } finally {
    busy.value = false;
  }
}
async function save(kind: 'defaults' | 'trust', clear = false) {
  if (busy.value || !view.value) return;
  if (kind === 'defaults' && !clear && (!provider.value.trim() || !model.value.trim())) {
    error.value = '填写工作区默认 provider 和模型 ID，或清除覆盖以沿用全局。';
    await nextTick();
    document.getElementById(!provider.value.trim() ? 'project-provider' : 'project-model')?.focus();
    return;
  }
  const selectedTrust = trust.value;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const next = await props.client.command<ProjectConfigurationSnapshot>(
      kind === 'defaults'
        ? {
            type: 'project.defaults',
            laneId: props.laneId,
            revision: view.value.settingsRevision,
            model: clear ? null : { provider: provider.value.trim(), model: model.value.trim() },
          }
        : {
            type: 'project.trust',
            laneId: props.laneId,
            revision: view.value.trustRevision,
            decision: trust.value === 'inherit' ? null : trust.value === 'trust',
          },
    );
    // Keep the other form's revision: a save must not approve an unrelated external edit.
    if (kind === 'defaults') {
      view.value = {
        ...next,
        trustRevision: view.value.trustRevision,
      };
      provider.value = next.defaults.provider ?? '';
      model.value = next.defaults.model ?? '';
    } else {
      view.value = {
        ...next,
        settingsRevision: view.value.settingsRevision,
      };
      trust.value = currentTrust.value;
    }
    notice.value =
      kind === 'trust' &&
      selectedTrust !== 'inherit' &&
      next.trusted !== (selectedTrust === 'trust')
        ? '已写入信任选择，但 pi 原生判定返回不同结果；请查看当前状态和来源。'
        : kind === 'defaults' && !next.trusted
          ? '已保存；项目资源尚未获信任，当前仍使用全局默认。'
          : '已保存；已有会话和已排队任务的模型不变。';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败，输入已保留。';
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>
<template>
  <AppDialog title="工作区设置" :blocked="busy" :dirty="dirty" @close="emit('close')">
    <p class="mono">{{ branch.replace('refs/heads/', '') }}</p>
    <p v-if="view" class="project-directory mono">{{ view.directory }}</p>
    <p class="hint">
      配置属于上方工作区。其他分支不自动同步。检查会准备工作区并加载 pi
      资源与信任扩展；不创建会话或发送消息。
    </p>
    <p id="project-settings-error" class="form-error" role="alert">{{ error }}</p>
    <p role="status">{{ busy ? '正在处理…' : notice }}</p>
    <button type="button" :disabled="busy" @click="load">重新读取工作区配置</button>
    <template v-if="view">
      <form novalidate class="dialog-form project-settings-section" @submit.prevent="save('trust')">
        <h3>项目资源信任</h3>
        <p>
          当前：{{ view.trusted ? '允许加载' : '不加载项目资源' }}<br />来源：{{
            view.trustSource === 'native'
              ? 'pi 原生信任判定（包含全局扩展）'
              : view.trustSource === 'global'
                ? 'pi 全局默认策略'
                : view.trustSource
          }}
        </p>
        <label for="project-trust">此工作区的信任选择</label>
        <select id="project-trust" v-model="trust" :disabled="busy">
          <option value="inherit">沿用父目录或全局策略</option>
          <option value="deny">不信任此工作区</option>
          <option value="trust">信任此工作区</option>
        </select>
        <p class="hint">
          信任后，pi 可以加载这里的 .pi
          设置、扩展和其他项目资源；扩展能够执行本机代码。这不是权限沙箱。
        </p>
        <button type="submit" :disabled="busy">
          {{ trust === 'trust' ? '确认信任此工作区' : '保存信任选择' }}
        </button>
      </form>
      <form
        novalidate
        class="dialog-form project-settings-section"
        @submit.prevent="save('defaults')"
      >
        <h3>新会话默认模型</h3>
        <p class="hint">
          来源：{{
            view.trusted
              ? '受信任的 .pi/settings.json；缺省字段沿用全局'
              : 'pi 全局配置（项目配置未启用）'
          }}。
        </p>
        <p class="mono">
          当前有效：{{ view.effective.provider || '未设置' }} /
          {{ view.effective.model || '未设置' }}
        </p>
        <p class="mono">
          文件中：{{ view.defaults.provider || '沿用全局' }} /
          {{ view.defaults.model || '沿用全局' }}
        </p>
        <ModelPicker
          :client="client"
          :disabled="busy"
          @select="
            (value) => {
              provider = value.provider;
              model = value.model;
            }
          "
        />
        <label for="project-provider">工作区默认 provider</label>
        <input
          id="project-provider"
          v-model="provider"
          :disabled="busy"
          maxlength="256"
          :aria-invalid="Boolean(error)"
          aria-describedby="project-settings-error"
        />
        <label for="project-model">工作区默认模型 ID</label>
        <input
          id="project-model"
          v-model="model"
          :disabled="busy"
          maxlength="256"
          :aria-invalid="Boolean(error)"
          aria-describedby="project-settings-error"
        />
        <button type="submit" :disabled="busy">保存工作区默认模型</button>
        <button type="button" :disabled="busy" @click="save('defaults', true)">
          清除覆盖，沿用全局模型
        </button>
      </form>
    </template>
  </AppDialog>
</template>
<style scoped>
.project-directory {
  overflow-wrap: anywhere;
}
.project-settings-section {
  border-top: 1px solid var(--border);
  margin-top: 20px;
  padding-top: 16px;
}
.project-settings-section p {
  overflow-wrap: anywhere;
}
.project-settings-section h3 {
  margin: 0;
}
</style>
