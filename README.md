# Ultron Personal AI OS

Ultron is a local-first personal AI orchestration layer. One core coordinates focused skills, permission-gated tools, a transparent Markdown Vault, and several interaction methods. The restored yellow/orange animated structure is Ultron's face; voice, hand gestures, and clap activation are inputs to the same system rather than separate assistants.

This repository is an incremental foundation, not a claim that every integration is already connected. The browser HUD, face, gestures, skills, Vault, local speech pipeline, speaker enrollment, and a manually launched per-user activation host are present. The host shares one local microphone stream between clap detection and Silero/Whisper wake-word recognition. Startup registration and native Windows unlock are not present.

## Current capabilities

- Restored Three.js/WebGL yellow/orange Ultron face inside a dark, tab-free HUD
- Central face states for `idle`, `listening`, `transcribing`, `thinking`, `working`, `speaking`, `gesture_active`, `authenticating`, `error`, and `offline`
- Local browser hand tracking with the original gesture vocabulary
- A typed interaction event bus shared by face, gesture, voice, clap, authentication, and HUD modules
- Natural-language routing to `inbox`, `metrics`, `trends`, `plan`, or `vault`
- A composed morning workflow for requests such as `Good morning`
- Human-readable responses plus structured skill results
- Private local Markdown Vault and permission-gated external tools
- GitHub repository metrics with optional token authentication
- Local faster-whisper STT, Silero VAD, Kokoro TTS using the Michael voice, one-turn conversation control, and speaker verification
- A composed `UltronActivationHost` for local wake word, single-clap activation by default, WTS session state, warm-HUD activation, and on-demand voice
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
ULTRON_GITHUB_REPOSITORIES=
ULTRON_SPEAKER_NAME=
GITHUB_TOKEN=
ULTRON_LOCAL_EVENT_TOKEN=
```

Blank `ULTRON_TIMEZONE` uses the computer's local timezone. Set `ULTRON_SPEAKER_NAME` privately before enrollment or locked-session authentication; no identity is embedded in the repository. The native Python host does not parse `.env.local`, so set this variable in the PowerShell session that launches Ultron (as shown below) or pass `--name` to the standalone commands.

`GITHUB_TOKEN` is optional for public repositories. Keep `ULTRON_LOCAL_EVENT_TOKEN` blank when using the provided launcher: it generates a fresh 32-byte token in memory for each run and passes it to both child processes. Never commit either token.

All `.env*` files except `.env.example`, the complete `.ultron/` directory, the legacy repository-root `/vault/` directory, and in-repository voice caches are ignored. The default live Vault is `.ultron/vault/`; Ultron initializes its blank Markdown structure automatically on first use. Never place credentials, authentication data, or speaker profiles in the Vault.

## Run the complete local host manually

After installing the Node and voice dependencies/models described below, start both local processes from PowerShell:

```powershell
$env:ULTRON_SPEAKER_NAME = "Your Name"
.\scripts\start-ultron.ps1
```

Stop any separately started `npm run dev` process first; the full launcher owns its own Next server.

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

Optional device selection, two-clap mode, and open-only mode:

```powershell
.\scripts\start-ultron.ps1 -MicrophoneDevice 1 -OutputDevice 4
.\scripts\start-ultron.ps1 -SpeakerName "Your Name"
.\scripts\start-ultron.ps1 -ClapCount 2
.\scripts\start-ultron.ps1 -OpenOnly
```

The default `-ClapCount 1` opens on the first qualifying clap; use `-ClapCount 2` where false activations matter more than speed. `-OpenOnly` opens/focuses without immediately recording a command. Stop both process trees and remove the PID state file with:

```powershell
.\scripts\stop-ultron.ps1
```

This launcher is manual only. It creates no Windows startup item, service, scheduled task, Registry entry, or Credential Provider. To disable it, run the stop script and do not run the start script again.

## Face, HUD, and controls

The yellow/orange procedural structure is always mounted as Ultron's visual identity. Renderer, camera, or MediaPipe failures change status but do not remove the face. The HUD explicitly shows camera and gesture readiness.

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
- `Remember that I prefer concise answers`
- `Capture raw this is an unprocessed research note`
- `What do you know about my projects?`

The first GitHub metrics request displays a read-permission prompt. Choose one-time permission or remember that exact scope. Consequential writes are never silently executed.

## Local voice, VAD, STT, and TTS

The CPU-only voice environment verifies microphone capture, faster-whisper transcription, Silero endpointing, and Kokoro speech with `am_michael` (speaker ID `6`). It does not use CUDA.

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

The running host's wake-word implementation is local but is not a dedicated low-power keyword model: the shared microphone stream is endpointed by Silero VAD, and at most one completed candidate at a time is transcribed asynchronously by faster-whisper. It emits only a coarse wake event when the transcript starts with `Ultron`; candidates arriving while the worker is busy are dropped. After waking, the HUD opens and Ultron records a separate command utterance. Wake detection is suppressed while TTS is active and is rejected while Windows is locked. Barge-in is not implemented.

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
