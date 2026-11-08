# Ultron Personal AI OS

Ultron is a local-first personal AI orchestration layer. One core coordinates focused skills, permission-gated tools, a transparent Markdown Vault, and several interaction methods. The restored yellow/orange animated structure is Ultron's face; voice, hand gestures, and clap activation are inputs to the same system rather than separate assistants.

This repository is an incremental foundation, not a claim that every integration is already connected. The browser HUD, face, gestures, skills, Vault, local speech pipeline, speaker enrollment, and a manually launched per-user activation host are present. The host shares one local microphone stream between clap detection and Silero/Whisper wake-word recognition. Startup registration and native Windows unlock are not present.

## Current capabilities

- Restored Three.js/WebGL yellow/orange Ultron face inside a dark, tab-free HUD
- Central face states for `idle`, `listening`, `transcribing`, `thinking`, `working`, `speaking`, `gesture_active`, `authenticating`, `error`, and `offline`
- Local browser hand tracking with the original gesture vocabulary
- A typed interaction event bus shared by face, gesture, voice, clap, authentication, and HUD modules
- Natural-language routing to `inbox`, `metrics`, `trends`, `plan`, `vault`, or the local clock
- A composed morning workflow for requests such as `Good morning`
- Human-readable responses plus structured skill results
- Optional Gemini or OpenAI conversational brain with temporary follow-up context, multilingual text, and email/WhatsApp drafts (not sending)
- Shared voice/text transcript, local dictation, copy controls, and clear-chat control
- Private local Markdown Vault and permission-gated external tools
- GitHub repository metrics with optional token authentication
- Approval-gated, read-only outline of this ULTRON checkout (no file contents, command execution, or other desktop control)
- Approval-gated, read-only names of visible Windows applications and Android ADB connection counts (no window contents, device IDs, clicks, pairing, installs, or phone control)
- Local faster-whisper STT, Silero VAD, Kokoro TTS using the Michael voice, bounded voice follow-ups, and speaker verification
- A composed `UltronActivationHost` for local wake word, two-clap activation by default, WTS session state, warm-HUD activation, and on-demand voice
- A safe speaker/challenge/liveness authentication test that always stops before Windows unlock

## Run the HUD locally

Requirements: a current Node.js release with TypeScript type-stripping support and npm.

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

On macOS or Linux, use `cp .env.example .env.local`. Open [http://localhost:3000](http://localhost:3000).

Configure only the services you actually use in `.env.local`:

```dotenv
ULTRON_DATA_DIR=.ultron
ULTRON_VAULT_DIR=.ultron/vault
ULTRON_TIMEZONE=
ULTRON_LLM_PROVIDER=gemini
ULTRON_LLM_MODEL=gemini-3.5-flash-lite
GEMINI_API_KEY=
ULTRON_GITHUB_REPOSITORIES=
ULTRON_SPEAKER_NAME=
GITHUB_TOKEN=
ULTRON_ADB_PATH=
ULTRON_LOCAL_EVENT_TOKEN=
```

Blank `ULTRON_TIMEZONE` uses the computer's local timezone. Set `ULTRON_SPEAKER_NAME` privately before enrollment or locked-session authentication; no identity is embedded in the repository. The native Python host does not parse `.env.local`, so set this variable in the PowerShell session that launches Ultron (as shown below) or pass `--name` to the standalone commands.

`GITHUB_TOKEN` is optional for public repositories. Keep `ULTRON_LOCAL_EVENT_TOKEN` blank when using the provided launcher: it generates a fresh 32-byte token in memory for each run and passes it to both child processes. Never commit either token.

All `.env*` files except `.env.example`, the complete `.ultron/` directory, the legacy repository-root `/vault/` directory, and in-repository voice caches are ignored. The default live Vault is `.ultron/vault/`; Ultron initializes its blank Markdown structure automatically on first use. Never place credentials, authentication data, or speaker profiles in the Vault.

## Conversational brain and writing

Set `GEMINI_API_KEY` privately in the ignored `.env.local` with `ULTRON_LLM_PROVIDER=gemini` and restart both Ultron processes. The default model is `gemini-3.5-flash-lite`, which responded to a local API probe on 2026-10-14 after the previous model repeatedly returned HTTP 503; provider availability can change. Another model can be selected with `ULTRON_LLM_MODEL` when available. `OPENAI_API_KEY` still works when the provider is `openai`. Never paste a key into chat, a prompt, the Vault, or logs. Set `ULTRON_LLM_PROVIDER=disabled` for local skills/dictation only.

Try `Draft a polite email asking for the website content`, `Translate this into Bengali: ...`, then `Make that shorter`. General conversation and drafting use the cloud brain; deterministic local skill commands still go through the existing skills. `What time is it?` reads the computer clock in `ULTRON_TIMEZONE` locally, without a cloud call. Voice and typing share the HUD transcript. Text can be multilingual, but the installed Michael TTS voice remains English-oriented; multilingual audio quality is not claimed.

Say `Ultron`, then `dictate: ...` or `write this down ...` to put recognized words in the HUD without calling the cloud model. Use COPY to paste the result elsewhere. This does not inject keystrokes into another application, save a note automatically, or send a message. STT errors still need review.

Working conversation is saved locally under `.ultron/state/` and is ignored by the runtime after 30 minutes of idle time: at most 24 messages/32,000 characters per session. Expired sessions are removed from the file when Ultron next starts or saves conversation state; while Ultron is stopped, the file can still contain expired messages, so this is not a timed secure deletion guarantee. CLEAR CHAT removes the current session, not saved Vault notes. Local dictation/skill outputs are not silently added to future cloud-model input. Gemini requests send only that conversation text and approved Vault excerpts. The OpenAI provider, when selected, uses the Responses API with `store:false`. See [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).

Model-callable read tools are offered only when the request calls for saved context, project structure, visible app names, or Android connection status. Sharing requires a scope-specific approval; Vault notes tagged `private`, `local-only`, `no-cloud`, or `sensitive` are excluded even after approval. DENY cancels the pending tool without clearing the conversation. Choosing ALWAYS ALLOW remembers only that narrow read scope. Open ACCESS in the HUD to revoke it. Audio, camera frames, and authentication data never go through this provider.

Ask `Which apps are open on my desktop?` or `Is my Android phone connected for wireless debugging?` to request a narrow read. Approval is required before a result is shared with the conversational model. The Android check uses the official `adb devices` command when Platform Tools are installed in a known SDK location or `ULTRON_ADB_PATH` points to an absolute `adb.exe`; ADB may start its local server. It returns counts only, never device serials or pairing codes. If ADB is absent, it reports that honestly. Pairing must be initiated and approved on the phone, and no Android actions are implemented yet.

There is no connected email/WhatsApp sending, browser automation, coding execution, app control, phone control, or live web-search tool in the brain. Drafts and explanations are real capabilities; external actions are not claimed. See [the next capability roadmap](docs/ROADMAP.md).

## Run the complete local host manually

After installing the Node and voice dependencies/models described below, start both local processes from PowerShell:

```powershell
$env:ULTRON_SPEAKER_NAME = "Your Name"
.\scripts\start-ultron.ps1
```

Stop any separately started Ultron `npm run dev` process first; the full launcher owns its own Next server. If another project uses port 3000, pass `-Port 3010`. The launcher shares that address with the native HUD, event bridge, and voice core adapters through `ULTRON_LOCAL_BASE_URL` and restores the previous environment value on exit.

The launcher starts two hidden process trees:

- **Next node server**: serves the loopback HUD and Ultron APIs at `http://localhost:3000`.
- **Python `UltronActivationHost`**: reads the selected 16 kHz microphone, detects qualifying clap impulses, endpoints possible wake phrases with local Silero VAD, recognizes a leading `Ultron` with local faster-whisper, observes WTS lock state, brings the HUD forward, and creates heavier conversation/authentication components only when needed.

The launcher creates a cryptographically random local event token in memory. Both children inherit it; it is not written to `.env.local`, logs, or `processes.json`, and the launcher's prior environment value is restored. Runtime state and logs are written only under the ignored `.ultron/runtime/` directory:

```text
processes.json  # PID, executable, start time, and repository fingerprint; no token
server.out.log
server.err.log
activation.out.log
activation.err.log
```

Optional device selection, one-clap mode, and open-only mode:

```powershell
.\scripts\start-ultron.ps1 -MicrophoneDevice 1 -OutputDevice 4
.\scripts\start-ultron.ps1 -SpeakerName "Your Name"
.\scripts\start-ultron.ps1 -ClapCount 1
.\scripts\start-ultron.ps1 -OpenOnly
.\scripts\start-ultron.ps1 -Port 3010
.\scripts\start-ultron.ps1 -Production
```

The default requires two deliberate claps to reduce false activations from movies and room noise. `-ClapCount 1` restores the faster but more sensitive shortcut. The HUD's **ULTRON VOICE ON/OFF** button pauses/resumes background wake-word and clap detection; OFF releases the microphone after any active turn, while text chat stays available. This setting is stored privately under `.ultron/runtime/activation-control.json` and survives a restart. Open the HUD manually in your browser to turn voice back on. `-OpenOnly` opens/focuses without immediately recording a command. `-Production` serves `next start` instead of the development server; run `npm run build` first. Stop both process trees and remove the PID state file with:

```powershell
.\scripts\stop-ultron.ps1
```

This launcher is manual only. It creates no Windows startup item, service, scheduled task, Registry entry, or Credential Provider. To disable it, run the stop script and do not run the start script again.

## Face, HUD, and controls

The yellow/orange procedural structure is always mounted as Ultron's visual identity. Renderer, camera, or MediaPipe failures change status but do not remove the face. The HUD explicitly shows camera and gesture readiness.
While Ultron listens, the face bounces with a coarse local microphone-level signal and shows **HEARING YOU**. Only a bounded 0–1 loudness value reaches the local HUD; no audio or words are sent for the animation. During spoken output, the whole structure transitions to blue and shows **ULTRON SPEAKING**; it returns to amber afterward.

The recovered gesture vocabulary is intentionally unchanged:

- One pinched hand (thumb and index finger) plus movement spins the face.
- Two pinched hands spreading apart or closing together zoom the face.

No select, dismiss, or system-authority gestures are implied. Camera frames are processed locally in the browser and are not sent to a cloud API. Browser camera permission is explicit; press `G` to disable or enable gesture tracking. The pinned MediaPipe WebAssembly runtime and hand-landmark model are vendored under `public/mediapipe/`, so gesture startup does not fetch executable code or a camera-processing model from a CDN. Checksums and the upstream Apache 2.0 notice are preserved there.

| Input | Action |
| --- | --- |
| Mouse drag | Spin the face |
| Mouse wheel or touch pinch | Zoom in or out |
| One-hand pinch and move | Spin the face |
| Two-hand pinch and spread/close | Zoom in or out |
| `G` | Toggle webcam gestures |
| `R` | Reset the face |
| `+` / `-` | Zoom in or out |

## Try the AI OS foundation

- `Good morning`
- `What needs my attention today?`
- `Give me the numbers`
- `What's changed since yesterday?`
- `Plan my day`
- `Add task Finish the Ultron voice setup due tomorrow`
- `Done task Finish the Ultron voice setup`
- `Add project Ultron: Make the morning brief reflect real work`
- `Block project Ultron: waiting on a calendar connection`
- `Project status`
- `Add inbox Review the college notice`
- `Remember that I prefer concise answers`
- `Capture raw this is an unprocessed research note`
- `What do you know about my projects?`

The first GitHub metrics request displays a read-permission prompt. Choose one-time permission or remember that exact scope. Consequential writes are never silently executed.

## Local voice, VAD, STT, and TTS

The local voice environment uses CPU-only Silero endpointing and Kokoro speech with `am_michael` (speaker ID `6`). Conversational faster-whisper uses CUDA float16 when the optional NVIDIA runtime is available, with a CPU int8 fallback; the standalone STT diagnostic uses CPU int8.

```powershell
conda create --name ultron-voice --override-channels --channel conda-forge python=3.12 pip -y
conda activate ultron-voice
python -m pip install -r voice/requirements-stage3.txt
python voice/stage2_stt_check.py --list-devices
python voice/stage2_stt_check.py --download-only
python voice/stage2_stt_check.py --seconds 10 --language en
python voice/download_stage3_models.py
python voice/stage3_vad_check.py
python voice/stage3_tts_check.py
```

Models default to `~/.cache/ultron-voice/models`; override this with `ULTRON_VOICE_MODEL_DIR`. Temporary STT and wake-candidate WAV files are deleted locally. VAD and TTS operate in memory unless an output file is explicitly requested. `voice/conversation.py` sends only ordinary transcribed conversational text to the loopback Ultron API.

The running host's wake-word implementation is local but is not a dedicated low-power keyword model: the shared microphone stream is endpointed by Silero VAD, and at most one completed candidate at a time is transcribed asynchronously by faster-whisper. It emits only a coarse wake event when the transcript starts with `Ultron`; candidates arriving while the worker is busy are dropped. Words spoken after `Ultron` in that same utterance are handed to the core in memory, without a second recording; a wake word alone opens the HUD and starts a separate command capture. Following a completed reply, Ultron listens for up to eight seconds for another utterance, for at most three follow-up turns without repeating the wake word. Set `ULTRON_VOICE_FOLLOW_UP_TURNS=0` in `.env.local` to disable this behavior (allowed range: 0–5), then restart. Only transcribed conversational text follows the selected cloud-model path; temporary audio remains local. Wake detection is suppressed while TTS is active and is rejected while Windows is locked. Kokoro playback begins with generated sentence chunks, but barge-in and streamed model output are not implemented. Safe stage-duration lines in the ignored activation log show capture, transcription, core, and TTS/playback timings without audio or transcripts.

## Speaker enrollment and authentication boundary

Download the pinned local WeSpeaker CAM++ model, then enroll from five prompted recordings:

```powershell
conda activate ultron-voice
python -m voice.download_speaker_model
python -m voice.interactive_enrollment --name "Your Name"
```

For existing recordings, use at least three varied samples:

```powershell
python -m voice.enroll_speaker --name "Your Name" `
  --sample sample-1.wav --sample sample-2.wav --sample sample-3.wav
```

Enrollment stores an averaged speaker embedding, not the raw recordings, under `%LOCALAPPDATA%\Ultron\Auth\speaker-profiles\` using current-user Windows DPAPI. Protected security events are stored separately under `%LOCALAPPDATA%\Ultron\Auth\`. Neither belongs in the Vault.

After enrollment, exercise the complete local identity/challenge prototype without unlocking Windows:

```powershell
python -m voice.authenticate_speaker --name "Your Name"
```

Optional device IDs are accepted as `--microphone-device N` and `--output-device N`. This command explicitly simulates the locked authentication flow for testing only. It never calls a Windows unlock API.

The locked-session authentication flow is a fail-closed prototype: speaker match, a changing five-word challenge sampled from 128 distinct local tokens, local audio-quality liveness heuristic, and protected throttling can be tested, but success always stops before OS unlock. The larger challenge materially raises resistance to pre-recording/splicing; it does not make the heuristic liveness check production-grade or certified anti-spoofing. A normal app cannot authorize Windows' secure desktop. Completing that feature would require a separately reviewed, installed, and signed native [Windows Credential Provider](https://learn.microsoft.com/en-us/windows/win32/secauthn/winlogon-and-credential-providers) or another Microsoft-supported sign-in mechanism. Ultron never stores, injects, or simulates entry of a Windows password.

## Double-clap and background activation status

The local detector uses timing plus energy and spectral characteristics, has a cooldown, and is gated during and immediately after TTS to reduce self-triggering. The Windows modules distinguish locked, unlocked, and unknown sessions through WTS notifications and can request a warm Edge app-mode HUD through supported window APIs without simulated input.

The manual host is composed and runnable through `scripts/start-ultron.ps1`. It remains an ordinary signed-in-user process, not an installed always-on Windows feature. There is no service, scheduled task, startup registration, or Credential Provider in this repository.

Before any future startup registration, Ultron must show the user:

1. the exact process or executable that will start;
2. its microphone and activation responsibilities;
3. expected resource use;
4. the startup mechanism; and
5. the exact disable/removal procedure.

Registration may proceed only after explicit approval.

## Markdown Vault

The live Vault defaults to `.ultron/vault/`, outside Git's tracked content:

- `.ultron/vault/raw/` preserves original captures before synthesis.
- `.ultron/vault/wiki/` stores one canonical page per durable topic.
- `.ultron/vault/outputs/` stores dated, non-overwriting plans, briefs, metrics, and trend reports.
- `.ultron/vault/INDEX.md` is regenerated from page summaries.
- `.ultron/vault/CHANGELOG.md` receives append-only meaningful change entries.
- `.ultron/vault/AGENTS.md` contains the rules future coding agents must follow.

No personal Vault page or example identity is required in the repository. On the first Vault read or write, Ultron creates the directories and blank control files automatically. An earlier local `vault/` directory remains ignored and untouched; to keep using those files in place, set `ULTRON_VAULT_DIR=vault` only in `.env.local`. Keep either location private, back it up separately, and never add secrets or authentication material.

## Quality checks

The default suites are hardware-free and use mocks for cameras, microphones, Windows APIs, launcher boundaries, wake-word behavior, and authentication. Use the runner output for current test counts rather than treating a documented count as fixed.

```powershell
npm run typecheck
npm test
npm run test:launcher
npm run build
```

`npm test` runs both the Node/TypeScript suite and the Python voice suite through the reviewed `ultron-voice` environment. `npm run verify:windows` is the complete local release gate: typecheck, both suites, launcher lifecycle tests, and production build.

Manual microphone, camera, speaker, and Windows foreground tests must be run deliberately on the target PC; the automated test commands do not enroll startup persistence or unlock Windows.

## Architecture and detailed setup

- [Personal AI OS Architecture](docs/ARCHITECTURE.md)
- [Voice and Windows interaction development](voice/README.md)
- [Third-party voice model notices](voice/THIRD_PARTY_MODELS.md)

## Interface lineage and license

The yellow/orange face and original pinch controls were adapted from [SAGAR-TAMANG/ultron-by-sagar-builds](https://github.com/SAGAR-TAMANG/ultron-by-sagar-builds). That origin remains documented, and the original copyright and MIT license notice remain in [LICENSE](LICENSE). Third-party software and model licenses remain separate and must also be followed.
