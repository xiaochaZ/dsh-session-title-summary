# dsh-session-title-summary — 滚动会话摘要 + 当前任务标题

[English](README.md) | 中文

[![GitHub stars](https://img.shields.io/github/stars/xiaochaZ/dsh-session-title-summary?style=flat-square)](https://github.com/xiaochaZ/dsh-session-title-summary)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-blue?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/dsh-%E2%89%A50.1.1--rc.1-purple?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

一个纯 host 端的 DeepSeek Harness (DSH) 插件：每轮对话结束后，把会话的工作总结成
**滚动式的"大问题 - 小问题"大纲**，并把会话重命名为"会话总体目标 - 当前正在处理的具体
事项"。完全基于官方 NPM SDK 实现——不改动 DSH 源码。

## 工作原理

- 插件监听每个存活顶层 agent 的 `agent/turn-stopping` 事件（与 dsh-auto-memory
  相同的事件）。
- 会话收尾后，**派生一个子代理**（以当前 agent 为 parent），子代理继承同一模型路由
  与工作区，主对话不被阻塞、不被打扰。
- 子代理收到"上次的滚动摘要 + 本轮新事件的摘要"（用户消息、助手回复、工具名/参数/
  结果），以结构化对象返回更新后的摘要与新标题。
- 摘要按会话原子写入
  `$DSH_HOME/dsh-session-title-summary/<sessionId>.json`，并通过官方 `sessionTitle`
  服务完成会话重命名。

### 摘要格式："大问题 - 小问题"

摘要以简洁大纲覆盖整个会话。**大问题**是用户在推进的会话级目标（如"开发标题自动
总结功能"）；**小问题**是该目标下的具体事项（如"修复子代理输出token上限"）。每行
形如"大问题 - 小问题"，同一大问题的行聚在一起、不同大问题空行分隔。当前大问题条目
最多，旧大问题各保留一条简短条目。

### 标题跟随当前工作

标题使用同样的形式，例如"开发标题自动总结功能 - 修复子代理输出token上限"。它基于
摘要末尾的最新工作生成，绝不以会话开头的内容为准——会话演进时标题始终跟随当前任务。

### 缓存安全

`session/title` 事件是纯日志事件：它从不进入 `deriveMessages()`、系统提示词、工具
schema 或请求前缀，因此重命名不会影响输入缓存命中率或 KV 缓存。总结在独立子代理中
执行、使用独立提示词——不与主对话共享前缀。

## 安装

```sh
### 从 npm（发布后）
dsh plugin --profile <名字> add @xiaochaz/dsh-session-title-summary@latest

### 从仓库（开发）
git clone <本仓库>
cd xiaochaz-session-title-summary
pnpm install && pnpm build
dsh plugin --profile <名字> add link:$(pwd)
```

安装后**重启 `dsh web`**。插件在下一轮对话结束后生效。

## 配置

Web 设置界面会渲染本插件的配置区：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关闭后标题不再被自动修改（插件不再做任何事）。 |
| `targetWords` | `6` | 非 CJK 会话的标题目标词数（硬上限）。 |
| `targetCjkCharacters` | `10` | CJK 会话的标题目标字数（硬上限）。 |
| `provider` / `model` | 会话路由 | 可选显式 LLM 路由覆盖；默认跟随会话当前模型。 |
| `timeoutMs` | `90000` | 每次折叠的子代理超时。 |

## 数据

- 滚动摘要：`$DSH_HOME/dsh-session-title-summary/<sessionId>.json`
  （带版本号的 JSON，原子写入；`lastSeq` 是已折叠的最大事件 seq）。

## 开发

```sh
pnpm install
pnpm test
pnpm build
```

## 已知限制

- 总结子代理有固定 4096 token 的输出预算；超长摘要仍可能被截断（此时折叠只推进游标、
  不重命名，避免同一批事件被反复重喂）。
- 开启状态下，用户手动改过的标题也会在下一轮被插件更新（关掉开关即停止）。
- 子会话（subagent）被跳过，只管理其父会话的标题。

## License

BSD-3-Clause.
