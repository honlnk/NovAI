import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import { router } from './app/router'
import './styles/tailwind.css'
import './styles/app.scss'

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.mount('#app')
