<script setup lang="ts">
import { computed } from 'vue';
import type { WorkspaceSnapshot } from '@parallel-pi/contracts';
import { layoutSessions, NODE_WIDTH, NODE_HEIGHT } from '../map-layout.ts';
import { stateLabel, isActive } from '../workspace.ts';
const props = defineProps<{
  snapshot: WorkspaceSnapshot;
  projectId: string;
  activeSession: string;
  expanded: boolean;
}>();
const emit = defineEmits<{ open: []; back: [] }>();
const layout = computed(() => {
  let x = 0;
  const lanes = props.snapshot.lanes
    .filter((lane) => lane.projectId === props.projectId)
    .map((lane) => {
      const tree = layoutSessions(
        props.snapshot.sessions.filter((session) => session.laneId === lane.id),
      );
      const result = { lane, tree, x };
      x += tree.width + 24;
      return result;
    });
  return {
    lanes,
    width: Math.max(1, x),
    height: Math.max(200, ...lanes.map((lane) => lane.tree.height)),
  };
});
function state(id: string) {
  return props.snapshot.runs.filter((run) => run.sessionId === id).at(-1)?.state ?? 'ready';
}
const description = computed(() =>
  layout.value.lanes
    .map(
      ({ lane }) =>
        `${lane.ref.replace('refs/heads/', '')}：${stateLabel[props.snapshot.runs.find((run) => run.laneId === lane.id && isActive(run.state))?.state ?? lane.state]}`,
    )
    .join('；'),
);
</script>
<template>
  <button
    type="button"
    class="map-thumbnail"
    aria-label="项目地图缩略图：单击查看地图，双击返回全局"
    :title="description"
    :aria-expanded="expanded"
    aria-controls="session-map-panel"
    @click="emit('open')"
    @dblclick.stop="emit('back')"
  >
    <svg
      :viewBox="`0 0 ${layout.width} ${layout.height}`"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
    >
      <g v-for="{ lane, tree, x } in layout.lanes" :key="lane.id" :transform="`translate(${x} 0)`">
        <path :d="`M8 0 V${tree.height}`" class="thumbnail-lane" />
        <path v-for="edge in tree.edges" :key="edge.id" :d="edge.path" class="thumbnail-lane" />
        <rect
          v-for="node in tree.nodes"
          :key="node.session.id"
          :x="node.x"
          :y="node.y"
          :width="NODE_WIDTH"
          :height="NODE_HEIGHT"
          :class="{
            active: node.session.id === activeSession,
            running: isActive(state(node.session.id)),
            failed: ['failed', 'interrupted'].includes(state(node.session.id)),
          }"
        />
      </g>
    </svg>
  </button>
</template>
