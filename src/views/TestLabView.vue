<script setup lang="ts">
import { ref } from 'vue'

const instruction = ref('')
const systemPrompt = ref('')
const result = ref('')
const status = ref('这里先作为 AI 功能测试页使用。')

function fillDemoData() {
  systemPrompt.value = '你是一名长篇小说写作助手，输出中文 Markdown。'
  instruction.value = '写一段测试内容：主角深夜走进废弃藏书楼，发现一封来自十年前的信。'
  status.value = '已填入演示数据，还没有接真实 AI 调用。'
}

function clearAll() {
  instruction.value = ''
  systemPrompt.value = ''
  result.value = ''
  status.value = '已清空测试内容。'
}

function mockRun() {
  result.value = [
    '# 测试输出',
    '',
    '夜风穿过残破的窗棂，在藏书楼深处卷起一阵旧纸气味。',
    '主角抬起灯，看到书架夹层里露出一角发黄的信封，上面写着十年前自己的名字。',
  ].join('\n')
  status.value = '当前是前端本地模拟输出，后面可以直接替换成真实 LLM 调用。'
}
</script>

<template>
  <main>
    <h1>NovAI Test Lab</h1>
    <p>这个页面只用来测试 AI 功能，不做正式 UI。</p>
    <p>{{ status }}</p>

    <section>
      <h2>System Prompt</h2>
      <textarea v-model="systemPrompt" rows="8" style="width: 100%" />
    </section>

    <section>
      <h2>Instruction</h2>
      <textarea v-model="instruction" rows="6" style="width: 100%" />
    </section>

    <section>
      <button type="button" @click="fillDemoData">填充演示数据</button>
      <button type="button" @click="mockRun">模拟生成</button>
      <button type="button" @click="clearAll">清空</button>
    </section>

    <section>
      <h2>Result</h2>
      <pre>{{ result || '还没有结果' }}</pre>
    </section>
  </main>
</template>
