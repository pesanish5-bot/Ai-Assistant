# ULTRON handoff for Cursor

Read this before continuing development. It describes the **current local checkout**, not just the published GitHub branch. Do not clone over it, reset it, discard uncommitted files, or assume the README proves a feature works. Reinspect the code and run tests before making a claim.

## Open this exact checkout

`C:\Users\pesan\Documents\Codex\2026-08-10\https-github-com-sagar-tamang-ultron\work\ultron-by-sagar-builds`

Git remote: `https://github.com/pesanish5-bot/Ai-Assistant.git`. Branch: `main`.

Never copy `.env.local`, `.ultron/`, cached voice models, credentials, raw audio, or speaker profiles into a public commit or a handoff prompt. **User action required:** rotate the Gemini API key in Google AI Studio (it appeared in past chat sessions) and confirm the previously exposed OpenAI key is revoked. Update `.env.local` locally only. Do not print key values. This handoff contains no credentials.

## Progress (2026-11-08 Full Upgrade Prompt) — Phases 0–8 complete (code)

### Phase 0 — Protect existing work — DONE
Secrets scan clean; unpublished work committed in six chunks; CI workflow; pushed.

### Phase 1 — Voice latency streaming — DONE (code; live mic eval still needs user)
Gemini SSE streaming → NDJSON `/api/ultron` → sentence-chunked Kokoro. Capture capped at 12s. Mic-loss HUD event.
**Unverified on hardware:** audible first-audio speedup, 30–50 phrase WER. Run `python -m voice.evaluate_stt --live` privately when ready.

### Phase 2 — Activation route gap — DONE
`POST /api/activation` requires Bearer event token **or** same-origin HUD; publishes `activation.changed`.

### Phase 3 — Internet access — DONE (needs Brave API key from user)
`web.search` / `web.fetch` with SSRF protections. Add `BRAVE_SEARCH_API_KEY` to `.env.local` for live facts.

### Phase 4 — Trusted confirmation channel — DONE (code; native dialog + live voice stamp need user)
Writes need launcher Bearer stamp or native MessageBox; voice yes only for reversible + speaker verified; `.ultron/state/actions.log`.

### Phase 5 — Computer use (PC action tools) — DONE (code; hardware needs user)
- Allowlisted `computer.app.open`, `computer.window.focus` (edit `.ultron/config/computer-allowlist.json`; example in `config/computer-allowlist.example.json`).
- `computer.media.play` — YouTube/Spotify search URL templates only.
- `computer.media.analyze` — YouTube title/description/caption metadata only (does not watch frames).
- `computer.text.type` — types after trusted confirm; never presses Send.
- Brain honesty + `needs*` gates + runTool re-checks. No unrestricted shell.

### Phase 6 — Tailscale mobile remote — DONE (code; Tailscale install needs user)
- `scripts/start-ultron.ps1 -Tailscale` binds Next to Tailscale IPv4 only (never `0.0.0.0`).
- Hashed device tokens (`.ultron/state/device-tokens.json`); minted once at Tailscale start.
- `authorizeRuntimeRequest` + separate remote rate limits; mobile layout + device-token unlock gate.
- Docs: `docs/TAILSCALE_REMOTE.md`. Device token can stamp **reversible** writes; consequential stays PC-only.

### Phase 7 — ADB phone actions — DONE (code; pairing + unlocked phone need user)
- `android.battery.status` (read).
- `android.app.open` (allowlisted packages via `adb monkey`).
- `android.media.key` (play/pause, volume up/down).
- Tool copy states: unlocked + ADB-authorized only. **No unlock, credential entry, or auto-messaging.**

### Phase 8 — Polish — DONE (code)
- Hindi/Bengali router phrases + Unicode normalize; `needs*` multilingual hints.
- Conversation TTL raised to **24h**; expired sessions archive a Vault draft summary.
- HUD polling replaced by `/api/hud-stream` SSE (conversation + interaction).
- Morning-brief Vault writes skip identical same-day content.

## Verification (this session)
- `tsc --noEmit` green
- **88** Node tests green
- Voice suite: not re-run in this session (prior Phase 4 was 136 green)

## Still for the user (hands required)
1. Rotate Gemini / confirm old OpenAI revoked
2. Add `BRAVE_SEARCH_API_KEY` if live web answers are wanted
3. Copy `config/computer-allowlist.example.json` → `.ultron/config/computer-allowlist.json` and edit paths
4. Install Tailscale on PC + phone; start with `-Tailscale`; paste the printed device token on the phone
5. Optional: set `ULTRON_SPEAKER_SESSION_VERIFIED=1` after real speaker auth for voice write stamps
6. ADB: set `ULTRON_ADB_PATH`, authorize one unlocked device; never expect lockscreen bypass
7. Live mic WER / MessageBox / type-into-focused-window / phone monkey checks on hardware

## Architecture reality
- No general shell, GUI click-automation beyond focus/type/SendKeys, email send, or phone unlock.
- Loopback UI alone cannot unlock writes; launcher token, device token (reversible only), or native dialog required.
- Web/media results are untrusted data.
- Streaming is skipped when tools are offered for a turn.

## Next exact task
Hardware/user validation of Phases 1–7 items above; then optional ROADMAP items (OAuth mail, scheduler, Wi-Fi debugging workflow) that were **not** in the Full Upgrade Prompt.
