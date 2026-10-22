# NovAI

[![Release](https://img.shields.io/github/v/release/honlnk/NovAI?include_prereleases&label=release)](https://github.com/honlnk/NovAI/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

> **对话驱动的智能体小说创作工作台。**
> 你用自然语言指挥，AI 智能体直接读写本地项目里的章节、大纲与设定文件。
> 聊天只是协作界面——作品的唯一真值，始终是你磁盘上的那个文件夹。

**[在线使用](https://novai.honlnk.com)** · 需要 Chromium 内核浏览器（Chrome / Edge）

---

## NovAI 的创作方式

NovAI 把一部长篇小说当作一个「项目」来经营——像 Vibe Coding 工具对待代码那样对待小说：

- **对话是控制面**：你用自然语言表达意图，剩下的交给智能体——它自己维护任务上下文，决定读哪些章节、查哪些设定、什么时候动笔
- **AI 直接操作文件**：章节、大纲、设定都是项目文件夹里的真实文件，人和 AI 读写同一份作品，任何编辑器都能打开
- **本地优先**：一个文件夹就是一个项目，数据不经过任何服务器，复制文件夹即可完整迁移

## 核心特性

### 🤖 智能体工作流，而不是聊天框

AI 自己决定读哪些章节、查哪些设定、什么时候动笔。每次写文件前，你会看到 **diff 预览并亲自确认**；写作途中可以随时**排队补充指令、插话引导或一键停止**；长对话自动压缩摘要、超长工具结果落盘外存——几十万字的项目也能持续协作不断片。

### 👥 双智能体分工

主智能体负责创作；**要素管理员**专职维护设定库。可以把整理任务委派给它（独立会话运行，完成后汇报回灌），也可以直接与它对话。各会话的写盘确认独立路由，互不干扰。

### 📚 设定一致性保障

六类设定要素（人物 / 地点 / 实体 / 情节 / 时间线 / 世界观）沉淀为标准文件。写作时 AI 能看到核心设定的**目录清单**，需要时精确加载全文；情节与时间线另走**语义向量检索**——「之前主角失恋那段」也能一句话找回来，续章不再自相矛盾。

### 🌐 联网与资料直达

内置 WebSearch / WebFetch 工具，写作中随时查资料（默认接入免费托管搜索服务，也可换成自部署后端）；KnowledgeLookup 一键直达维基、知乎、百度百科等 8 个知识平台核对设定。

### 🔑 模型自由，钥匙自持

同时支持 **OpenAI 兼容 / Anthropic / Gemini / OpenAI Responses** 四种协议，DeepSeek、通义、Claude、Gemini 都能接；Embedding 与 Rerank 独立可配。思考过程实时展示、四档思考强度可调；输入框还有 DeepSeek FIM 行内续写补全（灰色建议，Tab 采纳）。API Key 只存在你自己的浏览器里。

### 💾 本地优先，数据主权

```text
我的小说/
├── novel.config.json     # 项目配置（模型 / 检索 / 权限档位）
├── chapters/             # 章节正文，一章一文件（第NNN章-标题.txt）
├── outlines/             # 写作大纲，可切换、可关闭
├── elements/             # 设定库
│   ├── characters/  locations/  entities/
│   ├── plots/  timeline/  worldbuilding/
├── prompts/
│   ├── system.md         # 系统提示词
│   ├── NovAI.md          # 项目记忆（AI 自己维护）
│   └── ELEMENT.md        # 设定库规范
└── .novel/               # 运行时数据：会话、日志、回收站、溢出缓存
```

基于浏览器 File System Access API 直接读写本地磁盘；复制文件夹就是完整迁移；文件删除进项目内回收站，每次改动都有账本可查。

### 🖋 为长篇打磨的工作台

分类侧栏（章节 / 要素 / 提示词 / 对话）+ 内容面板预览 / 编辑 / 原始三态；`@大纲` 快速引用大纲、`/` 斜杠命令、选中文本生成引用卡片；写权限五档可调——从「只读审阅」到「完全访问」，越界写入永远需要你点头。

<!-- TODO(发布前): 此处插入主工作区截图（对话 + 内容面板 + diff 确认卡各一张） -->

## 快速开始

### 在线使用

打开 **[novai.honlnk.com](https://novai.honlnk.com)**，新建或打开一个本地文件夹作为小说项目，在设置里填入你的模型 API Key 即可开始。

### 本地开发

```bash
# Node.js 20+，pnpm 10+（corepack enable 可自动安装）
git clone --recurse-submodules git@github.com:honlnk/NovAI.git
cd NovAI
pnpm install
pnpm dev        # http://localhost:5173
```

常用命令：`pnpm test`（570+ 单测）· `pnpm typecheck` · `pnpm build`

## 技术架构

pnpm monorepo，前后端边界清晰：

| 包 | 职责 |
|---|---|
| `packages/core`（`@novai/core`） | 框架无关引擎：Agent Loop（压缩 / 溢出落盘 / 范围权限 / 队列与插话）、工具系统（13 件）、LLM 四协议适配、RAG（Orama 向量检索）、要素体系、服务层。以 TypeScript 源码形式直接消费，无构建步骤 |
| `packages/app`（`@novai/app`） | Vue 3 + Pinia + Tailwind CSS 4 纯浏览器 SPA，只经服务层访问 core |

Agent Loop 的内部机制以 DeepSeek Harness 为参照系（compaction、spill、turn/step loop）。发布走 GitHub Actions：打 `release-*` tag 自动构建部署到 GitHub Pages。

## 文档

设计与过程文档在 [`docs/`](./docs) 子模块（[NovAI-document](https://github.com/honlnk/NovAI-document)）：

- [产品愿景](./docs/product/产品愿景.md) · [AI 功能需求说明书](./docs/product/AI功能需求说明书.md)
- [当前进度](./docs/project/当前进度.md) · [决策记录](./docs/decisions/)
- [UI 协作接口契约](./docs/architecture/UI协作接口契约设计.md) · [INTERFACE.md](./INTERFACE.md)

## 路线图

- RAG 索引自动后台增量重建与错误降级
- AI 章节整理（拆分 / 合并 / 衔接补写）
- 校对视图与高级审校
- Git 自动版本管理
- 提示词调教工作流

## 贡献

欢迎 issue 与 PR。提交信息遵循 commitlint 约定（`type(scope): 中文说明`），详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## License

[Apache License 2.0](./LICENSE)
