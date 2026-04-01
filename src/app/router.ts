import { createRouter, createWebHistory } from 'vue-router'

import HomeView from '../views/HomeView.vue'
import SettingsView from '../views/SettingsView.vue'
import WorkspaceView from '../views/WorkspaceView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView,
    },
    {
      path: '/project/:projectId',
      name: 'workspace',
      component: WorkspaceView,
      props: true,
    },
    {
      path: '/project/:projectId/settings',
      name: 'settings',
      component: SettingsView,
      props: true,
    },
  ],
})
