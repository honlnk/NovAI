---
name: novai-opfs-testing
description: 在 ZCode 内置浏览器（IAB）或任何弹不出文件系统授权面板的环境里对 NovAI 做真机测试的配方：把测试项目（~/note/test-novel）种进 OPFS、替换 IndexedDB 里的目录句柄，让应用全链路照常运行。当需要在本仓库做真机回归、验收测试、浏览器内打开/恢复 NovAI 项目、或「恢复项目」点了没反应疑似权限被挡时使用——即使没人明说 OPFS。
---

# NovAI 真机测试 OPFS 仿真播种

内置浏览器弹不出 File System Access 授权面板（queryPermission/requestPermission 均 denied 且无 UI），「打开项目」「恢复项目」全部失效。绕过办法：OPFS（`navigator.storage.getDirectory()`）返回**免授权的真实目录句柄**，把项目副本种进去、再把 IndexedDB `novai-projects` 库 `recent-projects` 表记录的 `handle` 换成 OPFS 根，应用原生流程无感知运行——UI、迁移逻辑、真实 LLM、工具执行、确认链全真，只有存储传输层换了载体，**真实项目目录零改动**。

完整原理、被排除的替代方案、IAB 输入通道差异见 `docs/project/真机测试OPFS仿真目录方案.md`——方案有疑义时读它，不要在会话里重新推导。

## 操作流程

### 0. 前置检查

- dev server：`curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/` 应回 200。没通时先让用户启动自己的 dev server——绝不自起新实例、不换端口（AGENTS.md 铁律）。
- 项目源：默认 `~/note/test-novel`（模型已配好）。
- 用 `mcp__node_repl__js` 驱动浏览器：先加载 control-browser 技能拿 bootstrap 写法；每段 evaluate 必须是纯 JS，不能带 TS 语法；单次调用 timeout 上限 120s，长操作拆分。

### 1. 确诊（已有诊断记录可跳过）

正常点「恢复项目」无反应时，在页面 evaluate 里从 IndexedDB 取出记录句柄探测：

```js
await handle.queryPermission({ mode: 'readwrite' })   // 'denied'
await handle.requestPermission({ mode: 'readwrite' }) // 仍 'denied' 且无面板
```

两条都 denied → 确诊环境限制，走本方案。注意这是环境限制不是应用缺陷，不要回头去改应用代码。

### 2. 盘外构建种子（shell 侧）

跑 `scripts/build-seed.sh`（依赖 python3；schema 校验需 jsonschema CLI 或 `python3 -m jsonschema`，缺依赖时 `NO_VALIDATE=1` 可跳过）：

```bash
SKILL_DIR=.agents/skills/novai-opfs-testing
PROJECT_DIR=~/note/test-novel "$SKILL_DIR/scripts/build-seed.sh" /tmp/novai-opfs-seed.json
```

脚本做三件事：从源项目收集文本文件（config、prompts、elements、chapters、`.novai/` 下 JSON，按 `references/seed-manifest.txt` 清单，跳过二进制）、可选注入旧字段块（`INJECT_LEGACY_BLOCK=gardener` 时向 `novel.config.json` 注入迁移测试数据）、用 jsonschema 校验产物结构后写出。**源项目只读，一个字节都不会改。**

产物含 API key，只能放 `/tmp`，绝不拷进仓库；页面用完即弃。

### 3. 页面内播种 + 换柄（浏览器 evaluate）

`scripts/seed-opfs.js` 定义了一个自包含函数 `seedNovaiOpfs(seedJson)`（清空 OPFS 根 → 逐文件写入 → 把 `recent-projects` 所有记录的 `handle` 换成 OPFS 根、`rootName` 置空串 → 返回 `{ filesWritten, recordsUpdated }`）。

IAB 的 `tab.playwright.evaluate` 把传入字符串当**单个表达式**求值——不接受顶层 `const`/函数声明。所以调用形式固定为：Node 侧读入本文件内容与种子 JSON，拼成一个 IIFE 表达式再 evaluate：

```js
const expr = `(async () => { const seedJson = ${种子JSON文本};\n${seed-opfs.js 文件内容}\nreturn await seedNovaiOpfs(seedJson); })()`;
await tab.playwright.evaluate(expr);  // 文件多时 timeout 顶到接近 120s，或种子分两半调两次
```

`cleanup-opfs.js` 同理包 IIFE 调用（它按 `store.keyPath` 取主键删记录——该表主键是 `key` 不是 `projectId`，同一 projectId 可有多条）。

### 4. 恢复并验收

在页面上正常点「恢复项目」（IAB 里 Playwright 合成点击无效，用 CUA 坐标点击或 evaluate 里 `element.click()`）。应用按原生流程打开项目，之后按各施工计划的验收点正常验收。验证落盘状态优先用 evaluate 直接读 OPFS（如读 `novel.config.json` 核对迁移结果），比 UI 目视硬。

### 5. 清理（测试遗留物三处）

跑 `scripts/cleanup-opfs.js`（页面 evaluate）：删 `recent-projects` 里 `isOpfsRoot` 的测试记录、清空 OPFS 根。再 `rm /tmp/novai-opfs-seed*.json` 删掉含 key 的种子。注意恢复操作会追加新 projectId 的记录、旧记录不自动消失——欢迎页出现两条同名条目属预期，清理时一起删。

## 红线

- 种子与注入的旧字段是测试数据：只在 `/tmp` 和 OPFS 里存在，绝不写回真实项目，绝不进仓库（API key 只运行时存在于页面内存）。
- OPFS 副本上产生的改动（重命名、写回、新增预设）只存在于 OPFS，与真实项目无关。
- 每次用完本方案，在 `docs/project/真机测试OPFS仿真目录方案.md` 文末「使用记录」表追加一行。
