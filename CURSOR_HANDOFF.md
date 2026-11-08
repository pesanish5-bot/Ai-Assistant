# ULTRON handoff for Cursor

Read this before continuing development. It describes the **current local checkout**, not just the published GitHub branch. Do not clone over it, reset it, discard uncommitted files, or assume the README proves a feature works. Reinspect the code and run tests before making a claim.

## Open this exact checkout

`C:\Users\pesan\Documents\Codex\2026-08-10\https-github-com-sagar-tamang-ultron\work\ultron-by-sagar-builds`

Git remote: `https://github.com/pesanish5-bot/Ai-Assistant.git`. Branch: `main`.

Never copy `.env.local`, `.ultron/`, cached voice models, credentials, raw audio, or speaker profiles into a public commit or a handoff prompt. **User action required:** rotate the Gemini API key in Google AI Studio (it appeared in past chat sessions) and confirm the previously exposed OpenAI key is revoked. Update `.env.local` locally only. Do not print key values. This handoff contains no credentials.

## Progress (2026-11-08 Full Upgrade Prompt)

### Phase 0 — Protect existing work — DONE
Six focused commits pushed earlier (`c740635`…`3bc35eb`): secrets scan clean, audio ignores, CI workflow, unpublished work committed. Verification: tsc, 66 Node tests, voice suite, launcher.

### Phase 1 — Voice latency streaming — DONE (code; live mic eval still needs user)
- Gemini `streamGenerateContent` SSE → `LanguageModelProvider.streamText`
- Runtime/API NDJSON stream (`stream: true`) for voice
- Voice host speaks sentence units as deltas arrive (`iter_speakable_units` + chunked Kokoro)
- Capture default timeout 12s; max speech capped to deadline; mic-loss emits `activation.rejected`
- Commit `e129dd3`. Tests: tsc, 68 Node, voice suite green.
- **Unverified on hardware:** audible first-audio speedup, 30–50 phrase WER, blue face sync. Run `python -m voice.evaluate_stt --live` privately when ready.

### Phase 2 — Activation route gap — DONE
- `POST /api/activation` requires launcher Bearer token **or** same-origin HUD (`Sec-Fetch-Site: same-origin`); bare loopback curl without token → 401
- Publishes `activation.changed` to interaction projector / HUD
- Commit `2260ac9`

### Next exact task
**Phase 3 — Internet access:** add `web.search` / `web.fetch` read tools behind permissions with HTTPS-only fetch, DNS/private-IP SSRF blocking, size/timeout caps, untrusted-data envelope, Brave Search or similar key in `.env.local`, brain `needs*` gates, and tests.

Then Phase 4 (trusted write confirmation) before any computer-use actions.

## Architecture reality (unchanged constraints)

- No general shell, GUI automation, email send, or phone unlock.
- Loopback UI is still **not** a trusted write channel for consequential actions.
- Existing tools: Vault search, workspace outline, desktop app names, Android ADB counts, local time skill.
- Streaming helps ordinary chat; tool calls still use the non-stream path.

## Rules for continuation

Preserve face, gestures, voice, Vault, permissions. Treat web/model output as untrusted. Never give unrestricted shell/filesystem/credentials/device access. Never force-push. Update this file at every stopping point.
