# dsh-session-title-summary — 滚动会话摘要 + 当前任务标题

[English](README.md) | 中文

[![GitHub stars](https://img.shields.io/github/stars/xiaochaZ/dsh-session-title-summary?style=flat-square)](https://github.com/xiaochaZ/dsh-session-title-summary)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-blue?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/dsh-%E2%89%A50.1.1--rc.1-purple?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

一个纯 host 端的 DeepSeek Harness (DSH) 插件：每轮对话结束后，把该轮的新工作
（用户消息、助手回复、工具调用）折叠进**可持久化的滚动摘要**，并把会话重命名为
反映**当前任务**的标题。完全基于官方 NPM SDK 实现——不改动 DSH 源码。

## 工作原理

- 插件监听每个存活会话的 `turn/end` 事件。
- 自上次折叠以来的新事件被提取为文本（提示词、回复、工具名 + 参数、工具结果）。
- 该摘要与之前的滚动摘要一起，发送给会话当前使用的同一条模型路由；模型返回一个
  JSON 对象：更新后的摘要 + 新标题。
- 更新后的摘要按会话原子写入
  `$DSH_HOME/dsh-session-title-summary/<sessionId>.json`，并通过官方 `sessionTitle`
  服务完成会话重命名。

### 你要的"越往前越少"

每次折叠都会压缩旧摘要、保留最新工作的细节——越早发生的内容在摘要里保留得越少，
而当前任务保持具体。像"解压文件后分类整理照片"这样的长会话，每个阶段都会留在摘要
里，整理步骤描述得最详细，标题则跟随当前正在进行的步骤。

### 缓存安全

`session/title` 事件是纯日志事件：它从不进入 `deriveMessages()`、系统提示词、
工具 schema 或请求前缀，因此重命名不会影响输入缓存命中率或 KV 缓存。折叠本身是
一次独立的辅助模型请求（`purpose: "session-title"`），使用独立提示词——不与主对话
共享前缀。

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

安装后**重启 `dsh web`**。插件在下一次对话结束后生效。

## 配置

Web 设置界面会渲染本插件的配置区：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关闭后标题不再被自动修改（插件不再做任何事）。 |
| `targetWords` | `5` | 非 CJK 会话的标题目标词数。 |
| `targetCjkCharacters` | `10` | CJK 会话的标题目标字数。 |
| `provider` / `model` | 会话路由 | 可选显式 LLM 路由覆盖；默认跟随会话当前模型。 |
| `maxOutputTokens` | `256` | 每次折叠的模型输出预算。 |
| `timeoutMs` | `60000` | 每次折叠的调用超时。 |

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

- 一次折叠若模型输出不可用，会推进游标但不重命名，避免同一批事件被反复重喂。
- 开启状态下，用户手动改过的标题也会在下一轮被插件更新（关掉开关即停止）。
- 子会话（subagent）被跳过，只管理其父会话的标题。

## License

BSD-3-Clause.
