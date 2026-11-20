# Codex Restart MirrorMix Task Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a standalone Codex desktop task that safely restarts the local MirrorMix instance and reports a verified result.

**Architecture:** The deliverable is a separate Codex task, scoped to the existing `E:\Me\AIMiss` checkout. Its fixed prompt performs a port-specific stop, a build, a hidden background launch and a bounded health check. No AIMiss source, configuration or transcript is changed.

**Tech Stack:** Codex Desktop task, PowerShell 7/Windows PowerShell, Node.js/npm, MirrorMix `npm run build` and `npm run dev` scripts.

## Global Constraints

- Target directory is exactly `E:\Me\AIMiss`.
- Only a process listening on TCP port `4789` may be stopped.
- The task must build before launching and must wait no longer than 20 seconds for `http://127.0.0.1:4789/api/health` to return `{ "ok": true }`.
- The launched service runs hidden and writes both output streams to `E:\Me\AIMiss\logs\mirrormix-restart.log`.
- Do not edit AIMiss source, configuration, or official tool session records.
- Do not add a schedule or automatic retries.

---

## File Structure

- Create: Codex desktop task titled `重启 MirrorMix`; its saved task prompt is the operational artifact.
- Create at run time: `E:\Me\AIMiss\logs\mirrormix-restart.log`; it contains the new service process output.
- Modify: no repository files.

### Task 1: Create the fixed restart task

**Files:**
- Create: Codex desktop task `重启 MirrorMix`
- Test: task's final `GET http://127.0.0.1:4789/api/health` check

**Interfaces:**
- Consumes: `E:\Me\AIMiss\package.json` scripts `build` and `dev`.
- Produces: one standalone local Codex task and, when it succeeds, a MirrorMix listener on `127.0.0.1:4789`.

- [ ] **Step 1: Create the standalone task with this exact instruction**

```text
Restart only the MirrorMix service in E:\Me\AIMiss. Use PowerShell. Verify package.json and npm. Find only the TCP listener on port 4789 and stop that exact PID if present. Run npm run build in E:\Me\AIMiss; if it fails, report failure and do not launch. Create E:\Me\AIMiss\logs. Start npm run dev hidden in that directory, redirecting stdout and stderr to logs\mirrormix-restart.log. Poll http://127.0.0.1:4789/api/health for at most 20 seconds. Report success only if JSON contains ok:true; then give URL, PID and log path. On failure, give the error and last log lines. Do not edit source, config, or transcripts, do not change the bind address, and do not stop any other process.
```

- [ ] **Step 2: Start the task and verify its requested result**

Expected task output includes all of:

```text
http://127.0.0.1:4789
<new service PID>
E:\Me\AIMiss\logs\mirrormix-restart.log
ok: true
```

- [ ] **Step 3: Inspect the endpoint from the parent task**

Run:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:4789/api/health' -TimeoutSec 5
```

Expected output:

```text
ok
--
True
```

- [ ] **Step 4: Name the task and pin it in Codex**

Set its title to `重启 MirrorMix` and pin it, so it remains immediately visible in the Codex desktop sidebar.
