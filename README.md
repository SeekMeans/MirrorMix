![MirrorMix — local workspace for Claude Code, Codex, and Cursor sessions](docs/readme-banner.svg)

<p align="center">
  <strong>Pick up your existing AI chats in the browser.</strong><br />
  One local workspace for Claude Code, Codex, and Cursor.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/Platform-Windows-2563eb" alt="Windows" />
  <img src="https://img.shields.io/badge/Node.js-22%2B-287a4b" alt="Node.js 22 or later" />
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#connection-mode">Connection mode</a> ·
  <a href="#security">Security</a>
</p>

## Overview

Open a conversation already on your PC and send your next message without starting a new chat. MirrorMix works with the tools and session records already on your machine. **It does not call model APIs directly.**

## Quick start

On Windows with **Node.js 22+**, run in PowerShell:

```powershell
git clone https://github.com/tnndworlds/MirrorMix.git
cd MirrorMix
npm install
npm start
```

`npm start` builds the client and starts the server. Open <http://127.0.0.1:4789> in your browser, then select an existing session.

## Features

- Browse and continue Claude Code, Codex, and Cursor sessions on this PC.
- Read Codex JSONL transcripts and paginated SQLite history, and display project names from the Codex desktop sidebar.
- Send through the desktop window when available, with CLI or queue fallback paths depending on the tool and connection mode.
- Open shared project terminals, run shortcuts, and use plugins for commands, schedules, and SSH.
- Start, stop, or restart named services from the project terminal.
- Optionally reach MirrorMix through your own tunnel or reverse proxy while keeping the app bound to localhost.

## Development

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
