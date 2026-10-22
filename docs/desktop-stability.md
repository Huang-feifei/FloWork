# 桌面稳定性与性能验证

本文记录移除早期 Web 外壳之后的增量修复及验证边界。所有应用回归均通过隔离 Electron / IPC；不恢复应用控制用 HTTP / WebSocket 后端，不使用真实用户配置或外部模型。

## 本轮交付状态

- 图库改动完成后重新执行类型检查与完整回归：**20 PASS / 4 SKIP / 0 FAIL / 0 BLOCKED**（PASS 包含类型检查、桌面构建和 IPC 入口构建）。4 个跳过项为 3 套 SSH 集成及数据库套件内的 PostgreSQL / MySQL 网络集成；不能视为全量外部集成验证通过。
- 隔离真实桌面 smoke 再次通过，确认 renderer → preload → ipcMain、service / session utilityProcess；未配置供应商、未调用外部模型。
- 此前图库字段未齐全、`store.ts` 图片方法区重复声明和分隔符造成的验收阻塞已消除。最新诊断在 `out/stability-tests.log` / `out/stability-typecheck.log` / `out/stability-smoke.log`。
- 另以隔离 agent 缓存中的 3 张本地 PNG 做真实桌面图库复核：全部 / 近 7 天 / 按模型 / 收藏筛选、收藏与取消收藏、筛选空状态、PNG 实际解码、插入会话附件、清空缓存及保留已插入附件均通过。通过实际图片 IPC 读写，不调用图片生成接口；结果在 `out/gallery-review.json` / `.log` / `.png`。
- 图库收藏当前保存在 store 内存中，本次只验证运行期间的收藏切换，不代表重启后持久化。图片生成外部接口及实际文件下载未在此次图库复核中验证。
- 本次复核未修改图库或其他业务代码，仅更新验证记录；没有提交或推送。

## 修复与测试分层

| 项目 | 实现 | 主要验证 |
| --- | --- | --- |
| 会话异步归属 | 捕获 handle + sessionId；过期树请求按 token 丢弃；后台取回的文字 / 图片草稿暂存至切回 | `test-session-store.mjs` 使用真实 Zustand store 和延迟桥响应，覆盖跨标签、换记录、关闭、乱序树与队列草稿 |
| Markdown 图片 | 工作区本地图片经 `workspace.image` 读取为 data URL；校验扩展名、工作区真实路径、普通文件和 8 MB 上限；加载失败显示提示 | `test-markdown-desktop.mjs` 在真实生产 CSP 下实际解码 PNG / SVG，拒绝越界、junction / symlink、非图片和超限文件 |
| Worker 生命周期 | 查询 30 秒、一般操作 120 秒、包操作 600 秒；prompt / OAuth / 树导航模型摘要无固定任务总时限；15 秒间隔的独立 ping 使用 30 秒响应时限 | `test-worker-manager.mjs` 使用可控进程替身验证时序；常规 sessions / resources / ext-ui 等套件另走真实 utilityProcess |
| 人工等待和取消 | 扩展 UI、审批和 OAuth 输入期间暂停普通任务计时，结束后重新计时；心跳始终独立；取消 OAuth 后最多等待查询时限收敛 | 替身覆盖正常等待、真正失联、取消未响应；没有实连外部 OAuth 服务 |
| 不确定副作用 | 超时或已发送后的 AbortSignal 取消停用 worker，拒绝 pending 并尝试终止，不自动重试；真实 exit 前不释放文件锁 | 替身覆盖迟到响应、协调队列恢复、kill 后未退出，以及会话切换的原文件 / 目标文件双重保锁 |
| 测试状态 | 结构化 JSONL 区分整套 / 部分跳过；非零退出优先 FAIL；构建等前置失败使相关套件 BLOCKED | `test-test-results.mjs` 验证分类、跨进程报告、严格门禁真实退出码 |
| 首屏依赖 | Markdown 的 CodeBlock 按需加载；等待时显示纯文本代码，语言包仍按需加载 | 桌面回归确认打开代码块之前未生成高亮预加载请求，打开之后高亮 span 实际出现 |

超时 / 取消不保证已执行的文件写入、包安装或远端操作已经回滚。错误会提示操作可能已经生效，用户应先检查再重试。杀进程请求也不等于进程已退出。

工作区图片的 8 MB 限制涵盖本地及 `workspace.image` 远程分支。服务器任意目录预览仍使用既有 `server.download` 传输限制，不是上述工作区路径边界；其真实 SSH 加载尚未验证。生产 CSP 仍为 `img-src 'self' data: blob:`，没有允许任意 HTTP(S) 图片请求。

## 可复现命令

```bash
npm test
npm test -- --require-all
npm test -- --no-build sessions ext-ui markdown-desktop

# 先完成生产构建，再运行；压测会显示隔离窗口以确保帧时钟持续运行
npm run build
node scripts/benchmark-transcript.mjs

# 体积报告会重新构建，但不会改变分包策略
node scripts/analyze-renderer.mjs
```

- 普通模式允许环境 SKIP，但会明确说明不是全量集成验证通过。
- `--require-all` 遇到任何跳过项也非零退出。SSH 所需环境见 README；PostgreSQL / MySQL 网络集成还需 `FLOWORK_TEST_DATABASES=1` 与 Docker。
- `--no-build` 不检查产物是否与当前源码一致；它只确认所需入口存在。修改代码后请先构建。
- 本地图片 / 高亮桌面回归包含生产 renderer → preload → ipcMain 请求。`npm run smoke` 另验证完整桌面桥和真实 worker 的基础链路；人工运行 smoke 时也应设置隔离 HOME / USERPROFILE / FLOWORK_DATA_DIR / FLOWORK_PI_AGENT_DIR，避免使用真实配置。

## 长会话实测

环境：Windows 11（10.0.22631）、AMD Ryzen 9 7950X、32 逻辑核、约 63 GiB 内存；Electron 44.7.0 / Chromium 152。以下是一次最终复测，不是跨机器性能承诺。

每场景注入 1,000 / 10,000 / 30,000 条消息，包括 thinking、edit 工具调用、约 3.6 KB 工具结果、Markdown 与 note。每场景 150 次约 30 Hz 更新，每 10 次追加一条完成消息；历史过程折叠、视口置底。

| 消息数 | 首挂 ms | 更新 P95 ms | 追加 P95 ms | 帧间隔 P95 ms | ≥50ms long task | 初挂行数 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 102.2 | 9.9 | 10.5 | 10.1 | 0 | 80 |
| 10,000 | 34.3 | 10.2 | 15.7 | 10.1 | 0 | 80 |
| 30,000 | 40.5 | 10.4 | 19.2 | 10.1 | 0 | 80 |

同机另一次复测中，30,000 条消息的追加 P95 为 44.5ms，1,000 条的首次挂载为 205.5ms，说明尾延迟和首次懒加载存在波动。原始结果以本次运行生成的 `out/transcript-performance.json` 和 `.png` 为准，不将这些单次数字设为 CI 硬门槛。

### 解释边界

- 使用真实生产 DOM，但直接注入 store；不包含磁盘读取、会话反序列化、历史消息 IPC 传输或外部模型响应。
- 更新时延量到 DOM 提交，不等同于屏幕绘制或端到端输入延迟；帧间隔依赖当前机器及窗口状态。
- 首挂发生于 renderer 已经启动之后，不是应用冷启动时间。第一场还受懒加载、JIT / 缓存影响，不能按消息数量直接比较首挂数字。
- 工具过程折叠，未覆盖全部展开、持续上翻加载更多、超大代码块及所有真实扩展消息形态。
- heap 未强制 GC，可能包含场景累积和浏览器缓存；不能据此判断内存泄漏。
- `mountedRows > 80` 会使压测失败；其余时延先记录，不设跨机器阈值。

目前没有在这些场景观察到必须重写 Transcript 的证据，因此保留已有 80 条起始窗口，不引入新的虚拟化或增量索引架构。全量遍历仍可能在更大数据、低配机器或不同展开方式下成为热点。

## Chunk 依赖与低风险优化

可选构建报告 `out/renderer/bundle-analysis.json` 包含最终 chunk 的 code 字节数、静态 / 动态依赖以及按构建器 `renderedLength` 排序的模块贡献。模块贡献是压缩前估算，不能当作最终 gzip 占比。普通构建不输出该报告。

分析发现原入口约 **2.09 MB**，主要包含 React DOM，以及由静态代码块导入带入的 CodeMirror view / state / language。将 CodeBlock 延迟加载后，入口约 **1.46 MB**，减少约 **30%**；约 **0.63 MB** 高亮共享依赖改到首次需要代码块 / 编辑器时加载。设置、数据库、终端和其他既有懒加载不变。

这里比较的是构建代码体积（非 gzip）。总依赖没有因此消失，也不代表安装包缩小或冷启动时间提升 30%；尚未做应用冷启动的多次统计。加载高亮期间保留可读纯文本，生产 CSP 不变。

## 仍需外部环境验证

- SSH 远程工具、完整运维会话和主机密钥变更集成：需要专用测试主机；密钥测试还需可重建密钥的测试容器。
- PostgreSQL / MySQL 网络集成：需要启用环境变量和 Docker；SQLite 通过不代表网络数据库通过。
- 远程 Markdown 图片的实际 SSH 传输；外部供应商和 OAuth 的真实网络行为。
- 发布安装包的实际安装、升级和卸载。桌面源码构建 / smoke 通过不等于发布安装流程通过。
