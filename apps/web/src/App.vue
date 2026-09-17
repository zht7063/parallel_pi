<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { ServiceStatus } from '@parallel-pi/contracts';

const status = ref<ServiceStatus | null>(null);
const loading = ref(false);
const error = ref('');
async function connect() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    const session = await fetch('/api/session', { signal: AbortSignal.timeout(10000) });
    if (!session.ok) throw new Error('无法建立本地连接，请使用启动时显示的地址。');
    const response = await fetch('/api/status', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('服务暂时不可用，请检查后端并重试。');
    status.value = await response.json();
  } catch (cause) {
    status.value = null;
    error.value = cause instanceof Error ? cause.message : '连接失败，请重试。';
  } finally {
    loading.value = false;
  }
}
onMounted(connect);
</script>

<template>
  <div class="shell">
    <aside aria-label="项目导航">
      <span class="wordmark">p<span>∥</span>pi</span><span class="nav-note">分支工作台</span>
    </aside>
    <main>
      <header>
        <h1>parallel_pi</h1>
        <span role="status">{{
          loading ? '正在连接…' : status ? '本地服务已连接' : '连接未就绪'
        }}</span>
      </header>
      <section class="empty" aria-labelledby="workspace-heading">
        <div class="branch-mark" aria-hidden="true">┬ ┬ ┬</div>
        <h2 id="workspace-heading">工作台已就绪</h2>
        <p>项目与会话功能正在接入，当前可检查本地服务连接。</p>
        <p v-if="status">全局并发上限：{{ status.concurrency }} · 同一分支串行执行</p>
        <p v-if="error" role="alert">{{ error }}</p>
        <button type="button" :disabled="loading" :aria-busy="loading" @click="connect">
          重新连接
        </button>
      </section>
    </main>
  </div>
</template>
