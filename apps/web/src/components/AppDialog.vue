<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
const props = defineProps<{ title: string; blocked?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
let previous: HTMLElement | null = null;
onMounted(() => {
  previous = document.activeElement as HTMLElement;
  dialog.value?.showModal();
});
onBeforeUnmount(() => {
  dialog.value?.close();
  previous?.focus();
});
</script>
<template>
  <dialog
    ref="dialog"
    aria-labelledby="dialog-title"
    @cancel.prevent="!props.blocked && emit('close')"
  >
    <div class="dialog-heading">
      <h2 id="dialog-title">{{ title }}</h2>
      <button type="button" aria-label="关闭面板" :disabled="blocked" @click="emit('close')">
        关闭
      </button>
    </div>
    <slot />
  </dialog>
</template>
