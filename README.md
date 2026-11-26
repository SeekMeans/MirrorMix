![MirrorMix: the same AI workspace on your PC and phone](docs/readme-banner.svg)

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/Platform-Windows-2563eb" alt="Windows" />
  <br />
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

[Overview](#overview) · [Core features](#core-features) · [Plugins](#plugins) · [Install and access](#install-and-access)

## Overview

**MirrorMix is an AI workspace you can use from your PC or phone.** It runs on your Windows PC. Use the browser on your PC to keep track of work across AI tools, then pick up where you left off on your phone.

- **Multiple AI tools, one status dashboard.** Bring your existing Claude Code, Codex, and Cursor sessions together. See what's still running and which chats have new replies, then open any of them without switching desktop apps.
- **Switch devices, not conversations.** Start a task on your PC, then check progress, send a follow-up, or review generated files and pages from your phone. Your PC still does the work; there's no second set of AI tools to install on your phone.

You don't have to write code. Ask AI to draft an event plan or weekly update on your PC. Review the draft and request a change on your phone, then finish it when you're back at your desk.

## Core features

| Feature | On your PC | On your phone |
| --- | --- | --- |
| **Status dashboard** | See which chats across tools are still running or have unread replies. | Check new replies and see a summary of today's conversations and messages. |
| **Continue a conversation** | Find an existing session by tool or project and send your next message. | Read and reply in the same session without explaining the context again. |
| **Review AI output** | Preview drafts, images, PDFs, or web pages you've created with AI. | Review a proposal or page on the go and send feedback in the original chat. |
| **File explorer** | Open the session's folder to browse, preview, or download files. | Open the same folder and tap a file for a full-screen preview without sending it to yourself first. |

<p align="center">
  <a href="docs/mobile-dashboard.png"><img src="docs/mobile-dashboard.png" width="130" alt="Mobile workspace showing today's activity by tool" /></a>
  <a href="docs/mobile-session.png"><img src="docs/mobile-session.png" width="110" alt="Continuing an existing Codex session on a phone" /></a>
</p>
<p align="center"><sub>Left: mobile workspace · Right: an existing chat (select either image to enlarge)</sub></p>

## Plugins

Add tools from the Plugins page as you need them. You don't need them to write or research; add them when you want to run commands or manage servers.

- **Project terminal and shortcuts.** Open a project terminal next to your chat. Save shortcuts for common commands or use the Command tasks plugin to run them again.
- **Remote server management.** Use the SSH plugin to connect to a configured server, check logs, run commands, or transfer files with SFTP.
- **One-click maintenance and deployments.** In the SSH plugin, save a script and its target server as a task, such as updating a test environment or restarting a service. Run it from your PC or phone and see the status and output.

**Build with us:** You can write plugins and help maintain the ecosystem. Suggest ideas in [Issues](https://github.com/SeekMeans/MirrorMix/issues) or send a pull request. Plugins currently ship with MirrorMix; installing third-party plugins separately is not supported yet.

## Install and access

### 1. Install on Windows

1. Once you have the Windows installer, double-click the Setup file and follow the prompts.
2. Open MirrorMix from the Start menu and click **Start** in its tray panel. Your browser opens the workspace at <http://127.0.0.1:4789> by default.
3. Install and sign in to the AI tools you want to use on your PC, then open an existing session in MirrorMix.

You don't need to clone the repository or run build commands. The installer currently requires **Node.js 22 or later** on your PC and does not bundle it. Check [GitHub Releases](https://github.com/SeekMeans/MirrorMix/releases) for public downloads.

### 2. Open your workspace from your phone

- **No cloud server:** Request an access address in the MirrorMix mini program or under **Settings → Remote access** on your PC. After approval and binding, set an access password and turn on remote access. When you see **Connected**, copy the HTTPS address to your phone browser and sign in with that password.
- **Use your own cloud server:** Set up your own tunnel instead of applying for an address. Forward an HTTPS endpoint to the PC running MirrorMix, put it behind access controls, and don't expose the local port directly to the internet.

Your phone connects to the same PC. Before leaving, keep the PC on, online, and running MirrorMix.

### 3. Open a generated page in your browser

If AI generated an HTML page, or if your project is already running on your PC, select the **globe icon** beside the chat. Choose a page file or a local service to open it in a new tab. With MirrorMix's built-in remote access, you can open the preview from your phone too. Preview links are temporary, not permanent public URLs.

### 4. Use full screen

- **PC:** Open the workspace or a generated page and press `F11` to enter or exit full screen in a browser that supports it.
- **Phone:** Tap a file in the file explorer to preview it full screen. For quick access to the workspace, use your browser's **Add to Home Screen** option if available.

<details>
<summary>Run from source (for developers)</summary>

On Windows with Git and Node.js 22+, open PowerShell and run:

~~~powershell
git clone https://github.com/SeekMeans/MirrorMix.git
cd MirrorMix
npm install
npm start
~~~

Open <http://127.0.0.1:4789>. For a development server with hot reload, use `npm run dev`. See the in-app **Help** for more.

</details>

[MIT license](LICENSE) © tnndworlds
