import { createRouter, createWebHistory } from 'vue-router'

import HomeView from '../views/HomeView.vue'
import ModelDocsView from '../views/ModelDocsView.vue'
import ProjectView from '../views/ProjectView.vue'

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView,
    },
    {
      path: '/project/:id',
      name: 'project',
      component: ProjectView,
    },
    {
      path: '/model-docs',
      name: 'model-docs',
      component: ModelDocsView,
    },
  ],
})
