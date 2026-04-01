<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import { useProjectStore } from '../stores/project'

const router = useRouter()
const projectStore = useProjectStore()
const projectName = ref('我的第一本小说')
const projects = computed(() => projectStore.recentProjects)

async function onCreateProject() {
  const snapshot = await projectStore.createNewProject(projectName.value.trim() || '我的第一本小说')

  if (snapshot) {
    await router.push(`/project/${snapshot.id}`)
  }
}

async function onOpenProject() {
  const snapshot = await projectStore.openExistingProject()

  if (snapshot) {
    await router.push(`/project/${snapshot.id}`)
  }
}
</script>

<template>
  <main class="page page-home text-ink-950">
    <section class="hero-card relative overflow-hidden">
      <div>
        <p class="page-eyebrow">NovAI Workspace</p>
        <h1 class="max-w-4xl">先把小说工程搭起来，再让 AI 真正开始干活。</h1>
        <p class="hero-copy">
          当前版本已经进入工作台骨架阶段。接下来我们会优先接入本地项目创建、文件树和预览链路。
        </p>
      </div>

      <div class="hero-actions shrink-0">
        <label class="form-field hero-field">
          <span class="text-sm font-medium">新项目名称</span>
          <input
            v-model="projectName"
            class="shadow-sm outline-none transition focus:border-clay-600 focus:ring-4 focus:ring-clay-100"
            type="text"
            placeholder="输入小说项目名称"
          />
        </label>
        <button class="primary-button" type="button" :disabled="projectStore.isBusy" @click="onCreateProject">
          {{ projectStore.isBusy ? '处理中...' : '新建项目' }}
        </button>
        <button class="ghost-button" type="button" :disabled="projectStore.isBusy" @click="onOpenProject">
          打开本地目录
        </button>
      </div>
    </section>

    <section class="section-block">
      <div class="status-banner shadow-sm" :class="{ 'status-banner--error': projectStore.errorMessage }">
        {{ projectStore.errorMessage || projectStore.statusMessage }}
      </div>
    </section>

    <section class="section-block">
      <div class="section-heading">
        <span>最近项目</span>
        <span class="muted-text">本地会话记录</span>
      </div>

      <div v-if="projects.length > 0" class="project-grid">
        <article v-for="project in projects" :key="project.id" class="project-card">
          <p class="project-card__meta">{{ project.updatedAt }}</p>
          <h2 class="text-xl font-semibold">{{ project.name }}</h2>
          <p>{{ project.chapterCount }} 章 · 约 {{ project.wordCount.toLocaleString() }} 字</p>
        </article>

        <button class="project-card project-card--new" type="button" @click="onCreateProject">
          <span>+</span>
          <strong>创建新的小说项目</strong>
          <p>初始化标准目录结构与配置文件</p>
        </button>
      </div>

      <div v-else class="empty-card">
        <h2 class="text-xl font-semibold">还没有打开过项目</h2>
        <p>
          先通过上方按钮创建一个标准小说项目，或者打开已有目录，我们就能继续接文件树和内容预览。
        </p>
      </div>
    </section>
  </main>
</template>
