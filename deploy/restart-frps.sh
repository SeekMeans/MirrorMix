#!/usr/bin/env bash
# 重启云服务器上的 frps：先检查配置，再重启，最后确认端口和日志。
# 用法：sudo bash restart-frps.sh
# 程序和配置文件的位置从 frps.service 的 ExecStart 里读，不用另外填。
# 要指定时：FRPS_BIN=/path/frps FRPS_CONFIG=/path/frps.toml sudo -E bash restart-frps.sh
set -euo pipefail

SERVICE="${FRPS_SERVICE:-frps}"

fail() { echo "✗ $*" >&2; exit 1; }
ok() { echo "✓ $*"; }

[ "$(id -u)" -eq 0 ] || fail "需要 root 权限，请用 sudo 运行。"
systemctl cat "$SERVICE" >/dev/null 2>&1 || fail "没有名为 $SERVICE 的 systemd 服务，先把 frps.service 放到 /etc/systemd/system/。"

# ExecStart=/opt/.../frps -c /opt/.../frps.toml
exec_line="$(systemctl cat "$SERVICE" | grep -E '^\s*ExecStart=' | tail -n1 | sed -E 's/^\s*ExecStart=[-@+!:]*//')"
read -r -a exec_args <<<"$exec_line"
unit_bin="${exec_args[0]:-}"
unit_config=""
for i in "${!exec_args[@]}"; do
  case "${exec_args[$i]}" in
    -c|--config) unit_config="${exec_args[$((i + 1))]:-}" ;;
    -c=*|--config=*) unit_config="${exec_args[$i]#*=}" ;;
  esac
done

BIN="${FRPS_BIN:-${unit_bin:-/usr/local/bin/frps}}"
CONFIG="${FRPS_CONFIG:-${unit_config:-/etc/frp/frps.toml}}"
[ -x "$BIN" ] || fail "找不到 frps 程序：$BIN"
[ -f "$CONFIG" ] || fail "找不到配置文件：$CONFIG"
ok "程序：$BIN"
ok "配置：$CONFIG"

# 配置写错时不重启，免得把正在用的隧道断掉。
if "$BIN" verify -c "$CONFIG" >/tmp/frps-verify.log 2>&1; then
  ok "配置检查通过"
else
  cat /tmp/frps-verify.log >&2
  fail "配置有错，没有重启。改好 $CONFIG 后再运行。"
fi

if [ "$(stat -c %a "$CONFIG")" != "600" ]; then
  chmod 600 "$CONFIG"
  ok "配置文件里有连接口令，已把权限改成 600"
fi

since="$(date '+%Y-%m-%d %H:%M:%S')"
systemctl daemon-reload
systemctl restart "$SERVICE"

# 等它起来，最多 10 秒。
for _ in $(seq 1 10); do
  systemctl is-active --quiet "$SERVICE" && break
  sleep 1
done
systemctl is-active --quiet "$SERVICE" || {
  journalctl -u "$SERVICE" --since "$since" --no-pager | tail -n 20 >&2
  fail "$SERVICE 没有起来，上面是它的日志。"
}
ok "$SERVICE 已重启"

# 端口：bindPort 要对外，vhostHTTPPort 只应监听 127.0.0.1。
sleep 1
bind_port="$(grep -E '^\s*bindPort\s*=' "$CONFIG" | head -n1 | grep -oE '[0-9]+' || echo 7000)"
vhost_port="$(grep -E '^\s*vhostHTTPPort\s*=' "$CONFIG" | head -n1 | grep -oE '[0-9]+' || echo 8080)"
listening="$(ss -lntp 2>/dev/null | grep frps || true)"

echo "$listening" | grep -qE "[:.]${bind_port}\s" && ok "电脑连入端口 $bind_port 在监听" \
  || echo "! 没看到 $bind_port 在监听，检查 frps.toml 里的 bindPort"
if echo "$listening" | grep -qE "127\.0\.0\.1:${vhost_port}\s"; then
  ok "转发端口 $vhost_port 只监听本机"
elif echo "$listening" | grep -qE "[:.]${vhost_port}\s"; then
  echo "! 转发端口 $vhost_port 对外监听了。在 frps.toml 里加上 proxyBindAddr = \"127.0.0.1\""
else
  echo "! 没看到 $vhost_port 在监听，检查 frps.toml 里的 vhostHTTPPort"
fi

echo
echo "最近的日志："
journalctl -u "$SERVICE" --since "$since" --no-pager | tail -n 15
echo
echo "各台电脑的 frpc 会自动重连，几秒后日志里会出现 new proxy [mirrormix-...] success。"
echo "持续看日志：journalctl -u $SERVICE -f"
