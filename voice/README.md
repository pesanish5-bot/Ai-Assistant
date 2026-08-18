# Ultron local voice and Windows interaction development

Voice is an adapter around the existing Ultron runtime, not a second assistant. This directory also contains the local clap detector, speaker-verification boundary, fail-closed authentication prototype, and per-user Windows HUD activation modules.

## Status at a glance

| Capability | Current status |
| --- | --- |
| Local microphone and faster-whisper STT | Standalone diagnostic works |
| Local Silero VAD | Standalone diagnostic works |
| Local Kokoro TTS, Michael voice | Standalone diagnostic works |
| Speaker model download and multi-sample enrollment | Works locally on Windows |
| Double-clap classification and TTS suppression | Implemented and hardware-free tested |
| Windows lock-state and warm HUD control | Implemented behind mockable adapters |
| Native-to-browser event bridge | Loopback-only and token-gated |
| Per-user background host | Composed and manually launched; not installed at startup |
| One-turn VAD -> STT -> core -> TTS pipeline | Implemented and mock-tested |
| Local wake word | Shared Silero/Whisper stream is connected; no dedicated keyword model or barge-in |
| Windows startup registration or service | Not installed and not implemented |
| Programmatic Windows unlock | Intentionally unsupported |

## Environment

The development environment is named `ultron-voice` and uses Python 3.12. `requirements-stage3.txt` includes the Stage 2 dependencies.

```powershell
conda create --name ultron-voice --override-channels --channel conda-forge python=3.12 pip -y
conda activate ultron-voice
python -m pip install -r voice/requirements-stage3.txt
```

Set `ULTRON_VOICE_MODEL_DIR` to override the default private cache at `~/.cache/ultron-voice/models`. Cached models are ignored by Git.

Set `ULTRON_SPEAKER_NAME` in the launching process, or pass `--name` explicitly, before enrollment or authentication. The native Python host intentionally does not parse `.env.local`; for the background host, set `$env:ULTRON_SPEAKER_NAME = "Your Name"` in the PowerShell session before running the launcher. The repository contains no default personal identity; authentication setup fails closed when the name is absent.

## Stage 2: local STT

```powershell
conda activate ultron-voice
python voice/stage2_stt_check.py --list-devices
python voice/stage2_stt_check.py --download-only
python voice/stage2_stt_check.py --seconds 8 --language en
```

The recording command gives a three-second audible countdown. If Windows has `Stereo Mix` selected, the diagnostic prefers the built-in microphone array. Pass `--device-id N` to override selection.

Transcription uses CPU `int8` faster-whisper by default. The diagnostic writes only a temporary WAV and deletes it immediately after transcription. It does not place raw audio or transcripts in the Vault.

## Stage 3: local VAD and TTS

Stage 3 uses CPU-only sherpa-onnx with Silero VAD and English Kokoro TTS. Michael is `am_michael`, speaker ID `6`, in `kokoro-en-v0_19`.

```powershell
python voice/download_stage3_models.py
python voice/stage3_vad_check.py
python voice/stage3_tts_check.py --list-devices
python voice/stage3_tts_check.py
```

VAD retains microphone samples in memory and completes after detected speech is followed by approximately 700 ms of silence. TTS generates audio in memory and uses the Windows default output unless `--no-play` is supplied. Pass `--output PATH` only when an explicit WAV is wanted.

These commands verify individual components. They do not start the background host.

## One-turn conversational pipeline

`conversation.py` composes the production-local adapters for exactly one ordinary voice turn:

```text
Silero-endpointed microphone capture
  -> faster-whisper small (CPU int8)
  -> accepted conversational text only
  -> loopback /api/ultron
  -> Kokoro Michael playback
```

It supports `direct`, `wake_word`, and the compatibility-named `double_clap` conversation mode. Wake-word mode requires the transcript to begin with `Ultron`; clap-activated conversation accepts the following utterance without requiring the prefix.

The temporary conversation WAV exists only for local STT and is removed before text is sent to the core. Listening, transcribing, and speaking events contain only coarse active-state booleans. TTS state also gates the clap detector.

`build_local_conversation_pipeline()` constructs the Silero, faster-whisper, loopback core, Kokoro Michael, event, and playback-gate adapters without eagerly opening hardware or loading models. `run_background.py` now creates this pipeline only after an accepted activation.

## Current wake-word implementation

The manually launched host listens through one 16 kHz microphone stream shared with clap detection:

```text
microphone frames
  -> local Silero VAD endpoints a candidate phrase
  -> bounded background worker writes a temporary local WAV
  -> faster-whisper small, CPU int8, recognizes the candidate
  -> transcript starts with "Ultron"
  -> emit coarse voice.wake_detected only
  -> if Windows is unlocked, open/focus HUD and capture a separate command utterance
```

This is not a dedicated low-power keyword model. Local Whisper runs on completed speech candidates, not on every 32 ms frame. Only one candidate transcription may be active; further candidates are dropped rather than queued without limit. Temporary candidate WAVs are deleted, and neither candidate transcript nor audio crosses the HUD event bridge.

The current experience uses two utterances: say `Ultron`, wait for the HUD/listening state, then say the command. Any additional words in the wake candidate are intentionally discarded. Wake activation is rejected while Windows is locked and never starts speaker authentication. TTS playback and its post-playback window suppress/reset both wake and clap detection. Barge-in is not implemented.

## Local model sources and attribution

Downloaded models live outside the repository, but their upstream terms still apply:

| Component | Upstream and license |
| --- | --- |
| faster-whisper | [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper), MIT License |
| Whisper model lineage | [openai/whisper](https://github.com/openai/whisper), MIT License |
| Silero VAD | [snakers4/silero-vad](https://github.com/snakers4/silero-vad), MIT License |
| sherpa-onnx runtime/model distribution | [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), Apache License 2.0 |
| Kokoro | [hexgrad/kokoro](https://github.com/hexgrad/kokoro), Apache License 2.0; the downloaded bundle's included `LICENSE` is retained and validated |
| WeSpeaker CAM++ | [wenet-e2e/wespeaker](https://github.com/wenet-e2e/wespeaker), Apache License 2.0; VoxCeleb-trained model CC BY 4.0 |

The pinned WeSpeaker artifact, checksum, release source, and redistribution notice are documented in [THIRD_PARTY_MODELS.md](THIRD_PARTY_MODELS.md). Do not remove upstream license files or notices when redistributing software or model artifacts.

## Speaker model and enrollment

Speaker verification answers who spoke; STT answers what was said. A recognized name is never sufficient authentication.

Download and verify the pinned local English WeSpeaker CAM++ model:

```powershell
python -m voice.download_speaker_model
```

The downloader verifies SHA-256 `c46fad10b5f81e1aa4a60c162714208577093655076c5450f8c469e522ec54ef` before the backend is used.

### Recommended interactive enrollment

```powershell
python -m voice.interactive_enrollment --name "Your Name"
```

The command records five varied prompted phrases locally, six seconds each by default. Use `--device-id N` for a specific input or `--seconds N` between 3 and 12. It rejects recordings that are too quiet. Temporary WAV files are deleted after embeddings are extracted.

### Enrollment from existing files

Provide at least three varied, mono-compatible recordings. The backend requires 16 kHz audio between one and 30 seconds per file.

```powershell
python -m voice.enroll_speaker --name "Your Name" `
  --sample sample-1.wav --sample sample-2.wav --sample sample-3.wav
```

Enrollment averages normalized embeddings and stores only the resulting profile. It does not copy raw samples into the profile.

## Authentication data isolation

The default profile is stored under:

```text
%LOCALAPPDATA%\Ultron\Auth\speaker-profiles\<derived-profile-id>.dpapi.profile
```

The safe-field-only event log is stored under:

```text
%LOCALAPPDATA%\Ultron\Auth\security-events.dpapi.jsonl
```

Both use current-user Windows DPAPI. Machine-wide DPAPI is deliberately not used. The code fails rather than falling back to plaintext if Windows DPAPI or `%LOCALAPPDATA%` is unavailable.

The security log records coarse outcomes such as timestamp, activation method, speaker/challenge result, and unlock result. It excludes passwords, raw audio, challenge answers, detailed biometric scores, and tokens. Authentication data must never be moved into `vault/`, prompts, ordinary conversation memory, or LLM context.

## Local interaction modules

- `interaction.py`: normalized events, TTS/post-playback suppression, and explicit locked/unlocked/unknown routing
- `clap.py`: configurable energy, peak, crest-factor, spectral-flatness, high-band, timing, and cooldown checks
- `adapters.py`: narrow VAD, STT, TTS, loopback runtime, and HUD event seams
- `conversation.py`: serialized one-turn voice orchestration and wake-prefix/clap-activation modes
- `local_conversation_audio.py`: lazy CPU-only Silero capture, faster-whisper, and Kokoro Michael adapters
- `wake_word.py`: shared-frame Silero endpointing, bounded asynchronous Whisper recognition, and normalized wake events
- `speaker.py`: verifier/liveness interfaces, cosine verification, protected profile storage, mocks, and multi-sample enrollment
- `sherpa_speaker.py`: pinned local CAM++ embedding backend and checksum verification
- `security.py`: randomized challenges, progressive throttling, and protected safe-field-only events
- `authentication.py`: fail-closed speaker/challenge/liveness prototype
- `protection.py`: current-user Windows DPAPI protection
- `windows_session.py`: WTS session-state query and explicit lock/unlock notifications
- `windows_hud.py`: warm Edge app-mode HUD reuse and supported foreground/window calls
- `windows_activation.py`: locked/unlocked activation policy
- `background_agent.py`: lightweight 16 kHz frame source, clap detector, bounded mailbox, and lazy activation seam
- `run_background.py`: complete ordinary-user-session `UltronActivationHost` composition
- `locked_auth_workflow.py`, `authenticate_speaker.py`: interactive local authentication test that stops before OS sign-in

Detectors produce facts. Controllers apply policy. HUD, AI core, and OS adapters remain separate.

## Clap activation detector

The clap classifier itself does not use speech-to-text. It evaluates impulse energy, crest factor, spectral flatness/high-band characteristics, timing, and cooldown. The personal launcher defaults to one qualifying clap for low latency and supports `-ClapCount 2` for stronger false-activation resistance; two-clap mode uses an 800 ms window and 160 ms minimum gap. In the composed host, the same frames also feed local Silero endpointing and bounded Whisper wake recognition.

While TTS is active, and during a short post-playback suppression period, clap candidates are ignored so Ultron does not summon itself. Music, doors, speech, and keyboard noise still require real-room evaluation; automated tests cannot guarantee acoustic performance.

## Unlocked Windows activation

The intended path is:

```text
qualifying clap (one by default)
  -> clap.activation_detected
  -> WTS session state
  -> hud.open_requested
  -> show/reuse Edge app-mode HUD
  -> request listening
```

`windows_session.py` uses `WTSSessionInfoEx` and receives `WTS_SESSION_LOCK` / `WTS_SESSION_UNLOCK` through a hidden message-only window. Unknown state fails closed. Lock state is never inferred from the foreground application.

`windows_hud.py` opens `http://localhost:3000` in Microsoft Edge app mode, retains the process/window for warm reuse, and requests visibility with `ShowWindow`, `SetWindowPos`, and `SetForegroundWindow`. If Windows denies focus, it uses a short topmost/non-topmost visibility pulse. It never simulates keyboard or mouse input.

When the full launcher is used, it starts the Next server before the activation host. Double clap can then request the warm HUD from other unlocked desktop applications, subject to normal Windows foreground restrictions. This still requires real-PC acoustic and foreground testing.

## Native-to-HUD event bridge

The browser endpoint is loopback-only. Native event POSTs require `ULTRON_LOCAL_EVENT_TOKEN` to have the same value in the Next and Python process environments and contain at least 32 characters.

`scripts/start-ultron.ps1` handles this automatically: it generates a random 32-byte token in memory, launches both children with it, restores the caller's previous environment value, clears its byte buffer, and does not persist the token in `.env.local`, state, or logs. If the processes are started separately, the operator must provide a matching high-entropy token manually.

Only coarse allowlisted events cross the bridge. Authentication audio, transcripts, challenge content, speaker embeddings, scores, liveness evidence, and diagnostic reasons never do. Coarse prototype pass/fail events may update the face, but carry no biometric evidence or authority. Normal transcribed conversational text may use `LocalUltronHttpAdapter` with the loopback `/api/ultron` endpoint; authentication material may not.

## Locked-session authentication prototype

The local flow is designed as:

```text
qualifying clap
  -> identify yourself
  -> expected identity claim
  -> speaker verification
  -> randomized five-token spoken challenge
  -> challenge speech match + speaker match + liveness
  -> authentication prototype success
  -> user completes native Windows sign-in
```

The challenge changes each attempt. The prototype tracks separate speaker, speech, and liveness evidence, applies conservative thresholds, times out, and progressively delays repeated failures. It fails closed for wrong or uncertain voice, wrong challenge, replay suspicion, microphone failure, timeout, unknown session state, or protected-storage failure. `liveness.py` supplies conservative local audio-quality checks that reject silence, clipping, implausible duration, and several obvious replay-like signals. This heuristic is defense in depth, not certified anti-spoofing; production evaluation and likely a stronger reviewed local backend remain required.

After completing interactive enrollment, the safe standalone exercise is:

```powershell
python -m voice.interactive_enrollment --name "Your Name"
python -m voice.authenticate_speaker --name "Your Name"
```

`authenticate_speaker` accepts `--name "Your Name"` (or `ULTRON_SPEAKER_NAME`), plus optional `--microphone-device N` and `--output-device N`. It runs the identity, randomized challenge, speaker comparison, and heuristic liveness flow locally. It models a locked session internally but does not lock or unlock the PC.

`AuthenticationDecision.allows_os_unlock` is always `False`. No module accepts or stores a Windows password, injects credentials, simulates input, calls an unlock API, registers a Credential Provider, or replaces Windows Hello.

A normal signed-in user process cannot own the Windows secure desktop or securely unlock the PC. A real integration would require a separately designed, reviewed, installed, and signed native Windows Credential Provider or another Microsoft-supported sign-in mechanism. Do not implement a password-injection workaround.

## Background-host and startup policy

`run_background.py` composes an ordinary per-user process whose logical name is `UltronActivationHost`. It is not a Windows service. Its continuous responsibilities are:

- read 16 kHz microphone frames;
- detect clap activation candidates;
- locally endpoint speech candidates and run one bounded Whisper wake transcription at a time;
- route activation by explicit lock state; and
- create the full conversational or authentication pipeline only after accepted activation.

### Manual launcher

From the repository root:

```powershell
.\scripts\start-ultron.ps1
```

The script locates the reviewed voice Python environment using `ULTRON_VOICE_PYTHON`, the default `.conda\envs\ultron-voice\python.exe`, or `python.exe`. It then launches two hidden process trees:

- **Next node server**: loopback HUD and APIs at `http://localhost:3000`
- **Python `UltronActivationHost`**: microphone activation, WTS state, HUD focus, and on-demand local voice/authentication

Runtime files are all under ignored `.ultron/runtime/`:

| File | Purpose |
| --- | --- |
| `processes.json` | PID, executable, start time, and repository fingerprints; no token |
| `server.out.log`, `server.err.log` | Next process output |
| `activation.out.log`, `activation.err.log` | Python host output |

Optional flags:

```powershell
.\scripts\start-ultron.ps1 -MicrophoneDevice 1 -OutputDevice 4
.\scripts\start-ultron.ps1 -SpeakerName "Your Name"
.\scripts\start-ultron.ps1 -ClapCount 2
.\scripts\start-ultron.ps1 -OpenOnly
```

`-OpenOnly` changes unlocked clap activation to open/focus without the immediate follow-up listening turn. Stop and disable the manual session with:

```powershell
.\scripts\stop-ultron.ps1
```

The stop script terminates both recorded process trees and removes `processes.json`; logs remain for diagnosis. Because no persistence is installed, not running the start script is sufficient to keep Ultron disabled after the current processes are stopped.

No startup item, service, scheduled task, or Registry entry has been created. Before any future startup registration, the UI or installer must show:

1. exact process/executable name and path;
2. microphone and activation responsibilities;
3. approximate resource use;
4. exact startup mechanism; and
5. exact steps to disable and remove it.

Registration requires explicit user approval. Enrollment approval is not startup approval.

## Windows platform boundaries and references

- Lock/unlock awareness uses Microsoft's [`WTSRegisterSessionNotification`](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsregistersessionnotification) contract and corresponding session-change messages.
- Microsoft documents that Windows restricts which processes may call [`SetForegroundWindow`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow). Ultron therefore reports/falls back to a non-input visibility pulse instead of simulating clicks or keys.
- Secure interactive sign-in belongs to Winlogon, Logon UI, Credential Providers, LSA, and authentication packages; see [credentials processes in Windows authentication](https://learn.microsoft.com/en-us/windows-server/security/windows-authentication/credentials-processes-in-windows-authentication) and [Credential Providers in Windows](https://learn.microsoft.com/en-us/windows/win32/secauthn/credential-providers-in-windows).
- The older [Windows Hello Companion Device Framework](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/windows-hello-companion-device-framework) is deprecated in Windows 10 version 2004 and later, so it is not an acceptable shortcut.

Consequently, a normal Python/Next process cannot authorize the Windows secure desktop. Native OS unlock remains unimplemented. Any future route would be a separate reviewed, signed, installed native authentication project with a system sign-in recovery path; it cannot be a password store or input-injection hack.

## Tests

All automated voice/Windows tests use mocks or generated sample data and do not enable the microphone, camera, startup persistence, or Windows unlock.

```powershell
python -m unittest discover -s voice/tests -v
```

Focused Windows activation tests:

```powershell
python -m unittest voice.tests.test_windows_activation -v
```

Rely on the test runner for the current case count. Coverage includes composed-host wiring, bounded wake transcription, wake/clap coexistence, one-turn voice state and temporary-file handling, Michael voice selection, clap timing, false rejection, cooldown, TTS self-trigger suppression, locked/unlocked/unknown routing, WTS state mapping, warm HUD reuse, foreground-denial fallback, missing microphones, mailbox communication, speaker profile comparison, multi-sample enrollment, protected storage, safe log fields, locked-auth workflow, liveness quality checks, challenge mismatch, timeout, and throttling.

Manual camera, microphone, acoustic false-positive, TTS echo, speaker-match, and foreground-window tests remain required on the target Windows PC. Run those deliberately; they are not part of the default automated suite.
