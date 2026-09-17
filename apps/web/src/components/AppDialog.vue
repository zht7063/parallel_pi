<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, nextTick } from 'vue';
const props = defineProps<{ title: string; blocked?: boolean; dirty?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
let previous: HTMLElement | null = null;
const confirmClose = ref(false);
function close() {
  if (props.blocked) return;
  if (!props.dirty) {
    emit('close');
    return;
  }
  confirmClose.value = true;
  void nextTick(() =>
    dialog.value?.querySelector<HTMLButtonElement>('[data-keep-editing]')?.focus(),
  );
}
function unload(event: BeforeUnloadEvent) {
  if (props.dirty || props.blocked) event.preventDefault();
}
onMounted(() => {
  window.addEventListener('beforeunload', unload);
  previous = document.activeElement as HTMLElement;
  dialog.value?.showModal();
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', unload);
  dialog.value?.close();
  previous?.focus();
});
</script>
<template>
  <dialog ref="dialog" aria-labelledby="dialog-title" @cancel.prevent="close">
    <div class="dialog-heading">
      <h2 id="dialog-title">{{ title }}</h2>
      <button type="button" aria-label="关闭面板" :disabled="blocked" @click="close">关闭</button>
    </div>
    <div v-if="confirmClose" class="warning" role="group" aria-label="放弃未保存修改">
      <p>关闭会丢弃尚未保存的输入。</p>
      <button type="button" data-keep-editing @click="confirmClose = false">继续编辑</button>
      <button type="button" @click="emit('close')">放弃修改并关闭</button>
    </div>
    <slot />
  </dialog>
</template>
