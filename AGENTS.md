# AGENTS.md — dsh-session-title-summary

DSH 插件 session-title-summary（纯 host）：每轮对话结束后把新事件折叠进滚动
摘要并重命名会话标题。独立仓库，不属于 dsh-web-ui monorepo；包级规则只写本包
特有约定。

## 本包要点

- 纯 host 插件，无 `src/client/`：设置开关经 host 注册 settings section
  （`dsh-session-title-summary` 命名空间），Web 设置界面自动渲染。
- 结构分区：`src/index.ts` 是 host 半区（事件监听 + LLM 调用 + rename），
  `src/core/` 是纯逻辑（`events.ts` 事件摘要、`summary.ts` 折叠 prompt 与解析、
  `store.ts` 原子文件存储、`home.ts` DSH_HOME 解析）——core 不依赖 cordis，可单测。
- 折叠采用"滚动摘要"：每次把旧摘要 + 新事件喂 LLM，旧内容被压缩、新内容保留细节，
  天然实现"越往前越少"。摘要存 `$DSH_HOME/dsh-session-title-summary/<sessionId>.json`。
- 依赖注入：host 需要 `sessionTitle` / `llm` / `sessions` 服务；peer 声明
  dsh-llm / dsh-session / dsh-session-title / dsh-settings。
- 生命周期纪律：`turn/end` 触发异步折叠，per-session promise 链串行防重；折叠失败
  只推进游标不重命名，不得抛错影响宿主。

## 提交前检查

```sh
pnpm typecheck
pnpm test
pnpm build
```
