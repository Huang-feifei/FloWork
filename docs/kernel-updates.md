# 独立内核更新：维护者发布完整包

桌面版 **设置 → 内核更新** 只显示维护者测试并签名批准的版本，不追随 Pi 官方 `latest`。

```text
官方 Pi 发布 → 维护者本地升级固定依赖、测试适配
                         ↓
        构建完整内核包 + Ed25519 签名兼容清单
                         ↓
            上传到 GitHub Releases
                         ↓
用户检查更新 → 验签/兼容性 → 下载完整包 → SHA-256/安全解包/隔离自检
                         ↓
                 重启生效，失败回退
```

## 方案边界

- **GitHub Releases 托管完整运行包**，不再让客户端逐个从 npm 安装依赖。维护者构建时仍从官方 npm 获取锁定的 Pi SDK 和依赖，不维护 Pi fork。
- 完整包包含 Pi SDK 和全部固定运行依赖，不包含可远程替换的 FloWork Worker 适配代码。客户端始终复制当前应用内置适配层，并要求它的 SHA-256 与签名清单完全一致。
- 用户不需要安装 Git、Node、npm；使用 FloWork 自带的 Electron/Node。更新不升级 Electron 自身。
- 当前仅支持桌面版。破坏性协议变化或必须修改适配层时，先发布新版 FloWork，再放行内核。
- 这是与旧「GitHub 只放清单、客户端从 npm 下载」不同的分发方式。新更新要求 `format: 3`；已安装的 `format: 2` 仍可离线验证、启动和回退，不会被自动删除。

## 仓库与首次配置

`kernel.config.json` 的发布仓库为 `Huang-feifei/FloWork`，已配置本机生成的正式发行公钥。当前可保持私有用于维护者测试，未来转为公开不需要更改仓库地址。目前仅完成本地构建和验证，**未上传 Release**。

当前发行私钥保存在已忽略的 `.kernel-keys/signing-private.pem`；请妥善备份，不要重新生成以免与已发行客户端的公钥不匹配。下面是全新发行环境的首次配置步骤，不需要在当前机器重复执行：

1. 运行 `npm run kernel:keygen` 生成 Ed25519 发行密钥。
   - `.kernel-keys/signing-private.pem`：私钥，已忽略，需安全备份。**不得提交代码、上传为 Release 附件或打入应用。**
   - `.kernel-keys/signing-public.pem`：公钥，可以公开。
2. 将公钥的完整 PEM 内容写入 `kernel.config.json` 的 `publicKey`。
3. 重新构建、发行包含正确仓库和公钥的 FloWork。更新器不会从远端接受新的信任根。

仓库和公钥是随应用构建的配置，不是远程清单可修改的内容。未配置公钥时客户端不发起更新网络请求。

`bundledVersion` 为内置批次基线，不是 Pi 版本号。应用版本、Pi 版本和放行批次相互独立。例如：FloWork `1.0.8`、Pi `1.1.0`、放行批次 `1.0.1`。

### 私有仓库自测

普通客户端匿名访问私有仓库会得到 HTTP 404；你在 Git 中登录，不代表 Electron 自动拥有下载权限。

维护者可以在启动桌面版之前，通过**当前进程环境**设置 `FLOWORK_KERNEL_GITHUB_TOKEN`，使用有该仓库 Contents 读取权限的 Token。不要把 Token 写入源码、`kernel.config.json`、启动参数、Release 或截图。公开发行时不需要此变量，也不要向终端用户分发你的凭据。

更新器会：

- 仅向配置仓库的 `api.github.com/repos/<owner>/<repo>/...` 请求发送 Token。
- 通过 GitHub Release Asset API（`Accept: application/octet-stream`）获取私有附件。
- 跳转到下载 CDN 后不转发 Token，不把它放到 URL、界面状态或安装记录中。
- 主进程读取该环境变量后将其移除，避免 Pi、数据库等后续子进程继承。

仓库转为公开之后，同一地址即可匿名检查和下载，用户不需要 GitHub 账号。公开 API 的 IP 限流仍适用。

## 每次构建与放行

### 1. 升级并测试

在目标应用对应的源码/适配层上，使用 Node ≥22.19，推荐 Node 24。Windows x64 的包应在 Windows x64 上构建和验证。

```bash
npm install --save-exact @earendil-works/pi-coding-agent@<目标版本>
npm test
npm run smoke
```

另需手动验证真实消息、工具审批、历史恢复、资源/扩展、登录和模型兼容性。自动自检不调用模型，不能代替这些业务测试。

### 2. 生成完整包和签名清单

```bash
npm run kernel:approve -- --version 1.0.1 --key .kernel-keys/signing-private.pem
```

也支持 `FLOWORK_KERNEL_SIGNING_KEY`（PEM 私钥内容），主要供 CI 使用。

命令会在隔离目录中：

1. 根据项目 lockfile 执行 `npm ci --omit=dev --ignore-scripts --no-bin-links`。将支持的 npm 镜像 tarball 地址还原为官方源，版本和 integrity 不变，不解析 `latest`。
2. 生成与应用构建配方一致的独立适配层；或用 `--adapter` 指定目标已发布应用的适配文件。
3. 从官方 npm 验证固定生产依赖的 SHA-512 和大小，以无生命周期脚本、无 `.bin` 的方式重建运行树。
4. 打包 `runtime/package.json` 与 `runtime/node_modules/`，不打入适配代码、密钥或用户配置。
5. 计算整个压缩包的 SHA-256 和大小，写入格式 3 兼容清单，连同平台、架构、应用范围、协议版本、最低运行环境、适配层摘要及固定依赖树一起签名。
6. **复用客户端安全解包代码**重新展开最终压缩包，复制内置适配层，在隔离配置下进行 service/session Worker 自检；通过后才输出附件。

产物：

```text
release/kernels/1.0.1/
  flowork-kernel-win32-x64.tar.gz
  flowork-kernel-win32-x64.json
```

两个附件必须同时发布，文件名不得更改。脚本拒绝覆盖已有批次产物。

可选参数：

```text
--min-app 1.0.8          默认当前 package.json 版本
--max-app 1.0.8          默认等于 min-app，不批准未测试的未来版本
--min-node 22.19.0       默认从 Pi engines 推导
--min-electron 44.7.0    默认当前项目 Electron 版本
--adapter <path>        目标应用内置的 kernel-adapter/pi-worker.js
--out <directory>       默认 release/kernels/<批次号>
--config <json>         本地隔离验证使用替代配置；不能把测试公钥混入正式应用
```

兼容应用版本范围不能绕过适配层摘要和协议约束。包需要安装脚本、未声明的 bundled 依赖或不受支持的归档结构时，不应绕过检查；应调整依赖或先升级应用。

### 3. 发布到 GitHub Releases

- Tag：`kernel-v1.0.1`，与**放行批次**完全一致。
- 附件：完整 `.tar.gz` 和签名 `.json`。
- 正文：Pi 版本、测试范围和更新说明。
- 测试完毕后设为正式 Release；Draft 和 Prerelease 不会提供给更新器。私有仓库中的正式 Release 仍只有获授权账号可访问。

例如（需已登录 GitHub CLI，本机没有安装时可通过 GitHub 网页上传）：

```bash
gh release create kernel-v1.0.1 \
  release/kernels/1.0.1/flowork-kernel-win32-x64.tar.gz \
  release/kernels/1.0.1/flowork-kernel-win32-x64.json \
  --repo Huang-feifei/FloWork --title "FloWork Pi 内核 · 1.0.1" \
  --notes "已测试通过的 Pi 版本及范围……"
```

客户端检查最近 100 个 Release，仅考虑正式稳定 `kernel-vx.y.z`，可以与应用 Release 共用仓库。更改包、依赖或兼容条件后必须使用新批次，不能覆盖同一批次。

### 撤回放行

删除对应 Release、改为 Draft 或移除任一附件。客户端在安装前重新检查 Release 和签名内容，拒绝继续安装已撤回或改变的批次。

这**不是远程停用**：已经安装/暂存的版本仍可离线启动，撤回不会中断会话或删除用户内核。需要回退时通知用户使用「恢复内置内核」，或提供新的已测试批次。

## GitHub Actions（可选）

`.github/workflows/kernel-release.yml` 在维护者推送 `kernel-v*` 标签时执行 Windows x64 回归、构建、自检、签名，并上传 **完整包和清单**。

1. 提交正确公钥及仓库配置，设置仓库 Secret `FLOWORK_KERNEL_SIGNING_KEY`。
2. 本地人工测试通过，再提交固定 Pi/依赖变更并推送放行标签。
3. 限制放行标签和 Secret 的访问，不向不可信 PR 提供私钥。

```bash
git tag kernel-v1.0.1
git push origin kernel-v1.0.1
```

CI 只对当前源码适配层测试，不会自动批准上游任意新版本，也不能替代实际模型/业务验证。

## 客户端安装、生效与回退

安装位置为 `app.getPath("userData")/kernels/`，Windows 通常为 `%APPDATA%/FloWork/kernels/`，以实际 userData 配置为准。

```text
kernels/
  active.json
  1.0.1/
    installed.json     # 签名清单，含完整包摘要与兼容条件
    pi-worker.js       # 从目标应用自身复制的内置适配层
    package.json
    node_modules/
```

- 清单 Ed25519 签名有效，平台、架构、协议、应用范围、最低 Node/Electron、适配层摘要全部匹配才可安装。
- 安装前重新复核是否撤回/变更；仅从配置仓库的 Release 附件下载，不访问 npm、不执行安装脚本。
- 下载最大 512 MiB、5 分钟，校验签名固定的实际长度和 SHA-256，再解压。
- 安全扫描拒绝路径逃逸、链接、特殊文件、重复/大小写别名、未声明依赖及远程适配代码；最多展开 150,000 个条目、2 GiB。扫描失败不进入安装目录。
- 使用当前 Electron 运行隔离自检，不调用模型，不加载用户真实配置、历史或扩展。
- 安装只记录 `pending`。本次运行继续使用原入口，**重启后**再验签、自检并切换；失败回退活动版、上一版或内置版，无需网络。
- 可以恢复内置内核或取消待生效更新；重启前需结束运行中/等待交互的会话。

完整包在下载时验证摘要；启动时验证签名、适配层、依赖元数据和可运行性，不重新哈希所有 SDK 文件。这不是对同一系统用户恶意篡改本地文件的安全沙箱。

更新不删除认证、配置或会话。若 Pi 迁移了用户数据，维护者需要单独测试、备份和制定恢复方案；回退代码不等于回滚数据格式。旧内核目录暂不自动清理。

## 离线回归

```bash
node scripts/test-kernel.mjs
npm test -- kernel
```

使用临时密钥和模拟 GitHub 响应，不写正式配置、不调用模型。覆盖完整包下载、签名/摘要/大小、兼容性、撤回、私有 Asset API 认证及 CDN 不转发凭据、安全解包、旧格式离线启动、重启激活、回退和互斥。
