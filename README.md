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

项目目前处于 MVP 早期实现阶段，正在优先验证 Claude Code 风格的文件工具 Agent Loop。

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
- `ReadFile / EditFile / CreateFile / RenameFile / DeleteFile / ListDirectory / FindFiles` 项目文件工具
- OpenAI-compatible `tools / tool_calls` 解析
- 工具结果回灌模型后的多轮 Query Loop
- 项目级 JSONL 日志 `.novel/logs/agent.log.jsonl`
- 最近项目记忆与刷新后恢复
- 正式工作台 UI：首页、主工作区、文件树、对话面板、右侧内容预览、设置页
- 第一版章节要素提取与写入链路，可将章节内容沉淀到 `elements/`
- 要素写入后标记 RAG 索引过期，提示后续重建索引
- 正式设置页可查看与手动重建项目 RAG 向量索引
- `RagSearch` 已作为正式 Agent 工具接入，Agent 可主动召回人物、地点、情节、时间线与世界观要素
- 项目规划、需求说明、UI 设计、技术架构等文档整理

尚未完整落地的核心能力包括：

- 写工具执行前确认
- 文件 diff 预览、Agent 停止运行与工具调用边界控制
- LLM 结构化要素抽取、要素去重合并与覆盖确认
- RAG 在真实创作任务中的召回质量验证与使用策略调优
- 自动增量索引、索引过期提醒与更完整的降级策略
- 近期章节上下文拼装
- Agent 会话持久化与上下文压缩
- Rerank 精排与更完整的创作工作流

## MVP 目标

当前希望优先打通这条最小闭环：

`创建项目 -> 配置模型 -> 输入指令 -> Agent 读取/修改文件 -> 写入文件 -> 提取要素 -> 下次生成可复用要素`

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
│   ├── entities/
│   ├── timeline/
│   ├── plots/
│   └── worldbuilding/
├── prompts/
│   ├── system.md
│   └── scenes/
│       └── scene-001.md
└── .novel/
    ├── manifest.json
    └── logs/
        └── agent.log.jsonl
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

当前项目已经具备正式工作台页面，同时保留 `/test` 作为 AI 与 RAG 能力的调试入口。

正式工作台当前可以完成：

- 首页创建、打开与恢复最近项目
- 主工作区三栏布局：文件树、AI 对话、内容预览
- 打开章节文件并在右侧内容面板预览 Markdown
- 对当前章节执行要素提取，并将候选写入 `elements/`
- AI 通过 Agent Loop 调用项目文件工具读写小说文件
- 配置 LLM / Embedding / Rerank 与项目参数
- 查看 RAG 索引状态，并手动重建项目向量索引
- Agent 在需要设定一致性时可主动调用 `RagSearch` 检索要素，再按需读取源文件

`/test` 调试页当前可以完成：

- 创建 / 打开 / 修复小说项目
- 编辑并保存项目配置
- 测试 LLM / Embedding 连通性
- 测试 Rerank 连通性
- 发起流式生成
- 通过 Agent Loop 调用文件工具
- 保存 SYSTEM Prompt
- 保存生成章节
- 执行要素提取预览并写入 `elements/`
- 执行 RAG 调试、查看召回草稿与命中解释
- 浏览项目中的 Markdown / JSON / 文本文档原文
- 自动恢复最近打开的项目
- 记录项目生命周期、模型调用和工具调用日志

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

## RAG 测试建议

在正式项目中验证当前 RAG 链路时，可以按以下顺序操作：

1. 在章节文件中写入或生成一段内容。
2. 打开该章节，在右侧内容面板执行“提取要素 / 写入 elements”。
3. 进入设置页，查看“向量索引”状态并手动重建索引。
4. 回到对话区，输入需要延续设定的创作指令，例如“续写下一章，保持鸿影、云溪和武当派设定一致”。

如果索引已经可用，Agent 应该可以主动调用 `RagSearch`，召回相关要素；必要时再通过 `ReadFile(sourcePath)` 读取完整要素文件。

## 文档

项目文档主要放在 [`docs/`](./docs)，当前按用途分为五类：

- [`docs/product/`](./docs/product)：产品愿景、AI 功能需求、UI 设计
- [`docs/architecture/`](./docs/architecture)：技术架构、Agent Loop、工具系统、RAG、UI 接口契约
- [`docs/decisions/`](./docs/decisions)：阶段性技术和产品决策记录
- [`docs/plans/`](./docs/plans)：阶段性功能计划和重构计划
- [`docs/project/`](./docs/project)：路线图、MVP、当前进度、开发日志

常用入口：

- [`docs/project/当前进度.md`](./docs/project/当前进度.md)：开发推进情况
- [`docs/project/项目总览.md`](./docs/project/项目总览.md)：项目阶段与目标
- [`docs/product/产品愿景.md`](./docs/product/产品愿景.md)：产品定位与核心思路
- [`docs/architecture/技术架构设计.md`](./docs/architecture/技术架构设计.md)：技术选型与架构说明
- [`INTERFACE.md`](./INTERFACE.md)：当前 UI 协作接口、stores/services 使用入口

## 仓库目标

这个仓库当前最重要的，不是把所有想法都一次性做完，而是尽快验证两件事：

- AI 直接操作小说文件的体验是否顺畅
- 长篇上下文通过“文件 + RAG”管理是否真的稳定可持续

如果这两点成立，NovAI 才值得继续往完整产品推进。
