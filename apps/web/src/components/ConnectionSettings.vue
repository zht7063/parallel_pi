<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ConnectionsSnapshot } from '@parallel-pi/contracts';
import type { WorkspaceClient } from '../workspace.ts';
const props = defineProps<{ client: WorkspaceClient; disabled: boolean }>();
const emit = defineEmits<{ dirty: [value: boolean]; busy: [value: boolean] }>();
const view = ref<ConnectionsSnapshot | null>(null);
const selected = ref(''),
  provider = ref(''),
  baseUrl = ref(''),
  api = ref('openai-completions');
const existingModel = ref('');
const model = ref(''),
  images = ref(false),
  busy = ref(false),
  error = ref(''),
  notice = ref('');
const remove = ref(false),
  discard = ref(false),
  invalid = ref('');
const controller = new AbortController();
const draft = () =>
  JSON.stringify([provider.value, baseUrl.value, api.value, model.value, images.value]);
const baseline = ref(draft());
const dirty = computed(() => draft() !== baseline.value);
const disabled = computed(() => props.disabled || busy.value);
const current = computed(() =>
  view.value?.providers.find((item) => item.provider === selected.value),
);
watch(dirty, (value) => emit('dirty', value), { immediate: true });
watch(busy, (value) => emit('busy', value), { immediate: true });
function choose() {
  provider.value = selected.value;
  baseUrl.value = current.value?.baseUrl ?? '';
  api.value = current.value?.api ?? (selected.value ? '' : 'openai-completions');
  model.value = '';
  existingModel.value = '';
  images.value = false;
  remove.value = false;
  discard.value = false;
  baseline.value = draft();
}
async function load() {
  if (disabled.value) return;
  busy.value = true;
  error.value = '';
  try {
    const next = await props.client.request<ConnectionsSnapshot>(
      '/api/connections',
      undefined,
      controller.signal,
    );
    notice.value = view.value ? '已重新读取连接。输入已保留，请对照当前值再保存。' : '';
    view.value = next;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取连接失败，请重试。';
  } finally {
    busy.value = false;
  }
}
async function validation(id: string, message: string) {
  invalid.value = id;
  error.value = message;
  await nextTick();
  document.getElementById(id)?.focus();
}
async function save(deleting = false) {
  if (disabled.value || !view.value) return;
  error.value = '';
  notice.value = '';
  invalid.value = '';
  if (!deleting) {
    if (!provider.value.trim()) return validation('connection-provider', '填写 provider ID。');
    if (!selected.value && !baseUrl.value.trim())
      return validation('connection-url', '新连接需要服务地址。');
    if (!selected.value && !model.value.trim())
      return validation('connection-model', '新连接需要模型 ID。');
  }
  busy.value = true;
  try {
    view.value = await props.client.request<ConnectionsSnapshot>(
      '/api/connections',
      {
        revision: view.value.revision,
        provider: provider.value.trim(),
        remove: deleting,
        ...(!deleting && baseUrl.value.trim() ? { baseUrl: baseUrl.value.trim() } : {}),
        ...(!deleting &&
        api.value &&
        ['openai-completions', 'openai-responses', 'anthropic-messages'].includes(api.value)
          ? { api: api.value }
          : {}),
        ...(!deleting && model.value.trim()
          ? { model: { id: model.value.trim(), images: images.value } }
          : {}),
      },
      controller.signal,
    );
    selected.value = deleting ? '' : provider.value.trim();
    choose();
    notice.value = deleting
      ? '已移除自定义连接。单独保存的凭据仍保留。'
      : '连接已保存。可重新读取可用模型；此操作未测试网络连接。';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存连接失败，输入已保留。';
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  void load();
});
onBeforeUnmount(() => controller.abort());
</script>
<template>
  <section class="connection-settings" aria-labelledby="connections-title">
    <h3 id="connections-title">自定义 Provider 连接</h3>
    <p class="hint">
      修改本机 pi 连接配置。凭据在下方单独保存；已有模型的其他参数与兼容选项会保留。
    </p>
    <p id="connections-error" class="form-error" role="alert">{{ error }}</p>
    <p aria-live="polite">{{ busy ? '正在处理连接配置…' : notice }}</p>
    <button type="button" :disabled="disabled" @click="load">重新读取连接</button>
    <template v-if="view">
      <p v-if="!view.providers.length" class="hint">尚无自定义连接，可在下方添加。</p>
      <form class="dialog-form" novalidate @submit.prevent="save()">
        <label for="connection-choice">编辑连接</label>
        <select
          id="connection-choice"
          v-model="selected"
          :disabled="disabled || dirty"
          @change="choose"
        >
          <option value="">添加新连接</option>
          <option v-for="item in view.providers" :key="item.provider" :value="item.provider">
            {{ item.provider }}
          </option>
        </select>
        <p v-if="dirty" class="hint">保存或放弃当前修改后，可以切换连接。</p>
        <p v-if="current" class="mono">
          当前地址：{{
            current.baseUrl || (current.hiddenBaseUrl ? '已配置（含私密部分，不回显）' : '原生默认')
          }}
          · API：{{ current.api || '原生默认' }}
        </p>
        <p v-if="current?.hasInlineCredential" class="hint">
          此连接已有内联认证配置，会原样保留；它可能影响下方单独保存的 API key 是否生效。
        </p>
        <label for="connection-provider">连接 provider ID</label>
        <input
          id="connection-provider"
          v-model="provider"
          :disabled="disabled || Boolean(selected)"
          maxlength="256"
          :aria-invalid="invalid === 'connection-provider'"
          aria-describedby="connections-error"
        />
        <label for="connection-url">服务地址（Base URL）</label>
        <input
          id="connection-url"
          v-model="baseUrl"
          :disabled="disabled"
          maxlength="2048"
          type="url"
          :aria-invalid="invalid === 'connection-url'"
          aria-describedby="connections-error connection-help"
        />
        <label for="connection-api">API 格式</label>
        <select id="connection-api" v-model="api" :disabled="disabled">
          <option value="">保留现有配置 / 原生默认</option>
          <option value="openai-completions">OpenAI Chat Completions</option>
          <option value="openai-responses">OpenAI Responses</option>
          <option value="anthropic-messages">Anthropic Messages</option>
          <option
            v-if="
              api && !['openai-completions', 'openai-responses', 'anthropic-messages'].includes(api)
            "
            :value="api"
          >
            {{ api }}（保留）
          </option>
        </select>
        <template v-if="current?.models.length">
          <label for="connection-existing-model">读取已有模型到表单</label>
          <select
            id="connection-existing-model"
            v-model="existingModel"
            :disabled="disabled"
            @change="
              (event) => {
                const item = current?.models.find(
                  (value) => value.id === (event.target as HTMLSelectElement).value,
                );
                if (item) {
                  model = item.id;
                  images = item.images;
                }
              }
            "
          >
            <option value="">选择模型</option>
            <option v-for="item in current.models" :key="item.id" :value="item.id">
              {{ item.id }}
            </option>
          </select>
        </template>
        <label for="connection-model">添加或更新模型 ID</label>
        <input
          id="connection-model"
          v-model="model"
          :disabled="disabled"
          maxlength="256"
          :aria-invalid="invalid === 'connection-model'"
          aria-describedby="connections-error connection-help"
        />
        <label class="connection-images"
          ><input
            v-model="images"
            type="checkbox"
            :disabled="disabled || !model.trim()"
          />此模型支持图片输入</label
        >
        <p id="connection-help" class="hint">
          地址限 HTTP/HTTPS，不含账号、查询参数或片段。编辑时留空保留原值；模型 ID
          留空不修改模型。已有模型单独设置的地址与 API
          格式仍优先使用。保存会移除配置文件中的注释并统一缩进。
        </p>
        <button type="submit" :disabled="disabled" :aria-busy="busy">保存连接</button>
        <button v-if="dirty" type="button" :disabled="disabled" @click="discard = true">
          放弃连接修改
        </button>
        <button v-if="selected" type="button" :disabled="disabled || dirty" @click="remove = true">
          移除此自定义连接
        </button>
      </form>
      <div v-if="discard" class="warning" role="group" aria-label="确认放弃连接修改">
        <p>放弃当前连接表单中的未保存修改？</p>
        <button type="button" :disabled="disabled" @click="discard = false">继续修改连接</button>
        <button type="button" :disabled="disabled" @click="choose">确认放弃连接修改</button>
      </div>
      <div v-if="remove" class="warning" role="group" aria-label="确认移除连接">
        <p>
          移除 {{ selected }} 的自定义连接及其中模型和内联认证配置？已有会话的模型 ID
          不变，后续运行可能不可用；内置 provider 会恢复原生配置。
        </p>
        <button type="button" :disabled="disabled" @click="remove = false">保留连接</button>
        <button type="button" :disabled="disabled" @click="save(true)">确认移除连接</button>
      </div>
    </template>
  </section>
</template>
<style scoped>
.connection-settings {
  border-top: 1px solid var(--border);
  margin-top: 20px;
  padding-top: 16px;
}
.connection-settings h3 {
  margin: 0;
}
.connection-settings p {
  overflow-wrap: anywhere;
}
.connection-images {
  display: flex;
  align-items: center;
  gap: 8px;
}
.connection-images input {
  width: auto;
}
</style>
