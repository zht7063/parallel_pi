<script setup lang="ts">
import { ref, onBeforeUnmount, useId } from 'vue';
import type { CatalogModel, ModelChoice } from '@parallel-pi/contracts';
import type { WorkspaceClient } from '../workspace.ts';
const props = defineProps<{ client: WorkspaceClient; disabled?: boolean }>();
const emit = defineEmits<{ select: [value: ModelChoice] }>();
const models = ref<CatalogModel[] | null>(null),
  busy = ref(false),
  error = ref(''),
  selected = ref('');
const id = useId();
const controller = new AbortController();
async function load() {
  if (busy.value || props.disabled) return;
  busy.value = true;
  error.value = '';
  try {
    models.value = await props.client.request<CatalogModel[]>(
      '/api/models',
      undefined,
      controller.signal,
    );
    selected.value = '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '模型读取失败，请重试。';
  } finally {
    busy.value = false;
  }
}
function choose() {
  const value = models.value?.[Number(selected.value)];
  if (value?.available) emit('select', { provider: value.provider, model: value.model });
}
onBeforeUnmount(() => controller.abort());
</script>
<template>
  <div class="model-picker">
    <button type="button" :disabled="busy || disabled" :aria-busy="busy" @click="load">
      {{ busy ? '正在读取模型…' : '读取可用模型' }}
    </button>
    <p class="hint">读取 pi 内置与自定义模型目录。扩展注册的模型仍可填写 ID，发送前会再次核验。</p>
    <p class="form-error" role="alert">{{ error }}</p>
    <template v-if="models">
      <label :for="id">原生可用模型</label>
      <select :id="id" v-model="selected" :disabled="busy || disabled" @change="choose">
        <option value="" disabled>选择模型并填入表单</option>
        <option
          v-for="(item, index) in models"
          :key="`${item.provider}/${item.model}`"
          :value="String(index)"
          :disabled="!item.available"
        >
          {{ item.provider }} / {{ item.model }}{{ item.images ? ' · 支持图片' : ''
          }}{{ item.available ? '' : ' · 无可用凭据' }}
        </option>
      </select>
      <p v-if="!models.some((item) => item.available)" class="hint">
        暂无可用模型。请检查 provider 配置与凭据，再重新读取。
      </p>
    </template>
  </div>
</template>
<style scoped>
.model-picker {
  display: grid;
  gap: 8px;
}
.model-picker button {
  min-width: 140px;
}
.model-picker select {
  width: 100%;
  min-width: 0;
}
.model-picker p {
  margin: 0;
}
</style>
