<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import type { ConfigurationSnapshot } from '@parallel-pi/contracts';
import type { WorkspaceClient } from '../workspace.ts';
import AppDialog from './AppDialog.vue';
import ModelPicker from './ModelPicker.vue';
const props = defineProps<{ client: WorkspaceClient; concurrency: number }>();
const emit = defineEmits<{ close: [] }>();
const view = ref<ConfigurationSnapshot | null>(null);
const provider = ref(''),
  model = ref(''),
  keyProvider = ref(''),
  key = ref('');
const limit = ref(props.concurrency),
  showKey = ref(false),
  busy = ref(false),
  loading = ref(true);
const error = ref(''),
  notice = ref(''),
  removeProvider = ref('');
const invalid = ref('');
const controller = new AbortController();
const dirty = computed(
  () =>
    Boolean(key.value) ||
    limit.value !== props.concurrency ||
    Boolean(
      view.value &&
      (provider.value !== (view.value.defaults.provider ?? '') ||
        model.value !== (view.value.defaults.model ?? '')),
    ),
);
async function load() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const next = await props.client.request<ConfigurationSnapshot>(
      '/api/configuration',
      undefined,
      controller.signal,
    );
    if (!view.value) {
      provider.value = next.defaults.provider ?? '';
      model.value = next.defaults.model ?? '';
    } else notice.value = '已重新读取。你的输入已保留，请对照当前配置后再保存。';
    view.value = next;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取失败，请重试。';
  } finally {
    busy.value = false;
    loading.value = false;
  }
}
async function validation(id: string, message: string) {
  invalid.value = id;
  error.value = message;
  await nextTick();
  document.getElementById(id)?.focus();
}
async function save(kind: 'defaults' | 'credential' | 'concurrency', remove = false) {
  if (busy.value || (kind !== 'concurrency' && !view.value)) return;
  error.value = '';
  notice.value = '';
  invalid.value = '';
  if (kind === 'defaults' && (!provider.value.trim() || !model.value.trim()))
    return validation(
      !provider.value.trim() ? 'default-provider' : 'default-model',
      '填写 provider 和模型 ID。',
    );
  if (kind === 'credential' && !remove && (!keyProvider.value.trim() || !key.value.trim()))
    return validation(
      !keyProvider.value.trim() ? 'key-provider' : 'api-key',
      '填写 provider 和 API key。',
    );
  if (kind === 'concurrency' && (!Number.isInteger(limit.value) || limit.value < 1))
    return validation('settings-concurrency', '并发上限必须是正整数。');
  busy.value = true;
  try {
    if (kind === 'concurrency') {
      await props.client.command({ type: 'concurrency.set', value: limit.value });
    } else {
      const input =
        kind === 'defaults'
          ? {
              kind,
              revision: view.value!.settingsRevision,
              provider: provider.value.trim(),
              model: model.value.trim(),
            }
          : {
              kind,
              revision: view.value!.credentialsRevision,
              provider: remove ? removeProvider.value : keyProvider.value.trim(),
              key: remove ? null : key.value,
            };
      const next = await props.client.request<ConfigurationSnapshot>(
        '/api/configuration',
        input,
        controller.signal,
      );
      // Saving one file must not silently rebase an unsaved edit to the other.
      if (kind === 'defaults') {
        view.value = {
          ...view.value!,
          settingsRevision: next.settingsRevision,
          defaults: next.defaults,
        };
        provider.value = next.defaults.provider ?? '';
        model.value = next.defaults.model ?? '';
      }
      if (kind === 'credential') {
        view.value = {
          ...view.value!,
          credentialsRevision: next.credentialsRevision,
          credentials: next.credentials,
        };
        if (!remove) {
          key.value = '';
          showKey.value = false;
        }
        removeProvider.value = '';
      }
    }
    notice.value = '已保存。运行中和已排队任务的模型保持不变。';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败，输入已保留。';
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  void load();
});
onBeforeUnmount(() => {
  controller.abort();
  key.value = '';
});
</script>
<template>
  <AppDialog title="设置" :blocked="busy" :dirty="dirty" @close="emit('close')">
    <div class="settings-feedback">
      <p id="settings-error" class="form-error" role="alert">{{ error }}</p>
      <p role="status">{{ loading ? '正在读取本机配置…' : notice }}</p>
      <button type="button" :disabled="busy" @click="load">重新读取配置</button>
    </div>
    <form novalidate class="dialog-form settings-section" @submit.prevent="save('concurrency')">
      <h3>执行名额</h3>
      <label for="settings-concurrency">全局并发上限</label>
      <input
        id="settings-concurrency"
        v-model.number="limit"
        type="number"
        min="1"
        step="1"
        :disabled="busy"
        :aria-invalid="invalid === 'settings-concurrency'"
        aria-describedby="settings-error"
      />
      <p class="hint">同一 Git 分支始终串行；等待回答的任务仍占名额。</p>
      <button type="submit" :disabled="busy" :aria-busy="busy">保存执行设置</button>
    </form>
    <template v-if="view">
      <form novalidate class="dialog-form settings-section" @submit.prevent="save('defaults')">
        <h3>pi 全局默认模型</h3>
        <p class="hint">来源：本机 pi 全局配置。已有会话与已排队任务不随默认值变化。</p>
        <p class="mono">
          当前：{{ view.defaults.provider || '未设置' }} / {{ view.defaults.model || '未设置' }}
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
        <label for="default-provider">默认 provider</label>
        <input
          id="default-provider"
          v-model="provider"
          :disabled="busy"
          maxlength="256"
          :aria-invalid="invalid === 'default-provider'"
          aria-describedby="settings-error"
        />
        <label for="default-model">默认模型 ID</label>
        <input
          id="default-model"
          v-model="model"
          :disabled="busy"
          maxlength="256"
          :aria-invalid="invalid === 'default-model'"
          aria-describedby="settings-error"
        />
        <button type="submit" :disabled="busy" :aria-busy="busy">保存全局默认模型</button>
      </form>
      <section class="settings-section" aria-labelledby="credentials-title">
        <h3 id="credentials-title">Provider 凭据</h3>
        <p class="hint">沿用本机 pi 认证配置。只显示类型，不回显已有密钥。</p>
        <p v-if="!view.credentials.length" class="hint">尚未保存凭据。可在下方添加 API key。</p>
        <ul class="credential-list">
          <li v-for="item in view.credentials" :key="item.provider">
            <span>{{ item.provider }} · {{ item.type }}</span>
            <button
              type="button"
              :disabled="busy"
              :aria-label="`移除 ${item.provider} 凭据`"
              @click="removeProvider = item.provider"
            >
              移除
            </button>
          </li>
        </ul>
        <div v-if="removeProvider" class="warning" role="group" aria-label="确认移除凭据">
          <p>
            移除 {{ removeProvider }} 的本机凭据后，后续运行可能无法连接。已有任务不会换用其他模型。
          </p>
          <button type="button" :disabled="busy" @click="removeProvider = ''">保留凭据</button>
          <button type="button" :disabled="busy" @click="save('credential', true)">
            确认移除凭据
          </button>
        </div>
        <form novalidate class="dialog-form" @submit.prevent="save('credential')">
          <label for="key-provider">凭据 provider</label>
          <input
            id="key-provider"
            v-model="keyProvider"
            :disabled="busy"
            maxlength="256"
            autocomplete="off"
            :aria-invalid="invalid === 'key-provider'"
            aria-describedby="settings-error key-help"
          />
          <label for="api-key">API key</label>
          <input
            id="api-key"
            v-model="key"
            :disabled="busy"
            :type="showKey ? 'text' : 'password'"
            autocomplete="new-password"
            maxlength="16384"
            :aria-invalid="invalid === 'api-key'"
            aria-describedby="settings-error key-help"
          />
          <button type="button" :aria-pressed="showKey" @click="showKey = !showKey">
            {{ showKey ? '隐藏密钥' : '显示密钥' }}
          </button>
          <p id="key-help" class="hint">
            保存会替换该 provider 的原凭据。输入仅暂存在当前面板，保存成功或关闭后清除。
          </p>
          <button type="submit" :disabled="busy" :aria-busy="busy">保存 API key</button>
        </form>
      </section>
    </template>
  </AppDialog>
</template>
<style scoped>
.settings-section {
  border-top: 1px solid var(--border);
  margin-top: 20px;
  padding-top: 16px;
}
.settings-section h3 {
  margin: 0;
}
.settings-feedback > p {
  min-height: 24px;
  margin: 4px 0;
  overflow-wrap: anywhere;
}
.credential-list {
  list-style: none;
  padding: 0;
}
.credential-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 8px 0;
}
.credential-list span {
  overflow-wrap: anywhere;
  min-width: 0;
}
.settings-section button {
  min-height: 36px;
}
</style>
