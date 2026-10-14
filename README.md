# FloWork

以 [pi coding agent](https://github.com/badlogic/pi-mono)（`@earendil-works/pi-coding-agent`）为内核、以对话为中心的开发者工具。先支持 Windows。

同一套代码提供两种外壳：

- **网页版**（当前主要开发形态）：浏览器访问本地服务 `http://127.0.0.1:17321/`
- **桌面版**：Electron 应用，界面与后端逻辑和网页版共用

## 快速开始（网页版）

```bash
npm install
npm run build:web     # 构建页面与本地后端
npm run start:web     # 启动并打开浏览器：http://127.0.0.1:17321/
```

打开后先到 **设置 → 模型供应商** 填写 API Key（或在“自定义端点”添加 OpenAI 兼容接口），再选择一个项目文件夹开始对话。

开发时使用热更新模式：

```bash
npm run dev:web       # 页面：http://127.0.0.1:5173/（Vite 热更新），后端代码变更后自动重启
```

## 架构

```text
界面（React 19 + Tailwind 4 + zustand）── src/renderer
   │  Transport：网页版 WebSocket（/ws）｜桌面版 Electron IPC（preload）
后端核心 Backend ── src/core（与外壳无关）
   │  外壳：src/server（Node HTTP + ws，仅监听 127.0.0.1）｜src/main（Electron 主进程）
   │  worker 消息：命令 / 响应 / 事件 / 登录交互（src/shared/protocol.ts）
pi worker ── src/worker（网页版用 child_process，桌面版用 utilityProcess）
   ├─ service worker × 1：会话列表、供应商与模型、登录 / 登出、测试连接、配置文件读写
   └─ session worker × N：每个打开的工作区一个，承载 pi AgentSessionRuntime
```

- pi 以 **SDK** 方式运行在独立子进程中：可以使用 SDK 的完整能力（会话树导航、OAuth 登录、资源重载等），pi 或扩展崩溃不会影响界面和后端。
- 内部协议的命令和事件命名沿用 pi RPC，并补充了 RPC 没有的能力（`navigate_tree`、`list_sessions`、交互式登录、配置读写等）。
- **适配层**：pi 的类型只在 `src/worker/adapter.ts` 中解读，界面只依赖 `src/shared/protocol.ts`。升级 pi 时优先检查适配层。pi 版本锁定在 `1.1.0`。
- **网页版安全边界**：服务只监听 127.0.0.1，WebSocket 校验 Origin（只接受本服务和开发模式的 Vite 地址），防止其他网站经浏览器连接。本机其他进程仍可连接，因此不要把端口转发到外网。
- **内置浏览器（仅桌面版）**：网页由主进程的 Electron `WebContentsView` 承载，渲染进程只通过 IPC 下发标签命令与视口矩形，网页内容不进入应用渲染进程；网页运行在独立隔离 session 中，权限、下载、非 HTTP(S) 导航与应用自身地址一律拒绝（详见「发布版的安全边界」）。Web 版无法可靠嵌入任意网站，只提供「在外部浏览器打开」。
- **运行时**：pi 要求 Node ≥ 22.19（项目 `.nvmrc` 为 24.21.0）。网页版后端按以下顺序选择 Node：当前 Node（满足要求时）→ 环境变量 `FLOWORK_NODE` → nvm 已安装的最高满足版本（读取 `NVM_SYMLINK` / `NVM_HOME` / `NVM_DIR`）→ Electron 自带的 Node 24（`ELECTRON_RUN_AS_NODE=1`）。启动时会打印实际使用的运行时。构建工具（Vite、esbuild、tsc）对 Node 版本没有这一要求。

## 目录

```text
src/
  shared/protocol.ts        内部协议：数据形状、worker 命令与事件、Transport 信封
  shared/browser.ts         内置浏览器（桌面版）：标签状态、命令、IPC 通道与地址规范化
  core/                     后端核心（无 Electron 依赖）
    backend.ts              请求分发、推送、配置变更后通知各会话刷新
    worker-manager.ts       worker 启动、请求关联、退出处理（启动方式由外壳注入）
    fs.ts / paths.ts        目录浏览、pi 配置目录
    smoke-checks.ts         两种外壳共用的冒烟检查
  worker/                   pi worker
    session-host.ts         承载 pi 会话
    service-host.ts         供应商、登录、测试连接、配置文件
    session-files.ts        历史会话的校验、重命名与删除
    config-file.ts          settings.json / models.json 的串行写入与原子替换
    adapter.ts              pi → FloWork 数据适配
  server/                   网页版外壳（HTTP 静态页面 + WebSocket）
  main/ + preload/          桌面版外壳（Electron）；main/browser.ts 承载内置浏览器视图
  renderer/                 界面（两种外壳共用）
    src/api/                Transport 选择与类型化 API
    src/components/settings 设置页：模型供应商 / 自定义端点 / 偏好设置 / 配置文件
scripts/                    网页版构建、开发、启动脚本，以及自起隔离后端的回归脚本
```

## pi 配置目录

默认使用 `~/.flowork/agent`，与 pi CLI 的 `~/.pi/agent` 隔离，其中存放 auth.json、models.json、settings.json、sessions/、skills/ 等。可以通过环境变量 `FLOWORK_PI_AGENT_DIR` 覆盖。设置页中的所有修改都写入这个目录：

| 设置页 | 写入 |
| --- | --- |
| 模型供应商（API Key / 订阅登录 / 登出） | auth.json（明文；桌面版计划改用系统加密存储） |
| 自定义端点 | models.json 的 `providers` |
| 偏好设置 | settings.json |
| 配置文件 | 直接编辑 settings.json / models.json（auth.json 不在页面中显示） |

## 命令

```bash
# 网页版
npm run dev:web       # 开发模式（Vite 热更新 + 后端自动重启）
npm run build:web     # 构建到 out/web/
npm run start:web     # 启动已构建的网页版并打开浏览器
npm run smoke:web     # 构建并运行网页版后端冒烟检查（不调用模型）

# 桌面版
npm run dev           # 开发模式
npm run build         # 构建到 out/
npm run pack:win      # 构建并打包成免安装目录 release/win-unpacked/（用于验证，可直接运行 FloWork.exe）
npm run dist:win      # 构建并打包成 Windows 安装包 release/FloWork-<版本>-x64-setup.exe
npm run smoke         # 构建并运行桌面版冒烟测试；加 --screenshot <path.png> 可保存截图

npm run typecheck     # 类型检查（全部代码）
```

Electron 二进制在首次运行（`npm run dev`）与打包（`npm run pack:win` / `npm run dist:win`）时下载；网络受限时可以设置镜像：`set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（打包时同样读这个环境变量）。

## 桌面版发布

打包配置在 `electron-builder.yml`，产物写到 `release/`（已忽略，不入库）：

- `npm run pack:win` 出免安装目录 `release/win-unpacked/`，不需要 nsis 工具链，适合本地验证。
- `npm run dist:win` 出 nsis 安装包（可选安装目录、创建桌面快捷方式、不要求管理员权限）。

打包内容只有 `out/main`、`out/preload`、`out/renderer` 与 package.json 里的生产依赖；网页版产物（`out/web`）与源码不进安装包。`node-pty` 与 `esbuild` 带原生模块 / 可执行文件，通过 `asarUnpack` 解包到 `app.asar.unpacked/`（asar 内的 `.node` 加载不到、`esbuild.exe` 也执行不了）。`npmRebuild` 关闭：node-pty 自带 N-API 预编译二进制，跨 Electron ABI 可用，不需要本地 C++ 工具链。

安装包暂时使用 Electron 默认图标；发布前把 `icon.ico` 放到 `build/`（electron-builder 的默认资源目录）即可。

发布版的安全边界：

- **CSP**：`renderer.config.ts` 中的插件只在生产构建往 `index.html` 注入 `Content-Security-Policy`（桌面版与网页版共用同一份策略）；开发模式不注入，否则 Vite HMR 的内联脚本与 websocket 会被挡掉。具体策略见该文件里的注释。
- **外链白名单**：主进程只把 `http:` / `https:` 链接交给系统浏览器（`setWindowOpenHandler`），其它协议一律拒绝并打日志；页面内导航（`will-navigate`）只允许留在应用自身，其余同样交给白名单处理。
- **内置浏览器**：网页运行在独立隔离 session（独立 partition、禁缓存），权限请求、设备权限、屏幕共享与下载一律拒绝；只允许 HTTP(S)，`will-frame-navigate` / `will-redirect` 拦截非白名单导航与重定向；禁止访问 FloWork 应用自身地址与控制端口，避免页面回连本地控制服务；弹窗需用户手势（1 秒内点击 / 回车）才开新标签，否则拒绝。
- **凭据**：auth.json 目前仍是明文（见「pi 配置目录」），改用系统加密存储尚未实现。

## 已实现

- 对话：流式输出、思考过程、终端式工具调用展示、Markdown 渲染
- 工具审批：修改与命令前确认（默认）/ 全部确认 / 关闭；可“本会话始终允许”某个工具；拒绝原因会告诉模型
- 修改 diff：edit 使用 pi 自带的 diff；write 由 FloWork 扩展在执行前快照、执行后生成 diff
- 会话树：查看分支、回到任意节点继续（用户消息会填回输入框以便修改重发）、分叉为新会话、节点标签
- Windows：自动识别 Git Bash（包括非默认安装位置），避免 bash 工具落到 WSL；设置页显示实际使用的 shell
- 项目：侧边栏导入多个项目（可多选、可从已有会话发现），置顶、分组、拖拽排序、重命名、移除；项目展开显示会话；切换项目时原项目的 pi 进程继续在后台运行，侧边栏显示运行中 / 待确认 / 已完成。项目列表保存在 `~/.flowork/projects.json`
- 会话管理：历史会话可重命名（留空恢复默认标题）与删除；当前打开和后台项目的会话同样支持。删除前确认，只删除会话记录，不删除项目文件、不级联删除分叉会话；运行中或等待交互的会话拒绝删除，空闲的打开会话先关闭 pi 进程再删除，避免记录被重新写回
- 文件：项目文件树（按 .gitignore 置灰）、会话文件（本会话读取/修改的文件与增删行数）、全项目模糊搜索与 Ctrl+P 快速打开
- 代码查看与编辑：CodeMirror 语法高亮、查找；编辑后 Ctrl+S 保存，文件已被 AI 或外部修改时拒绝保存以免覆盖；对话中的代码块同样高亮
- 内置浏览器（仅桌面版）：右侧面板的「浏览器」标签内嵌网页，与聊天并排。多标签（最多 32 个）、前进 / 后退 / 刷新 / 停止、地址栏（Ctrl+L 聚焦），面板宽度可拖拽调整并记忆。网页由主进程的 `WebContentsView` 承载，跟随面板位置、窗口缩放与遮挡自动重排；标签属于窗口，不随聊天会话切换而关闭。网页内 Ctrl+L / Ctrl+K 会把焦点交回应用。Web 版无法可靠嵌入任意网站，只提供「在外部浏览器打开」
- 技能与扩展：按项目列出技能、扩展、提示模板与 pi 包（含已禁用的）；导入本地文件夹（全局或仅当前项目）、启用 / 禁用、删除导入的副本、安装 npm / git pi 包；变更后各会话自动重新加载。输入框输入 / 时补全 /skill:名称、提示模板与扩展命令
- 第三方扩展界面：扩展的 select / confirm / input / editor 对话框以终端提示的形式出现在会话末尾（键盘操作，带超时倒计时，后台项目等待时侧边栏与状态栏计入“待确认”）；setStatus 显示在状态栏，setWidget 显示在输入框上下方，notify 显示为通知，setEditorText 填入输入框。依赖终端界面的能力（自定义组件、页眉页脚、主题切换）不支持
- 项目信任：项目含 .pi/ 配置或项目内 .agents/skills 时，未经确认不加载（pi SDK 默认会直接信任）；决定保存在 trust.json
- 设置：模型供应商（API Key / 订阅登录 / 测试连接）、自定义端点、偏好设置、配置文件编辑
  - 模型供应商默认只显示「常用」的主流厂商，支持订阅登录的不在其中，其余可在「全部」查看；已配置的始终显示
  - 自定义端点按模型逐个配置：显示名、上下文窗口、最大输出、思考、图片输入、价格，以及思考等级映射（`thinkingLevelMap`）等其余字段；留空的字段不写入 models.json
  - 配置保存前校验磁盘文件是否被外部修改（mtime），不一致时提示重新加载或明确覆盖，避免静默覆盖别人的改动

FloWork 对 pi 的扩展集中在 `src/worker/flowork-extension.ts`（以内联扩展方式注入，不修改 pi 本身）。

## 开发辅助脚本

```bash
node scripts/ws-call.mjs service.send '{"type":"get_shell_info"}'   # 向运行中的后端发一个请求
node scripts/e2e-session.mjs <目录> <provider/model> allow|deny|deny-bash "<提示词>"   # 端到端会话测试（会真实调用模型）
node scripts/shoot-ui.mjs <输出目录>                                  # 对 dev:web 页面截图（注入示例会话）

# 回归脚本：各自启动隔离后端（独立 FLOWORK_DATA_DIR / FLOWORK_PI_AGENT_DIR），
# 不写真实配置目录、不调用模型，断言失败时返回非零退出码。需要先 npm run build:web。
node scripts/test-sessions.mjs    # 会话重命名与删除
node scripts/test-projects.mjs    # 项目注册表
node scripts/test-resources.mjs   # 技能 / 扩展 / 提示模板与包管理
node scripts/test-ext-ui.mjs      # 第三方扩展对话框与界面接口
```

## 路线图

- **M3**：内置终端与内置浏览器；转为桌面版发布。electron-builder 打包与收紧 CSP 已完成（见「桌面版发布」），凭据改用系统加密存储待做。
