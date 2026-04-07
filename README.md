# NovAI

> 一个面向长篇小说创作的 AI 工作台。  
> 以本地文件为中心，用 RAG 管理超长上下文，而不是把一切都塞进聊天记录里。

## 项目简介

NovAI 想解决的，不是“怎么让 AI 多聊几轮”，而是“怎么让 AI 能稳定参与一部长篇小说的持续创作”。

传统聊天式工具在长篇创作里很容易遇到这些问题：

- 上下文越积越多，最终溢出
- 长记忆越来越臃肿，生成变慢、质量下降
- 为了继续使用，被迫删掉早期记忆，破坏故事连贯性

NovAI 的思路是换一条路：

- 用本地文件夹作为小说项目的真实数据源
- 用 Markdown / JSON 存章节、提示词、人物、地点、情节等内容
- 用 Embedding + RAG 检索与当前情节真正相关的要素
- 让 AI 直接围绕文件工作，而不是只在聊天窗口里吐文本

一句话说，NovAI 不是“AI 聊天工具的小说皮肤”，而是一个为长篇小说创作设计的文件化工作台。

## 当前状态

项目目前处于 MVP 早期实现阶段，正在优先验证 AI 最小可用创作闭环。

当前仓库已经完成的内容主要包括：

- Vue 3 + TypeScript + Vite 前端工程初始化
- 本地小说项目的创建与打开流程
- 不合法项目目录的检测与修复流程
- 标准项目目录初始化
- `novel.config.json` 读写
- LLM / Embedding 配置测试连接
- LLM 流式生成链路
- `prompts/system.md` 读取与保存
- 章节文件写入 `chapters/`
- 测试页中的项目文档分组与原文预览
- 项目规划、需求说明、UI 设计、技术架构等文档整理

尚未完整落地的核心能力包括：

- 要素抽取
- Embedding 向量化与 RAG 检索
- 近期章节上下文拼装
- Rerank 精排与更完整的创作工作流
- 正式工作台 UI

## MVP 目标

当前希望优先打通这条最小闭环：

`创建项目 -> 配置模型 -> 输入指令 -> 生成章节 -> 写入文件 -> 提取要素 -> 下次生成可复用要素`

如果这条链路成立，就能验证 NovAI 最核心的产品判断：

- 用户是否愿意以“本地文件项目”的方式创作小说
- AI 是否能围绕章节文件和要素文件稳定协作
- 文件系统 + RAG 是否比传统聊天记忆更适合长篇创作

## 当前项目结构

NovAI 采用“一个文件夹就是一个小说项目”的思路。当前默认初始化结构大致如下：

```text
你的小说项目/
├── novel.config.json
├── chapters/
├── elements/
│   ├── characters/
│   ├── locations/
│   ├── timeline/
│   ├── plots/
│   └── worldbuilding/
├── prompts/
│   ├── system.md
│   └── scenes/
│       └── scene-001.md
└── .novel/
    └── manifest.json
```

这样做的好处是：

- 数据直观可见，人和 AI 都能读
- 项目天然可迁移，复制文件夹即可带走
- 不依赖聊天记录保存核心创作信息
- 后续可以继续接入 Git、RAG、外部编辑器协作

## 技术栈

- Vue 3
- TypeScript
- Vite
- Pinia
- Vue Router
- File System Access API

规划中的核心能力还包括：

- Orama
- isomorphic-git

## 当前实现方式

为了优先验证 AI 主链路，当前版本暂不继续推进正式工作台界面，而是采用一个极简测试页 `/test` 作为开发入口。

当前测试页已经可以完成：

- 创建 / 打开 / 修复小说项目
- 编辑并保存项目配置
- 测试 LLM / Embedding 连通性
- 发起流式生成
- 保存 SYSTEM Prompt
- 保存生成章节
- 浏览项目中的 Markdown / JSON / 文本文档原文

## 本地开发

### 环境要求

- Node.js 18+
- pnpm 10+
- Chromium 内核浏览器

之所以建议 Chromium，是因为当前本地文件读写依赖 File System Access API，Firefox 和 Safari 暂不支持。

### 启动方式

```bash
pnpm install
pnpm dev
```

### 常用命令

```bash
pnpm dev
pnpm build
pnpm typecheck
```

## 文档

项目文档主要放在 [`docs/`](./docs)：

- [`docs/NovAI产品规划.md`](./docs/NovAI产品规划.md)：产品定位与核心思路
- [`docs/AI功能需求说明书.md`](./docs/AI功能需求说明书.md)：AI 功能需求
- [`docs/UI设计文档.md`](./docs/UI设计文档.md)：界面与交互设计
- [`docs/技术架构设计.md`](./docs/技术架构设计.md)：技术选型与架构说明
- [`docs/project/项目总览.md`](./docs/project/项目总览.md)：项目阶段与目标
- [`docs/project/MVP清单.md`](./docs/project/MVP清单.md)：MVP 范围与执行顺序
- [`docs/project/当前进度.md`](./docs/project/当前进度.md)：开发推进情况

## 仓库目标

这个仓库当前最重要的，不是把所有想法都一次性做完，而是尽快验证两件事：

- AI 直接操作小说文件的体验是否顺畅
- 长篇上下文通过“文件 + RAG”管理是否真的稳定可持续

如果这两点成立，NovAI 才值得继续往完整产品推进。
