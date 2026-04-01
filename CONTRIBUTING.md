# 贡献约定

## 提交信息规范

本项目使用以下提交格式：

```text
type(scope): 中文说明
```

示例：

```text
feat(view): 完成首页布局
fix(router): 修复路由跳转异常
docs(project): 补充开发日志维护说明
refactor(store): 重构 UI 状态管理
test(view): 增加页面渲染测试
chore(git): 补充提交规范与钩子配置
build(deps): 调整构建依赖版本
ci(github): 增加提交规范检查流程
```

## type 说明

- `feat`: 新功能
- `fix`: 缺陷修复
- `docs`: 文档修改
- `refactor`: 重构，不改变外部行为
- `test`: 测试相关
- `chore`: 日常维护、工具或杂项调整
- `build`: 构建系统、依赖或打包配置
- `ci`: CI/CD 配置
- `perf`: 性能优化
- `style`: 代码格式或排版调整
- `revert`: 回滚提交

## scope 建议

### 核心 scope

- `app`, `view`, `layout`, `store`, `router`, `ui`

### 文档 scope

- `docs`, `project`

### 工程 scope

- `config`, `build`, `ci`, `deps`, `git`, `style`, `test`, `other`

## 提交规则

1. 必须使用 `type(scope): 中文说明`
2. `scope` 必填
3. 说明优先写结果，不写过程
4. 标题只写一行，不加句号
5. 一次提交尽量只做一类事情

## 校验方式

- 本地提交会通过 `husky + commitlint` 自动校验
- 如果你要手动检查，可以运行 `pnpm exec commitlint --edit <commit-msg-file>`
