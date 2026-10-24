#!/usr/bin/env bash
# Run as root, after uploading an SSH *public* key and scripts/baota-publish.py to /root.
set -euo pipefail

PUB=/root/ryuchan-deploy.pub
PUBLISHER=/root/baota-publish.py
DEPLOY_USER=ryuchan-deploy
HOME_DIR=/home/ryuchan-deploy

[[ "$(id -u)" == 0 ]] || { echo 'Run as root' >&2; exit 1; }
[[ -f "$PUB" && -f "$PUBLISHER" ]] || { echo 'Upload public key and publisher to /root first' >&2; exit 1; }
[[ -f /www/wwwroot/luokk.top/index.html ]] || { echo 'Unexpected Nginx site root' >&2; exit 1; }
command -v visudo >/dev/null || { echo 'sudo/visudo is required' >&2; exit 1; }
IFS= read -r KEY < "$PUB"
[[ "$KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || { echo 'Expected one ed25519 public key' >&2; exit 1; }

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --home-dir "$HOME_DIR" --shell /bin/bash "$DEPLOY_USER"
fi
[[ "$(getent passwd "$DEPLOY_USER" | cut -d: -f6)" == "$HOME_DIR" ]] || { echo 'Unexpected deploy user home' >&2; exit 1; }
install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$HOME_DIR/.ssh" "$HOME_DIR/incoming"
AUTH="$HOME_DIR/.ssh/authorized_keys"
touch "$AUTH"
chmod 0600 "$AUTH"
chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH"
if ! grep -Fxq "$KEY" "$AUTH"; then printf '%s\n' "$KEY" >> "$AUTH"; fi
install -m 0755 -o root -g root "$PUBLISHER" /usr/local/sbin/ryuchan-publish
SUDOERS=/etc/sudoers.d/ryuchan-deploy
TEMP=$(mktemp /etc/sudoers.d/ryuchan-deploy.XXXXXX)
trap 'rm -f "$TEMP"' EXIT
printf 'ryuchan-deploy ALL=(root) NOPASSWD: /usr/local/sbin/ryuchan-publish\n' > "$TEMP"
chmod 0440 "$TEMP"
visudo -cf "$TEMP" >/dev/null
mv -f "$TEMP" "$SUDOERS"
echo 'Deploy user ready. GitHub Actions needs BAOTA_HOST, BAOTA_PORT, BAOTA_KNOWN_HOSTS, BAOTA_DEPLOY_KEY.'
