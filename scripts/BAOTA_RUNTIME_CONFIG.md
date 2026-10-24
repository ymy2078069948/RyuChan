# 宝塔实时配置叠加层（可选，需要服务器管理员安装一次）

现有 Astro 静态站保持不变：文章、搜索、SEO 的原始 HTML 等仍由 GitHub Actions 构建。此功能只让**访客刷新页面**后即时看到头像、名称、简介、站点标识/标题、二维码等；不把整站改为动态 SSR，也不声称所有构建时配置实时生效。

## 工作原理

`/config/` 原有 GitHub App 凭证仍用于写入私有内容仓；只有成功更新内容仓分支后，编辑器才使用**独立的运行时发布密钥**调用同源 `/__runtime/publish`。独立服务只监听 `127.0.0.1:8765`，只接收白名单字段、哈希匹配的图片和特定 MIME 格式；访客只读 `/__runtime/config` 和 `/__runtime/media/*`。JS 增强已有静态 HTML，服务停止时网页回退为静态内容。密钥只存用户当前浏览器的 sessionStorage，绝不写在前端构建产物、GitHub Secrets 或本仓库内。

GitHub 保存成功但实时发布失败时，后台**明确提示部分成功**；原有宝塔构建部署仍保底。当宝塔下一次发布更新 `.ryuchan-content-sha` 时，服务停止返回旧叠加层，防止它无限期盖住内容仓的最新值。重新发布（服务重启）不会丢失当前叠加层或图片。

## 一次性安装（宝塔服务器，root）

以下操作需要宝塔服务器 root 权限，当前 Codex 工作区没有这份服务器权限，**前端推送成功不等于实时服务已安装**。先从已审阅的前端仓库复制 `scripts/runtime_config_service.py` 到服务器 `/opt/ryuchan-runtime/runtime_config_service.py`，例如经你已验证的 SSH 上传；不要复制内容仓或私钥。随后服务器执行：

```bash
set -euo pipefail
id ryuchan-runtime >/dev/null 2>&1 || useradd --system --home-dir /var/lib/ryuchan-runtime --shell /usr/sbin/nologin ryuchan-runtime
install -d -m 0755 -o root -g root /opt/ryuchan-runtime
install -d -m 0750 -o ryuchan-runtime -g ryuchan-runtime /var/lib/ryuchan-runtime
chown root:root /opt/ryuchan-runtime/runtime_config_service.py
chmod 0644 /opt/ryuchan-runtime/runtime_config_service.py
python3 -m venv /opt/ryuchan-runtime/venv
/opt/ryuchan-runtime/venv/bin/python -m pip install 'gunicorn>=22,<24'
python3 - <<'PY'
from pathlib import Path
import secrets
path = Path('/etc/ryuchan-runtime.env')
if path.exists():
    raise SystemExit('Existing token file: preserve it; do not rotate without updating the browser key')
path.write_text('RYUCHAN_RUNTIME_TOKEN=' + secrets.token_urlsafe(48) + '\nRYUCHAN_RUNTIME_ORIGIN=https://luokk.top\n')
path.chmod(0o600)
print('Created /etc/ryuchan-runtime.env; do NOT paste its contents into chat.')
PY
```

创建 `/etc/systemd/system/ryuchan-runtime.service`（如使用宝塔管理 Python 服务，也必须保持同样的 loopback 监听和密钥设置）：

```ini
[Unit]
Description=RyuChan limited same-origin runtime config
After=network.target

[Service]
Type=simple
User=ryuchan-runtime
Group=ryuchan-runtime
WorkingDirectory=/opt/ryuchan-runtime
EnvironmentFile=/etc/ryuchan-runtime.env
ExecStart=/opt/ryuchan-runtime/venv/bin/gunicorn --workers 1 --threads 2 --bind 127.0.0.1:8765 --access-logfile - runtime_config_service:application
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/ryuchan-runtime

[Install]
WantedBy=multi-user.target
```

把以下配置**加入实际启用的 luokk.top HTTPS Nginx server 块内部**，不要新建第二个同名虚拟主机（编辑前备份站点 Nginx 配置）：

```nginx
location ^~ /__runtime/ {
    client_max_body_size 12m;
    proxy_pass http://127.0.0.1:8765;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 20s;
    add_header Cache-Control "no-store" always;
}
```

使用宝塔配置检测按钮或 `nginx -t`，通过后 reload Nginx。最后：

```bash
systemctl daemon-reload
systemctl enable --now ryuchan-runtime.service
systemctl status --no-pager ryuchan-runtime.service
curl -fsS https://luokk.top/__runtime/config
```

公开 GET 应为 `{"version":1,"config":null}`，这是正常的（尚未保存实时值）。不要把 token 发到聊天或公开 issue；管理员自己在服务器读取 `RYUCHAN_RUNTIME_TOKEN`，登录配置页保存时在浏览器的密钥对话框输入一次。注意：**GitHub App 私钥不是运行时发布密钥**。

## 验证边界

- 修改“个人描述”并保存；GitHub 提交成功后，在另一个**未登录**浏览器窗口刷新首页，应在数秒内看到新描述。用 `curl -fsS https://luokk.top/__runtime/config` 验证白名单值。
- 图片单张不超过 5 MiB，同一次保存的总 JSON 不超过 12 MiB。编辑器会将图片同时写入内容仓和隔离的运行时媒体目录；无需等待静态发布就能在另一台浏览器看到。
- `POST /__runtime/publish` 无密钥返回 403；接口仅接受站点的 `Origin`。公共 GET 不包含任何私钥/令牌。Nginx 访问日志和浏览器开发者工具中的请求头包含敏感值，不要贴完整日志。
- 文章内容、导航/菜单、页面布局、主题 CSS、搜索索引，以及**爬虫初次读取的 HTML / OG 元数据**仍依赖宝塔重新构建。实时 JS 更改的只是访客浏览器 DOM，不是服务器 HTML。
- 内容仓中其他编辑者的修改会在下次宝塔部署后取代旧实时叠加层；保存失败不会声称实时成功。卸载此服务不会损坏静态站或内容仓。
