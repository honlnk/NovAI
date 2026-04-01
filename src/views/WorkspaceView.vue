<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'

import WorkspaceLayout from '../layouts/WorkspaceLayout.vue'
import { useProjectStore } from '../stores/project'
import { useUiStore } from '../stores/ui'

const props = defineProps<{
  projectId: string
}>()

const router = useRouter()
const projectStore = useProjectStore()
const uiStore = useUiStore()
const { activeFile, currentProject, errorMessage, isReady } = storeToRefs(projectStore)

const isCurrentProjectMatched = computed(() => currentProject.value?.id === props.projectId)
const canShowWorkspace = computed(() => isReady.value && isCurrentProjectMatched.value)

watch(
  () => activeFile.value?.path,
  (path) => {
    if (path) {
      uiStore.selectFile(path)
    }
  },
  { immediate: true },
)

onMounted(() => {
  if (!canShowWorkspace.value) {
    void router.replace('/')
  }
})
</script>

<template>
  <main class="page page-workspace">
    <WorkspaceLayout
      v-if="canShowWorkspace && currentProject"
      :project-id="projectId"
      :project-name="currentProject.name"
      :tree="currentProject.tree"
      :active-file="activeFile"
      :error-message="errorMessage"
      @open-file="projectStore.openFile"
      @refresh-tree="projectStore.refreshTree"
    />
  </main>
</template>
