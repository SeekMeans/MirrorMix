# MirrorMix

[中文说明](README.zh-CN.md)

A local desk for sessions already on your machine. Open Claude Code, Codex, and Cursor chats in the browser and keep typing there. MirrorMix does **not** call model APIs; it reads and writes each tool’s own local records and talks to the desktop apps when needed.

Default URL: <http://127.0.0.1:4789>

Requires **Node.js 22+** (uses `node:sqlite`).

## Features

- Browse and continue Claude Code, Codex, and Cursor sessions on this PC
- Send from the web UI into the desktop window when possible; fall back to CLI / queue paths when the screen is locked or the window cannot take input
- Shared project terminals per workspace folder, global shortcut commands, plugins (command tasks, schedules, SSH)
- Optional remote access via your own tunnel or reverse proxy (still bound to localhost on the app side)

## Quick start

```powershell
npm install
npm start
```

`npm start` builds the client, then starts the server. When you see `MirrorMix listening on http://127.0.0.1:4789`, open that address in a browser.

Development (server hot-reload):

```powershell
npm run dev
```

After client UI changes, run `npm run build` from the project root (Vite `outDir` is `dist/`, which the server serves), or use `npm start` again.

Change the port:

```powershell
$env:AIMISS_PORT = "4790"
npm run dev
```

Stop with Ctrl+C in the terminal that started it. If that terminal is gone:

```powershell
$conn = Get-NetTCPConnection -LocalPort 4789 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) { Stop-Process -Id $conn.OwningProcess }
```

## Connection mode

Unset defaults to `legacy` (original Codex CLI resume/create and Claude inbox / desktop follow / CLI takeover paths). Cursor behavior is unchanged either way.

For Codex and Claude to send through the desktop apps instead, set before start:

```powershell
$env:AIMISS_CONNECTION_MODE = "desktop"
```

Or write `%USERPROFILE%\.mirrormix\connection-mode.json`:

```json
{ "mode": "desktop" }
```

Environment variables win over the file. That file lives outside the repo.

In `desktop` mode the web UI drives the desktop session input via Windows UI Automation and syncs replies from local history. The matching desktop app must be open and signed in. Sessions are matched by full title; open the chat in the desktop app first if it is missing from the sidebar.

## Security

MirrorMix listens on **`127.0.0.1` only**. Do not bind it to `0.0.0.0`. It can send into Claude/Codex/Cursor and open shells in your project folders—exposing it on the public internet is equivalent to handing over the machine.

To use it from a phone or another PC, put a reverse proxy or tunnel in front of `127.0.0.1:4789`, and:

- Serve the outside with **HTTPS** (login uses the Windows account)
- Prefer an extra gate (Tailscale, proxy auth, Cloudflare Access, etc.)
- Keep MirrorMix login enabled; use a strong Windows password

### Tailscale (simple)

```powershell
tailscale serve --bg 4789
```

Open `https://<machine>.<tailnet>.ts.net` from your phone on the same Tailscale account.

### Self-hosted tunnel

Point frp/Caddy/nginx (or similar) at `127.0.0.1:4789`, terminate TLS on the server, and do not expose the raw tunnel port to the internet. If your public origin differs from what the browser uses, set:

```powershell
$env:MIRRORMIX_ALLOWED_ORIGINS = "https://mm.example.com"
npm start
```

## Config tips

| Item | Where |
|---|---|
| Port | `AIMISS_PORT` (default `4789`) |
| Connection mode | `AIMISS_CONNECTION_MODE` or `~\.mirrormix\connection-mode.json` |
| Global shortcuts | `~\.mirrormix\commands.json` (or `AIMISS_COMMANDS`) |
| Remote / tunnel settings | `~\.mirrormix\` and optional `mirrormix.config.json` / `MIRRORMIX_CONFIG` |

Pinned chats, quotas, and most “how do I …” details are in the in-app Help page.

## License

[MIT](LICENSE) © tnndworlds
