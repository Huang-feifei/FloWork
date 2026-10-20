# 官方 Pi 更新：维护者测试、签名放行、用户点击拉取

桌面版 **设置 → 内核更新** 不追随 Pi 官方的 `latest`。只有维护者在本地验证兼容并签名批准的版本，用户才能看到并下载安装。

```text
Pi 官方发布 → 维护者本地测试 → 发布签名兼容清单
                                     ↓
用户点击检查 → 核对应用/适配层是否获批 → 从官方 npm 拉取固定版本与依赖
                                     ↓
                              自检 → 重启后生效
```

**GitHub Releases 仅用于存放兼容清单，不存放重新打包的 Pi。** Pi SDK 及依赖来自官方 npm 分发源 `https://registry.npmjs.org`，而非下载 GitHub 源码后现场编译。无需维护 Pi fork，也不要求用户安装 Git、Node 或 npm。网页版暂不使用此更新通道。

## 为什么仍需维护者的清单仓库

上游只能说明“官方发布了哪个版本”，不能说明“你测试通过了哪些版本”。因此需要你可控的清单仓库，可以与 FloWork 源码仓库相同，也可以是一个仅放 JSON 附件的独立公开仓库。终端用户不需要登录 GitHub。

- **你的 GitHub**：批准哪一个 Pi 版本、适用于哪个 FloWork/适配层、固定依赖与完整性信息。
- **官方 npm**：提供该 Pi 版本及全部被批准的运行依赖。
- **应用内置适配层**：保持不变，不从远端下载新 Worker 代码。

## 首次配置（维护者）

1. 准备一个公开仓库，记录 `owner/repository`。
2. 运行 `npm run kernel:keygen` 生成 Ed25519 密钥：
   - `.kernel-keys/signing-private.pem`：**私钥，不得提交、上传为 Release 附件或打入安装包**。请安全备份。
   - `.kernel-keys/signing-public.pem`：公钥，可以公开。脚本会输出它的 JSON 字符串。
3. 编辑根目录 `kernel.config.json`：

```json
{
  "repository": "你的GitHub用户名/FloWork",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n替换成生成脚本输出的完整公钥\n-----END PUBLIC KEY-----\n",
  "bundledVersion": "1.0.0"
}
```

`repository` 与 `publicKey` 是随应用构建的信任根，远端清单不能修改它们。未配置时不会访问网络。更换公钥或仓库需要重新发布应用。公开 GitHub API 有 IP 限流；私有仓库和第三方 npm 镜像暂不支持。

**先发布一次包含这套更新器、正确仓库和公钥的 FloWork 应用**。已有的旧应用不会自动获得独立更新能力。

`bundledVersion` 是内置内核的更新批次基线，与 Pi 版本、FloWork 应用版本互相独立。例如内置批次 `1.0.0` / Pi `1.1.0`，之后放行批次 `1.0.1` / Pi `1.2.0`。后续批次使用递增的稳定 `x.y.z` 版本号。

## 每次放行官方版本

### 1. 本地升级和验证

使用 Node ≥ 22.19，推荐 Node 24；Windows x64 的放行在 Windows x64 上测试。

在目标 FloWork 应用对应的源码/适配层上升级 Pi，保留精确版本与 lockfile：

```bash
npm install --save-exact @earendil-works/pi-coding-agent@<目标版本>
npm test
npm run smoke
```

再手动验证实际业务：发送消息、工具调用、审批、恢复历史会话、资源/扩展、登录与模型等。自动自检不调用模型，不能代替这些人工兼容性测试。

**如果必须修改 `src/worker/` 或共享协议才能支持新 Pi，应先发布包含新适配层的 FloWork 应用，再为它放行。** 此通道仅升级官方 SDK 和固定依赖，不下发新的 FloWork 适配代码。

### 2. 生成签名放行清单

```bash
npm run kernel:approve -- --version 1.0.1 --key .kernel-keys/signing-private.pem
```

也可设置 `FLOWORK_KERNEL_SIGNING_KEY`，值为完整 PEM 私钥内容，省略 `--key`。

命令会：

1. 在隔离目录按照项目的 lockfile 执行 `npm ci --omit=dev --ignore-scripts --no-bin-links`；npm 镜像 tarball 地址还原为官方 npm 地址，保留原有版本和 integrity，不重新解析 `latest`。
2. 使用与应用构建相同的配方生成独立适配层，记录 SHA-256。也可用 `--adapter` 指定目标已发布应用内置的适配文件。
3. 获取当前平台实际安装的固定生产依赖，从官方 npm 验证每个 tarball 的 SHA-512 和大小。所有直接/传递依赖及嵌套安装路径均固定在清单中。
4. **复用客户端安装代码**，从这些官方 tarball 重新组装运行目录，不执行任何依赖的生命周期脚本，不创建 `.bin` 链接。
5. 在临时配置目录运行真实 service/session Worker 自检。通过后才写出签名清单，默认仅批准当前 FloWork 版本。

产物只有：

```text
release/kernels/1.0.1/flowork-pi-approval-win32-x64.json
```

没有 Pi `.tar.gz` 运行包。临时测试目录会清理；私钥不进入产物。已有清单不覆盖，应使用新批次/输出目录。

可选参数：

```text
--min-app 1.0.8          默认当前 package.json 版本
--max-app 1.0.8          默认等于 min-app，不能自动批准未测试的未来版本
--min-node 22.19.0       默认从 Pi engines 推导
--min-electron 44.7.0    默认当前项目 Electron 版本
--adapter <path>        使用目标应用内置的 kernel-adapter/pi-worker.js
--out <directory>       默认 release/kernels/<批次号>
--config <json>         隔离验证用的替代配置，正式放行使用默认配置
```

即使应用版本范围满足，客户端也要求适配层摘要与被测试的版本**完全相同**。设置较宽范围不能绕过适配层兼容限制。选择 `--adapter` 时，维护者还必须确认其协议版本与目标应用一致。

清单固定整个生产依赖树，也包含 Worker 所需的辅助库。未来新增依赖若需要安装脚本、任意下载站点、非标准 npm 归档或未列明的 bundled `node_modules`，命令会拒绝或自检失败；不要绕过校验签名放行。应调整依赖或先升级应用。

### 3. 发布兼容清单

在配置的公开仓库创建正式 Release：

- Tag：`kernel-v1.0.1`，与**放行批次**完全一致，不是 Pi 的 tag。
- 附件：上述 JSON，保持文件名不变。
- 正文：Pi 版本、人工测试范围与更新说明。
- 不选 Draft 或 Prerelease。

例如 GitHub CLI：

```bash
gh release create kernel-v1.0.1 \
  release/kernels/1.0.1/flowork-pi-approval-win32-x64.json \
  --repo owner/repository --title "批准 Pi 更新 · 1.0.1" --notes "已测试通过……"
```

客户端检查最近 100 个 Releases，只考虑正式稳定 `kernel-vx.y.z` 的签名放行，选择比当前/待生效批次更新且兼容的记录。可与应用 Release 共用仓库；发布频率高时建议独立清单仓库。

每次更改 Pi、依赖、兼容条件时都使用**新批次**。同批次不同内容不能覆盖已安装版本。

### 撤回尚未安装的放行

将对应 Release 删除、改为 Draft 或移除清单附件。客户端在安装前会再次检查 Release 和签名清单，拒绝沿用已撤回或被更改的缓存放行。

这不是远程停用功能：**已安装/已暂存的版本仍可离线启动，不会因撤回而删除用户内核或中断会话。** 如需建议用户回退，发布说明并提供新的已测试批次，或让用户手动恢复内置内核。

## GitHub Actions（可选）

`.github/workflows/kernel-release.yml` 在维护者推送 `kernel-v*` 标签时执行 Windows x64 回归、官方包重建自检并签名发布 **JSON 清单**，不上传 Pi 压缩包。

1. 提交正确的 `kernel.config.json`，只包含公钥。
2. 设置仓库 Secret `FLOWORK_KERNEL_SIGNING_KEY` 为私钥 PEM。
3. 本地测试通过并提交锁定的 Pi/依赖变更后，推送放行标签：

```bash
git tag kernel-v1.0.1
git push origin kernel-v1.0.1
```

工作流使用与目标应用相同的适配层配方；如果源码里的适配层已改变，只能为包含新适配层的应用提供放行。维护者仍负责实际模型/业务测试，CI 不会替你自动批准任意官方新版本。

自动工作流要求清单仓库就是当前源码仓库。独立清单仓库可以手动上传，或自行配置权限受限的发布 Token。签名 Secret 仅向放行步骤提供，不暴露给不可信 PR；发布标签应由维护者控制。

## 客户端安装、生效与回退

本地位置：`app.getPath("userData")/kernels/`。Windows 通常位于 `%APPDATA%/FloWork/kernels/`，以实际 userData 配置为准。

```text
kernels/
  active.json
  1.0.1/
    installed.json     # 签名兼容清单
    pi-worker.js       # 从当前应用复制的内置适配层
    package.json
    node_modules/      # 逐个校验、从官方 npm 解包的固定依赖
```

- 检查时只请求 GitHub 兼容清单；**不查询 npm latest，不允许 npm 任意版本或任意下载 URL**。
- 验证签名、平台/架构、应用版本范围、协议、最低 Node/Electron、内置适配层摘要。
- 安装前重新确认放行；从官方 npm 限量并发下载，逐包核对签名覆盖的 SHA-512、长度与路径。总下载上限 512 MiB。
- 安全解包拒绝路径逃逸、内容/大小写冲突路径、链接、特殊文件及未列入清单的 bundled 依赖；展开总量上限 2 GiB。兼容官方包的单层根目录和内部 `./` 路径，规范化后仅允许内容、模式完全相同的副本，并且只提取一次。
- 使用当前 Electron 启动隔离的 service/session Worker 自检，不调用模型、不加载用户扩展或真实会话。
- 完成后只记录 `pending`，本次运行继续使用原入口，避免混用 SDK。
- **重启后**重新验签、核对适配层和依赖版本、自检；失败时回退原活动版本、上一版本，最终使用应用内置版。无需网络。
- 可以手动恢复内置内核，或取消待生效更新。运行/等待交互中的会话需先结束再重启。

安装后不会每次启动重新下载或重新逐文件计算 SDK 摘要；签名和 tarball 完整性在下载时验证，启动时核对适配层、包元数据与实际可运行性。这不构成对同一系统用户恶意修改本地文件的防护边界。

更新不删除会话、配置或认证，也不升级 Electron 自身。若新版 Pi 迁移数据格式，维护者必须单独测试、备份并制定恢复方案；回退代码不等于撤销数据迁移。旧版本目录暂不自动清理。

## 协议与离线回归

`src/shared/kernel.ts` 的 `KERNEL_PROTOCOL_VERSION` 表示后端/界面与 Worker 的兼容边界，破坏性修改必须递增并发布新应用。不能只为了下载而忽略协议或适配层差异。

```bash
node scripts/test-kernel.mjs
# 或
npm test -- kernel
```

临时目录、测试密钥、模拟 GitHub/官方 npm 响应，无模型请求，不写真实配置。覆盖未批准官方新版、撤回、固定依赖下载、签名与摘要、适配层变化、离线激活、恢复、下载损坏/跳转、路径/链接拒绝与互斥。
