<script setup lang="ts">
import type { TreeNode } from '../types/project'

defineProps<{
  node: TreeNode
  selectedPath: string
}>()

const emit = defineEmits<{
  select: [path: string]
}>()

function onSelect(path: string) {
  emit('select', path)
}
</script>

<template>
  <div class="tree-node">
    <template v-if="node.kind === 'directory'">
      <p class="tree-node__title">{{ node.name }}</p>
      <div v-if="node.children?.length" class="tree-children">
        <FileTreeNode
          v-for="child in node.children"
          :key="child.path"
          :node="child"
          :selected-path="selectedPath"
          @select="onSelect"
        />
      </div>
    </template>

    <button
      v-else
      class="tree-item text-sm font-medium"
      :class="{ active: node.path === selectedPath }"
      type="button"
      @click="onSelect(node.path)"
    >
      {{ node.name }}
    </button>
  </div>
</template>
