# cursor-forgery

<img width="100%" height="auto" alt="ScreenShot_2026-09-03_181158_713" src="https://github.com/user-attachments/assets/b3858d45-e78c-4398-9b2a-ed25f9cfb535" />

[English](README.md) | [简体中文](README.zh-CN.md)

`cursor-forgery` 是一个模仿 Cursor 交互操作的 VS Code 扩展插件，用于审查 Agent 对代码文件的修改，也可快速将代码选区、整个文件或当前文件夹加入 Codex 对话。插件不调用任何 API，也不会修改 Agent 的工作方式。

## 使用流程

1. 打开或重新加载工作区，扩展会自动捕获基线。
2. 让 Codex、Claude 或其他 Agent 修改工作区文件。
3. 在资源管理器中打开 **AGENT CHANGES**。
4. 点击文件或变更块，打开当前文件并定位到对应代码行。
5. 使用树视图或 CodeLens 接受、拒绝变更；在编辑器或差异块的右键菜单中，通过 **More Review Actions → Request Change** 请求修改。需要手动重置基线时，可运行 **Agent Review: Start Session**。

## 侧边栏

- **Pending Review（待审查）**：尚未处理的变更。Accept 或 Reject 后会消失。
- **History（历史）**：当前会话的只读历史，默认收起。新增和删除文件作为只读的整文件变更显示在这里，不会进入待审查。同一位置的新变更会覆盖旧记录；新会话开始时清空。点击历史记录打开的是当前文件，记录的行位置可能已经变化。

空视图区分未启动、正在捕获基线、已就绪且没有待审查变更。仅存在待审查变更时显示批量接受和拒绝按钮。状态栏显示待审查文件数和变更数；自动启动通过状态栏反馈捕获状态，不弹出成功通知，失败仍会通知。

## Agent Lens Session / Timeline

**SESSION TIMELINE** 按会话展示事件，并按时间升序排列；同一时间的事件保持记录顺序。
基线捕获完成后自动开始 Agent Session。运行 Start / Reset 会结束旧 Session、捕获新基线并开始新 Session；旧 Timeline 保留，原有 Diff Review 的 History 仍按原规则重置。

运行 **Agent Lens: End Agent Session** 或点击 Timeline 的停止按钮可结束事件记录。结束前会处理已经观察到的文件事件；结束后 Diff Review、Accept、Reject 和 History 仍然可用。再次运行 Start / Reset 可以开始下一次记录，同时重置审查基线。

本阶段 Session 和 Event 仅保存在内存，重载窗口后清空。Agent / provider 默认是 `unknown`，不会根据文件变化猜测身份。文件事件为 `source: filesystem`、`confidence: observed`，仅表示插件观察到了文件系统变化；保存用户编辑、构建工具等也可能产生这些事件。未保存的编辑不产生文件系统事件，仍按原有规则推进用户基线。

开发模型位于 `src/session/AgentSession.ts`。`SessionManager` 提供 `startSession`、`recordEvent`、`endSession`、`getCurrentSession`、`getSession` 和 `getSessions`；`EventStore.getEvents(sessionId)` 返回有序只读事件快照。时间戳使用 Unix 毫秒，结束的会话不再接受新事件。支持七种事件：`session-start/end`、`file-created/modified/deleted`、`command-start/end`，以及 `observed`、`reported`、`inferred` 三种可信来源标记。命令事件目前仅提供强类型记录接口，尚未接入终端监听或 Agent 上报传输。

`FileChangeCollector` 采集工作区 UTF-8 文本文件的文件系统通知，继续驱动已有差异计算和整文件 History，同时写入事件。它不改变接受/拒绝语义，也不把文件通知作为 Agent 身份证据。Timeline 记录监听器实际收到的通知，操作系统合并的底层写入无法逐次还原。

## 审查操作

- `Accept`：保留当前代码，并推进基线；编辑器撤销无法撤销接受操作。
- `Reject`：用基线内容恢复代码。
- `Request Change`：选中变更代码并加入 Codex 对话。

**Reject All** 会先显示涉及的文件数并请求确认。如果确认期间目标文件或基线发生变化，操作会停止，供你重新检查最新变更。

在 VS Code 中手动编辑文件会接管当前文件：扩展会更新基线并清除该文件的待审查变更。

## Codex 上下文

安装官方 Codex 扩展后，选中代码即可使用 `Add Selection`、`Add File`
或 `Add Folder`，将选区、整个文件或当前文件所在文件夹加入 Codex 对话。

## 命令

- `Agent Review: Start Session`
- `Agent Review: Reset Session`
- `Agent Lens: End Agent Session`
- `Agent Review: Open Change`
- `Agent Review: View Before ↔ After`
- `Agent Review: Accept Hunk`
- `Agent Review: Reject Hunk`
- `Agent Review: Request Change`
- `Agent Review: Accept File`
- `Agent Review: Reject File`
- `Agent Review: Accept All`
- `Agent Review: Reject All`

## 开发

```sh
npm install
npm run compile
npm run test:unit
npm run test:integration
```

按 `F5` 启动扩展开发宿主。需要 VS Code 1.85+；开发依赖支持 Node 16.20.1。

## 当前范围

- 已存在的 UTF-8 文本文件按行变更进行审查。
- 新增和删除的 UTF-8 文本文件作为整文件历史记录，不提供 Accept 或 Reject；重命名不会被单独识别。
- 暂不支持二进制和非 UTF-8 文件。
- Git 工作区使用隔离的临时环境，不会修改真实索引或暂存区。
- 非 Git 和多根工作区使用内存基线。
- Diff Review 继续将直接文件系统修改纳入待审查；使 VS Code 文档变为未保存状态的操作视为用户修改。Timeline 独立记录文件系统观察，不确认操作主体。
