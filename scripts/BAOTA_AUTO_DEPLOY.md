# 宝塔自动部署（前端 GitHub Actions → SSH → 静态目录）

当前 Nginx 站点目录：`/www/wwwroot/luokk.top`。服务器出站 `github.com:443` 不通，因此**不要**靠服务器 `git pull`。Actions 在 GitHub 托管 Runner 里构建，产物通过 SSH 单向上传到宝塔；服务器不需要 GitHub App PEM 或内容仓 PAT。

> **2026-10 变更**：GitHub 已对公开 fork 仓库禁用 Actions（前端仓 `RyuChan` 是 fork，所有触发都返回 `422 Actions has been disabled for this repository`，permissions API 仍显示 enabled，属 GitHub 侧策略）。构建+发布工作流已迁移到内容仓 `RyuChan-Content/.github/workflows/deploy-baota.yml`，由**内容仓 push 直接触发**（构建时再拉取本仓库源码）。本仓库的 `.github/workflows/deploy-baota.yml` 保留作历史备份，不会再运行。

## 文件与上线门槛

1. 将 `src/lib/github-client.ts` 的路径编码修复连同 `.github/workflows/deploy-baota.yml` 提交到**前端 GitHub 仓库的 main**。若手头是无 `.git` 的 ZIP 解压目录，需要先在真正的 Git 仓库提交；不要部署旧前端源码。
2. 前端工作流每 15 分钟检查一次私有内容仓 main 的提交 SHA（GitHub 定时任务可能延迟）；**仅 SHA 变化时才构建并发布**。若内容仓已有 `trigger-deploy.yml`，只需保留现有文件，不要安装第二个相同触发器。内容仓的 `DISPATCH_TOKEN` 是可选的即时通知通道，缺失时不影响定时自动更新。
3. 在前端仓库添加配置（Settings → Secrets and variables → Actions）：
   - **Variables**：`BAOTA_HOST`（公网 IP/域名）、`BAOTA_PORT`（SSH 端口）、`PUBLIC_GITHUB_APP_ID` 和 `PUBLIC_GITHUB_ENCRYPT_KEY`（必须与当前线上前端构建值完全相同；这两个 `PUBLIC_` 字段会进入前端构建产物，不能用 App 私钥）；
   - **Secrets**：`CONTENT_TOKEN`（仅可读取私有内容仓的 fine-grained token）、`BAOTA_DEPLOY_KEY`（下文生成的专用 SSH **私钥**）、`BAOTA_KNOWN_HOSTS`（核对指纹后的 SSH 主机公钥行）。
   - 前端代码现定内容仓为与前端仓库**同一 owner** 的 `RyuChan-Content`，分支 `main`。若实际不符，先改工作流的 `repository`、`PUBLIC_GITHUB_OWNER`、`PUBLIC_GITHUB_REPO` 并复核。
4. **可选**：若希望内容仓 push 后立即触发，而不是等待定时任务，在内容仓设置 `DISPATCH_TOKEN` secret：仅对前端仓库授予 Contents: write 的 fine-grained token。现有 `trigger-deploy.yml` 会发送 `content-update`。不要用已有的宽权限个人令牌或 App 私钥替代。

## 在电脑生成专用部署密钥

在电脑 PowerShell（不是宝塔服务器）生成独立 ED25519 密钥：

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\ryuchan-deploy"
```

在两次密码提示中直接按回车（CI 不能交互输入密码；私钥只放 GitHub Secret）。密钥的 `.pub` 是公钥；**不向聊天或宝塔网站目录发送私钥**。GitHub `BAOTA_DEPLOY_KEY` Secret 中放私钥全文，在电脑端设置即可。

## 安装服务器发布器（只需一次）

通过宝塔「文件」把**公钥**上传为 `/root/ryuchan-deploy.pub`，把当前目录的 `scripts/baota-publish.py`、`scripts/setup-baota-deploy.sh` 分别上传到 `/root/baota-publish.py`、`/root/setup-baota-deploy.sh`。在服务器 SSH 单行执行：

```bash
bash /root/setup-baota-deploy.sh
```

脚本创建普通非 root SSH 用户 `ryuchan-deploy`，其专用上传目录为 `/home/ryuchan-deploy/incoming`；这个用户并非受限 shell，但 `sudo` 只允许调用 root 所有的 `/usr/local/sbin/ryuchan-publish`。发布器校验 SHA-256、限制压缩包路径/大小，备份站点到 `/root/ryuchan-deploy-backups`，跳过宝塔受保护的 `.user.ini`，原子替换新文件且保留旧文件，不使用 `rsync`。自动备份不自动删除，需根据磁盘空间手工清理旧备份。

**确认 GitHub Runner 能连接 SSH 端口**；仅能在宝塔网页终端访问 SSH 并不证明公网入站可达。若没开放 SSH 入站，Actions 会因连接超时而失败，先检查端口/防火墙而不是关闭 SSH 主机密钥校验。

## 钉住 SSH 主机指纹

在你的电脑用已信任的服务器会话读取 `/etc/ssh/ssh_host_ed25519_key.pub` 的指纹（只读，**不是私钥**）：

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

电脑 PowerShell `ssh-keyscan -p SSH端口 服务器IP` 获取完整主机公钥行，再以 `ssh-keygen -lf` 对照服务器上面的指纹；**核对后**把完整的主机公钥行写入 `BAOTA_KNOWN_HOSTS`。非标准端口时 known_hosts 主机字段需为 `[服务器IP]:端口`。不在 CI 运行未经核对的动态 `ssh-keyscan`，不设置 `StrictHostKeyChecking=no`。

## 验证与恢复

先在前端仓库 Actions 手动运行一次 `Deploy RyuChan to Baota`，必须同时通过 build、上传、发布步骤；确认浏览器刷新 `/config/` 后展示新值。之后在内容仓改一个已知的非敏感字段并验证下一次定时任务会部署新 SHA；如配置了 `DISPATCH_TOKEN`，验证 `content-update` 派发会提前触发。工作流使用 `concurrency` 串行排队。

发布器输出完整站点备份 tar.gz 路径；构建失败不接触线上站点，发布途中失败时保留备份供人工恢复。不要单凭保存成功 Toast 或 `pnpm build` 结果推断线上已更新。

## 增量发布与在线编辑触发

- 构建产物会附带 `.ryuchan-manifest`（全站文件 SHA-256 清单）。工作流先读取线上清单，只把有变化的文件打包上传；服务器端按清单覆盖变化文件、删除清单外的旧文件（保留 `.user.ini`、`.htaccess`、`.well-known/` 等面板/证书文件）。单个文章的改动通常只上传几百 KB，发布约 2~3 分钟；删除文章后旧链接也会返回 404。
- 服务器把发布器换成支持清单的新版本（root 执行一次即可）：
  ```bash
  curl -fsSL -o /tmp/ryuchan-publish.new https://raw.githubusercontent.com/ymy2078069948/RyuChan/main/scripts/baota-publish.py
  install -o root -g root -m 0755 /tmp/ryuchan-publish.new /usr/local/sbin/ryuchan-publish
  rm -f /tmp/ryuchan-publish.new
  ```
  未升级时工作流检测不到新发布器，会自动回退为整包发布（旧行为），不会中断部署。若服务器拉不到 GitHub 文件，用宝塔文件管理把仓库里的 `scripts/baota-publish.py` 上传到 `/root/baota-publish.py`，再执行 `install -o root -g root -m 0755 /root/baota-publish.py /usr/local/sbin/ryuchan-publish`。
- 在线编辑（`/write`、`/config` 等）保存并成功提交内容仓后，浏览器用已有的 GitHub App 安装令牌向前端仓库发送 `repository_dispatch`（`content-update`），立即触发部署，不再依赖定时任务。前提：同一个 GitHub App 也安装到了前端仓库（需要 Contents 写权限），且 `PUBLIC_FRONTEND_REPO` 指向前端仓库名。
- 前端工作流的 15 分钟定时检查保留为兜底；fork 仓库的 GitHub 定时任务默认不启用，不能当作唯一触发方式。

