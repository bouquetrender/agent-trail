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
- 直接写入文件系统视为 Agent 修改；使 VS Code 文档变为未保存状态的操作视为用户修改。
