<script setup lang="ts">
import { computed, onMounted, ref, nextTick } from 'vue';
import type { MemorySnapshot, MemoryQuery, WorkspaceSnapshot } from '@parallel-pi/contracts';
import type { WorkspaceClient } from '../workspace.ts';
import AppDialog from './AppDialog.vue';
const props = defineProps<{
  client: WorkspaceClient;
  laneId: string;
  jobs: WorkspaceSnapshot['memoryChanges'];
}>();
const emit = defineEmits<{ close: [] }>();
const view = ref<MemorySnapshot | null>(null);
const busy = ref(false),
  error = ref(''),
  notice = ref(''),
  invalid = ref('');
const gitMode = ref('track'),
  queryText = ref(''),
  path = ref(''),
  offset = ref(0);
const appliedQuery = ref<MemoryQuery | undefined>();
const selected = ref(''),
  summary = ref(''),
  body = ref(''),
  status = ref(''),
  scope = ref('{}');
const baseline = ref(''),
  discard = ref(false),
  continueId = ref('');
const intent = ref<{ requestId: string; change: unknown } | null>(null);
const draft = () => JSON.stringify([summary.value, body.value, status.value, scope.value]);
const dirty = computed(
  () => Boolean(intent.value) || Boolean(selected.value && baseline.value !== draft()),
);
const pending = computed(() =>
  props.jobs.filter((job) => ['pending', 'failed'].includes(job.state)),
);
function fill() {
  const record = view.value?.record;
  summary.value = record?.summary ?? '';
  body.value = record?.body ?? '';
  status.value = record?.status ?? '';
  scope.value = JSON.stringify(record?.scope ?? {}, null, 2);
  baseline.value = draft();
  discard.value = false;
}
async function read(recordId = selected.value, page = offset.value, preserve = true) {
  view.value = (await props.client.command({
    type: 'memory.inspect',
    laneId: props.laneId,
    recordId: recordId || undefined,
    offset: page,
    query: appliedQuery.value,
  })) as MemorySnapshot;
  selected.value = recordId;
  offset.value = page;
  if (!preserve || !baseline.value) fill();
}
async function load(recordId = selected.value, page = offset.value, preserve = true) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await read(recordId, page, preserve);
    if (preserve && dirty.value) notice.value = '已重新读取；修改输入已保留，请对照当前版本。';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取记忆失败，请重试。';
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
async function save(initializing = false) {
  if (busy.value) return;
  error.value = '';
  invalid.value = '';
  notice.value = '';
  if (!intent.value) {
    if (initializing)
      intent.value = {
        requestId: crypto.randomUUID(),
        change: { kind: 'init', gitMode: gitMode.value },
      };
    else {
      if (!view.value?.record) return;
      if (!summary.value.trim()) return validation('memory-summary', '填写摘要。');
      if (!body.value.trim())
        return validation('memory-body', '填写确认后的正文，并保留必要的来源与适用边界。');
      let parsed;
      try {
        parsed = JSON.parse(scope.value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      } catch {
        return validation('memory-scope', 'Scope 必须是 JSON 对象，各字段使用字符串数组。');
      }
      intent.value = {
        requestId: crypto.randomUUID(),
        change: {
          kind: 'update',
          id: selected.value,
          revision: view.value.record.revision,
          status: status.value,
          summary: summary.value,
          body: body.value,
          scope: parsed,
        },
      };
    }
  }
  busy.value = true;
  try {
    const result = (await props.client.command({
      type: 'memory.change',
      laneId: props.laneId,
      ...intent.value,
    })) as { state: string; error: string | null };
    intent.value = null;
    if (result.state !== 'saved') {
      error.value = result.error ?? '修改尚未确认。请处理下方待保存项。';
      return;
    }
    baseline.value = draft();
    notice.value = '记忆已保存。已有队列状态保持不变；暂停的分支需明确恢复。';
    try {
      await read(selected.value, offset.value, false);
    } catch {
      notice.value += ' 当前列表尚未刷新，请稍后重新读取。';
    }
  } catch (cause) {
    error.value =
      (cause instanceof Error ? cause.message : '保存失败') + '；请求已保留，请重试同一修改。';
  } finally {
    busy.value = false;
  }
}
async function resolve(id: string, action: 'retry' | 'continue') {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const result = (await props.client.command({
      type: `memory.change.${action}`,
      changeId: id,
    })) as { state?: string; error?: string };
    if (result.state === 'failed') error.value = result.error ?? '修改仍未确认。';
    else {
      continueId.value = '';
      intent.value = null;
      notice.value =
        action === 'retry'
          ? '原修改已核对保存。请重新读取当前记忆。'
          : '已保留未确认标记。请重新读取后编辑；分支仍暂停。';
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '处理失败，请重试。';
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  void load();
});
</script>
<template>
  <AppDialog title="工作区记忆" :blocked="busy" :dirty="dirty" @close="emit('close')">
    <p class="hint">
      记忆是项目数据。当前用户要求和正式项目规则优先；候选记忆尚未确认。每个 worktree
      独立读取，不向其他分支实时广播。
    </p>
    <p id="memory-error" class="form-error" role="alert">{{ error }}</p>
    <p role="status">{{ busy ? '正在处理记忆…' : notice }}</p>
    <button type="button" :disabled="busy || Boolean(intent)" @click="load()">重新读取记忆</button>
    <div v-if="intent" class="warning" role="group" aria-label="结果未确认的记忆请求">
      <p>请求结果尚未确认。可重试同一请求；停止重试不会撤销已经写入的内容，请重新读取核对。</p>
      <button
        type="button"
        :disabled="busy"
        @click="
          intent = null;
          notice = '已停止重试此请求，请重新读取并检查待确认项。';
        "
      >
        停止重试此请求
      </button>
    </div>
    <section v-if="pending.length" class="warning" aria-label="待确认的记忆修改">
      <div v-for="job in pending" :key="job.id">
        <p>
          <strong>{{ job.kind === 'init' ? '初始化尚未确认' : '纠正尚未确认' }}</strong> ·
          {{ job.recordId }} · {{ job.summary }}
        </p>
        <p>{{ job.error }}</p>
        <button
          type="button"
          :disabled="busy || job.state === 'pending'"
          @click="resolve(job.id, 'retry')"
        >
          重试原记忆修改
        </button>
        <button
          type="button"
          :disabled="busy || job.state === 'pending'"
          @click="continueId = job.id"
        >
          暂不重试这次修改
        </button>
        <div v-if="continueId === job.id" role="group" aria-label="确认暂不重试记忆修改">
          <p>保留这次未确认记录并允许后续操作。已写入的文件不会回滚；请重新读取后判断实际内容。</p>
          <button type="button" :disabled="busy" @click="continueId = ''">继续保留待办</button>
          <button type="button" :disabled="busy" @click="resolve(job.id, 'continue')">
            确认暂不重试
          </button>
        </div>
      </div>
    </section>
    <template v-if="view">
      <form
        novalidate
        v-if="!view.initialized"
        class="dialog-form memory-section"
        @submit.prevent="save(true)"
      >
        <h3>初始化此工作区记忆</h3>
        <label for="memory-git-mode">共享记忆的 Git 策略</label>
        <select id="memory-git-mode" v-model="gitMode" :disabled="busy || Boolean(intent)">
          <option value="track">track · 跟踪共享记忆（默认）</option>
          <option value="ignore">ignore · 不跟踪记忆文件</option>
        </select>
        <p class="hint">
          将创建 .mwf 并更新 AGENTS.md、.gitignore；私有 local
          始终排除。若已有配置，沿用其策略。不会创建 Git 提交。
        </p>
        <button type="submit" :disabled="busy || pending.length > 0">
          {{ intent ? '重试初始化请求' : '初始化记忆' }}
        </button>
      </form>
      <template v-else>
        <p>
          当前 Git 策略：<strong>{{ view.gitMode }}</strong>
        </p>
        <form
          novalidate
          class="dialog-form memory-section"
          @submit.prevent="
            appliedQuery = { query: queryText, path };
            load('', 0, false);
          "
        >
          <label for="memory-query">召回关键词</label
          ><input
            id="memory-query"
            v-model="queryText"
            :disabled="busy || dirty"
            maxlength="20000"
          />
          <label for="memory-query-path">相关文件路径</label
          ><input
            id="memory-query-path"
            v-model="path"
            :disabled="busy || dirty"
            placeholder="例如 src/main.ts"
          />
          <div class="memory-actions">
            <button type="submit" :disabled="busy || dirty">按条件召回</button>
            <button
              type="button"
              :disabled="busy || dirty"
              @click="
                appliedQuery = undefined;
                load('', 0, false);
              "
            >
              查看全部记录
            </button>
          </div>
        </form>
        <p>
          {{ appliedQuery ? '原生召回结果（最多 100 条）' : '全部记忆（含候选与失效记录）' }} ·
          {{ view.total }} 条
        </p>
        <p v-if="!view.records.length" class="hint">
          暂无匹配记录。可在会话的执行结果中保存长期记忆。
        </p>
        <ul class="memory-records">
          <li v-for="record in view.records" :key="record.id">
            <button type="button" :disabled="busy || dirty" @click="load(record.id, offset, false)">
              {{ record.title }} · {{ record.status }}
            </button>
            <p class="mono">{{ record.id }} · {{ record.type }}</p>
            <p>{{ record.summary }}</p>
            <p v-if="record.reasons.length" class="hint">
              召回依据：{{ record.reasons.join(' / ') }}
            </p>
          </li>
        </ul>
        <div class="memory-actions">
          <button
            type="button"
            :disabled="busy || dirty || offset === 0"
            @click="load('', Math.max(0, offset - 20), false)"
          >
            上一页记忆
          </button>
          <button
            type="button"
            :disabled="busy || dirty || offset + 20 >= view.total"
            @click="load('', offset + 20, false)"
          >
            下一页记忆
          </button>
        </div>
        <form
          v-if="view.record"
          class="dialog-form memory-section"
          novalidate
          @submit.prevent="save()"
        >
          <h3>查看与纠正 · {{ view.record.title }}</h3>
          <p class="mono">来源文件：{{ view.record.path }}</p>
          <p class="hint">
            当前状态：{{
              view.record.status
            }}。正文中的来源、适用条件、失效边界与替代记录关系需一并核对。
          </p>
          <p v-for="(value, key) in view.record.boundaries" :key="key">
            <strong>{{ key }}</strong
            >：{{ value }}
          </p>
          <details>
            <summary>对照当前已保存版本</summary>
            <p>{{ view.record.summary }}</p>
            <pre>{{ view.record.body }}</pre>
            <pre>{{ JSON.stringify(view.record.scope, null, 2) }}</pre>
          </details>
          <label for="memory-status">记忆状态</label
          ><select id="memory-status" v-model="status" :disabled="busy || Boolean(intent)">
            <option v-for="item in view.record.statuses" :key="item" :value="item">
              {{ item }}
            </option>
          </select>
          <label for="memory-summary">记忆摘要</label
          ><textarea
            class="resize-none"
            id="memory-summary"
            v-model="summary"
            rows="3"
            maxlength="4000"
            :disabled="busy || Boolean(intent)"
            :aria-invalid="invalid === 'memory-summary'"
            aria-describedby="memory-error"
          />
          <label for="memory-body">记忆正文与来源</label
          ><textarea
            class="resize-none"
            id="memory-body"
            v-model="body"
            rows="8"
            maxlength="200000"
            :disabled="busy || Boolean(intent)"
            :aria-invalid="invalid === 'memory-body'"
            aria-describedby="memory-error"
          />
          <label for="memory-scope">适用范围 Scope（JSON）</label
          ><textarea
            class="resize-none"
            id="memory-scope"
            v-model="scope"
            rows="6"
            :disabled="busy || Boolean(intent)"
            :aria-invalid="invalid === 'memory-scope'"
            aria-describedby="memory-error memory-scope-help"
          />
          <p id="memory-scope-help" class="hint">
            可用字段：paths、file_types、components、tools、operations、phases、keywords；每项为字符串数组。标记失效或替代时，在正文写明原因与替代记录
            ID。
          </p>
          <button type="submit" :disabled="busy || pending.length > 0">
            {{ intent ? '重试同一纠正请求' : '保存记忆纠正' }}
          </button>
          <button v-if="dirty && !intent" type="button" :disabled="busy" @click="discard = true">
            放弃记忆输入修改
          </button>
          <div v-if="discard" class="warning" role="group" aria-label="确认放弃记忆输入">
            <p>放弃输入并恢复到当前已读取版本？</p>
            <button type="button" @click="discard = false">继续纠正</button
            ><button type="button" @click="fill">确认放弃记忆输入</button>
          </div>
        </form>
      </template>
    </template>
  </AppDialog>
</template>
<style scoped>
.memory-section {
  border-top: 1px solid var(--border);
  margin-top: 20px;
  padding-top: 16px;
}
.memory-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.memory-records {
  list-style: none;
  padding: 0;
}
.memory-records li {
  border-bottom: 1px solid var(--border);
  padding: 12px 0;
}
.memory-records p {
  margin: 4px 0;
}
p,
pre {
  overflow-wrap: anywhere;
}
pre {
  white-space: pre-wrap;
}
</style>
