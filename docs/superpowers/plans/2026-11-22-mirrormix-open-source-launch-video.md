# MirrorMix Open-Source Launch Video Implementation Plan

> **For agentic workers:** Execute this plan inline, task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a ~5-minute Chinese narrated MirrorMix launch video package and platform-specific publication copy.

**Architecture:** Keep product claims grounded in the repository documentation and real product screens. Create separate, reusable deliverables for the narration/storyboard, SRT captions, publication copy, visual assets, and rendered video so the social posts can be reviewed or revised independently.

**Tech Stack:** Markdown, SRT, AI-generated raster hero art, product screenshots, FFmpeg when available.

## Global Constraints

- MirrorMix connects existing local AI-tool sessions; it does not call model APIs.
- Remote-access scenes must not show secrets, passwords, tokens, or a public origin, and must mention HTTPS and access controls.
- Use the existing product palette: grey-blue, white, and teal signal accents.
- Use Gitee as the CTA: `https://gitee.com/tnndworlds/mirror-mix`.
- Primary production length is 4:45–5:15, with 16:9 master and a 9:16-safe composition.
- Preserve all existing product code and unrelated worktree changes.

---

### Task 1: Create the editorial master

**Files:**
- Create: `release/mirrormix-launch-2026-11-22/video-script-and-storyboard.md`
- Create: `release/mirrormix-launch-2026-11-22/mirrormix-launch.srt`

**Produces:** Timed Chinese voice-over, shot list, screen-recording checklist, and subtitle source of truth.

- [ ] Write the narration in six chapters: fragmentation, positioning, PC workflow, execution, mobile continuity, and open-source CTA.
- [ ] Assign every chapter a time range totaling 4:45–5:15 and pair it with a real-product or generated visual.
- [ ] Write SRT blocks from the narration with concise, mobile-readable lines.
- [ ] Check every feature statement against `README.md` and remove unsupported claims.

### Task 2: Create visual assets and capture guidance

**Files:**
- Create: `release/mirrormix-launch-2026-11-22/assets/hero.png`
- Create: `release/mirrormix-launch-2026-11-22/assets/cover-16x9.png`
- Create: `release/mirrormix-launch-2026-11-22/assets/README.md`

**Consumes:** The sequence and on-screen labels from Task 1.

**Produces:** A visual identity asset, video cover, and a repeatable checklist for PC/mobile capture.

- [ ] Generate one non-photorealistic technical hero visual with no embedded text or logos, using grey-blue, white, and teal lighting.
- [ ] Create a 16:9 cover with the title “把分散的 AI 会话，收进一个工作台” and `MirrorMix` attribution.
- [ ] List exact app states needed for real screens and the redactions required before capturing.

### Task 3: Render the review video

**Files:**
- Create: `release/mirrormix-launch-2026-11-22/mirrormix-open-source-launch.mp4`
- Create: `release/mirrormix-launch-2026-11-22/render-video.ps1`

**Consumes:** Hero/cover assets, SRT, and any safely captured product screenshots.

**Produces:** An MP4 review cut. If local text-to-speech is unavailable, the review cut includes timed visual cards and the complete SRT for adding a human or external TTS voice without revising the edit.

- [ ] Check whether FFmpeg and a local TTS engine are available without installing software.
- [ ] Build a video sequence from the approved art, cover, and supplied/captured safe product visuals.
- [ ] Burn concise Chinese captions into the review MP4 or attach the SRT when fonts/rendering cannot be verified.
- [ ] Inspect MP4 duration and dimensions with FFmpeg and retain the command in `render-video.ps1`.

### Task 4: Write platform publication copy

**Files:**
- Create: `release/mirrormix-launch-2026-11-22/publishing-copy.md`

**Consumes:** The claims and CTA from Task 1.

**Produces:** Ready-to-post copy for Douyin, WeChat Channels, Toutiao, WeChat Official Account, and Xiaohongshu.

- [ ] Write short video titles, descriptions, hashtags, pinned-comment CTA, and cover options for Douyin and WeChat Channels.
- [ ] Write a title, lead, body, image placement guide, and CTA for Toutiao and WeChat Official Account.
- [ ] Write Xiaohongshu title options, a first-person discovery-style body, image carousel order, hashtags, and interaction prompt.
- [ ] State the local-first/security caveat in long-form copy without reducing the promotional message to a disclaimer.

### Task 5: Validate and hand off

**Files:**
- Review: `release/mirrormix-launch-2026-11-22/*`

**Produces:** A self-contained handoff directory.

- [ ] Check narration timing, SRT sequence numbering, platform character length, public CTA, and that no secret appears in generated assets.
- [ ] Verify generated images by opening them locally and MP4 metadata with FFmpeg.
- [ ] List the files, rendered-video status, and only the manual publishing actions remaining.
