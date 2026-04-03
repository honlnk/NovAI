import { createRouter, createWebHistory } from 'vue-router'

import TestLabView from '../views/TestLabView.vue'

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      redirect: '/test',
    },
    {
      path: '/test',
      name: 'test',
      component: TestLabView,
    },
  ],
})
