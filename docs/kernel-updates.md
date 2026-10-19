# GitHub Releases 独立内核更新

桌面版支持在 **设置 → 内核更新** 中检查、下载和安装独立内核，不必重新下载 FloWork 安装包。第一版采用 **重启应用后生效**，不会在正在执行的会话中热替换代码。网页版暂不支持此更新通道。

## 一次性配置（发行者）

### 1. 准备公开 GitHub 仓库

使用公开仓库的 Releases 存放内核附件，格式为 `owner/repository`。可以与 FloWork 源码仓库相同，也可以使用专门的公开发布仓库。

客户端使用 GitHub 的公开 API，不保存 GitHub Token。私有仓库与第三方镜像暂不支持。未登录请求受 GitHub IP 限流影响，网络不可用或请求受限时会提示重试，不会影响当前内核。

### 2. 生成签名密钥

```bash
npm run kernel:keygen
```

生成：

- `.kernel-keys/signing-private.pem`：**私钥，不得提交、打包或提供给用户**。请安全备份。
- `.kernel-keys/signing-public.pem`：公钥，允许随应用公开。

脚本不会覆盖已有文件。`.kernel-keys/` 已加入 `.gitignore`。

### 3. 配置应用信任根

编辑根目录 `kernel.config.json`：

```json
{
  "repository": "你的GitHub用户名/FloWork",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n这里替换成脚本输出的完整公钥\n-----END PUBLIC KEY-----\n",
  "bundledVersion": "1.0.0"
}
```

`publicKey` 必须使用生成脚本输出的完整 JSON 字符串，不能使用示例占位内容。

- `repository` 是唯一的发布源，不从远端更新清单中读取。
- `publicKey` 是 Ed25519 验签公钥；只有匹配的私钥才能发布可执行内核。
- `bundledVersion` 是安装包自带的 **FloWork 内核包版本**，不等于 Pi SDK 版本。应用自带的 Worker / 内核变更时也应递增该版本。

这份配置在构建时进入主进程代码。先发布一次包含更新器、正确仓库和公钥的 FloWork 安装包，用户安装后，后续才能通过按钮独立更新内核。更换仓库或签名公钥也需要重新发布应用。

**不要使用上游 Pi 仓库作为更新源**：上游没有 FloWork Worker、兼容清单和你的发行签名。

## 手动发布内核

### 1. 升级并验证

```bash
npm install --save-exact @earendil-works/pi-coding-agent@<目标版本>
npm test
```

检查 `src/worker/` 与新版 SDK 的兼容性，必要时适配。内核更新包包含 Worker 与适配层，所以只要外部协议仍兼容，就不需要同步更新界面。

### 2. 构建签名包

Windows x64 包应在 Windows x64 上构建（运行依赖可能含平台相关二进制），使用 Node ≥ 22.19，推荐 Node 24：

```bash
npm run kernel:build -- --version 1.0.1 --key .kernel-keys/signing-private.pem
```

也可以设置 `FLOWORK_KERNEL_SIGNING_KEY` 环境变量，值为完整 PEM 私钥内容，省略 `--key`。

脚本会：

1. 通过项目 `package-lock.json` 执行隔离的 `npm ci --omit=dev --ignore-scripts --no-bin-links`，固定直接和传递依赖。
2. 构建独立 `pi-worker.js`，携带 Worker 适配层及生产依赖；不包含发行私钥。
3. 在临时配置目录中验证真实 service 和 session Worker（不调用模型，不加载真实会话）。优先使用满足要求的 Node，必要时使用 Electron 自带的 Node。
4. 生成 `.tar.gz` 运行包，计算 SHA-256，并对清单原始字节做 Ed25519 签名。

产物在 `release/kernels/`：

```text
flowork-kernel-1.0.1-win32-x64.tar.gz
flowork-kernel-win32-x64.json
```

可选参数：

```text
--min-app 1.0.8           最低 FloWork 版本（默认当前 package.json 版本）
--max-app 1.9.99          最高 FloWork 版本（默认不限）
--min-node 22.19.0        最低内置 Node 版本（默认从 Pi engines 推导）
--min-electron 44.7.0     最低 Electron 版本（默认当前项目 Electron 版本）
--out release/kernels    输出目录
--config <json>          开发/隔离验证用的替代签名配置，正式发布使用默认配置
```

独立内核不能升级 Electron 本身。如果新 Pi 需要用户现有应用不支持的 Node / Electron，设置对应最低版本，让旧应用提示先升级 FloWork。

### 3. 创建 Release

在配置的公开仓库中创建 **正式发布**：

- Tag：`kernel-v1.0.1`，必须与内核包版本完全一致。
- 上传上述两个附件，保持文件名不变。
- Release 正文填写内核更新说明。
- 不选 Draft 或 Prerelease。

例如使用 GitHub CLI：

```bash
gh release create kernel-v1.0.1 \
  release/kernels/flowork-kernel-1.0.1-win32-x64.tar.gz \
  release/kernels/flowork-kernel-win32-x64.json \
  --repo owner/repository --title "FloWork Kernel 1.0.1" --notes "升级 Pi，修复……"
```

每次发行使用新版本号。**已发布版本的运行包不可覆盖**；同一版本号出现不同摘要时，客户端会拒绝替换已安装副本。

客户端查询最近 100 个 Releases，只考虑 `kernel-vx.y.z` 的稳定版本，并按版本号选择比当前/待生效内核更新的兼容包。应用发布（例如 `v1.0.9`）与内核发布可以共用仓库，但若发布频率很高，应使用独立内核仓库，避免旧内核被挤出查询范围。

## GitHub Actions 自动发布

仓库已包含 `.github/workflows/kernel-release.yml`，当前只构建 Windows x64。

1. 把正确的 `kernel.config.json` 提交到源码仓库（**只包含公钥**）。
2. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 中添加 Secret：
   - 名称：`FLOWORK_KERNEL_SIGNING_KEY`
   - 值：`signing-private.pem` 的完整内容。
3. 提交已验证的 SDK / Worker 变更，再推送内核标签：

```bash
git tag kernel-v1.0.1
git push origin kernel-v1.0.1
```

工作流会在 Windows 上安装依赖、运行回归、构建和自检签名包，再创建 Release。自动工作流要求配置的发布仓库就是当前源码仓库；如使用独立发布仓库，可先手动上传，或自行添加具有目标仓库发布权限的受限 Token。

签名 Secret 只在构建步骤传入，不向测试步骤提供。不要把发布密钥暴露给不可信 PR；发布标签应由维护者控制。

## 客户端安装与回退

本地目录为 Electron `app.getPath("userData")/kernels/`（Windows 默认通常在 `%APPDATA%/FloWork/kernels/`，实际随应用 userData 配置而定）：

```text
kernels/
  active.json
  1.0.1/
    installed.json
    pi-worker.js
    package.json
    node_modules/
  1.0.2/
    ...
```

- **下载阶段**：限制下载大小，验证签名与兼容性，核对压缩包 SHA-256 和长度。
- **安装阶段**：先完整检查归档，拒绝路径逃逸、链接与特殊文件；解压到新目录并在隔离配置中启动 Worker 自检。
- **准备生效**：只写入 `pending` 选择，不改变本次运行的 Worker 入口。所有实际会话继续使用相同的旧内核。
- **下次启动**：重新验证清单、布局、运行环境与 Worker 启动。通过后才切换；失败时使用原活动版本，再尝试上一版本，最后使用应用内置版。
- **手动恢复**：设置页点“恢复内置内核”，重启后生效。内置版尚未切换时，可点“取消待生效更新”。

自检主要验证模块导入、协议和基础服务启动，不能替代真实会话行为的完整回归。新内核后来因项目扩展、模型或业务逻辑出错时，不会在运行中自动切换版本；可以手动恢复内置版。

更新器不删除 Pi 配置、认证与会话文件，也不在用户机器上执行 npm。若未来的 Pi 会迁移数据格式，发行者必须额外验证、备份并制定数据回退方案；代码回退不等于自动撤销数据迁移。旧内核目录暂时保留，不自动清理。

## 修改协议时

`src/shared/kernel.ts` 的 `KERNEL_PROTOCOL_VERSION` 是桌面界面/后端与外置 Worker 的兼容边界。

- 对已有命令/响应/事件做破坏性修改时，必须递增协议版本并发布新应用。
- 增加旧界面不使用的可选能力可以保持兼容；不能只为了允许下载而忽略实际协议变化。
- 客户端同时检查应用范围、协议版本、系统/架构和最低 Node / Electron 版本。

## 离线回归

```bash
node scripts/test-kernel.mjs
# 或
npm test -- kernel
```

使用临时目录、现场生成的测试签名和模拟的 GitHub 响应，不访问 GitHub、不写真实配置，覆盖正常更新、启动切换、恢复、下载损坏、签名失败、兼容性、路径/链接拒绝、并发互斥与网络错误。
