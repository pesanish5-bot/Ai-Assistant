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
python voice/stage2_stt_check.py --download-only --model base
python voice/stage2_stt_check.py --seconds 8 --language en
```

The recording command gives a three-second audible countdown. If Windows has `Stereo Mix` selected, the diagnostic prefers the built-in microphone array. Pass `--device-id N` to override selection.

The standalone diagnostic uses CPU `int8` faster-whisper. The running conversational host selects CUDA `float16` when the optional NVIDIA runtime is available, otherwise CPU `int8`. The diagnostic writes only a temporary WAV and deletes it immediately after transcription. It does not place raw audio or transcripts in the Vault.

## Stage 3: local VAD and TTS

Stage 3 uses CPU-only sherpa-onnx with Silero VAD and English Kokoro TTS. Michael is `am_michael`, speaker ID `6`, in `kokoro-en-v0_19`.

```powershell
python voice/download_stage3_models.py
python voice/stage3_vad_check.py
python voice/stage3_tts_check.py --list-devices
python voice/stage3_tts_check.py
```

VAD retains microphone samples in memory and completes after detected speech is followed by approximately 1100 ms of silence in normal conversation. Conversational TTS begins playback as Kokoro produces sentence chunks, without first waiting for the full reply; it resolves the current Windows default output for each reply. Pass `-OutputDevice N` to `scripts/start-ultron.ps1` if Windows routes sound to the wrong speaker. Pass `--output PATH` to the standalone diagnostic only when an explicit WAV is wanted.

These commands verify individual components. They do not start the background host.

## Conversational voice pipeline

`conversation.py` composes the production-local adapters for an ordinary voice turn, and the activation session can repeat it for bounded follow-ups:

```text
Silero-endpointed microphone capture
  -> faster-whisper small by default (CUDA float16 when available, CPU int8 fallback; `base` is a faster/less accurate option)
  -> accepted conversational text only
  -> loopback /api/ultron
  -> Kokoro Michael playback
```

It supports `direct`, `wake_word`, and the compatibility-named `double_clap` conversation mode. Wake-word mode requires the transcript to begin with `Ultron`; clap-activated conversation accepts the following utterance without requiring the prefix.

The temporary conversation WAV exists only for local STT and is removed before text is sent to the core. The captured audio must pass short/silent/clipped quality checks before transcription; very weak STT segments are discarded and empty results trigger a spoken repeat request. The visual response remains intact, while Markdown, code blocks, and URLs are simplified before Kokoro speaks. Listening, transcribing, thinking, and speaking events contain only coarse active-state booleans. TTS state also gates the clap detector.

`build_local_conversation_pipeline()` constructs the Silero, faster-whisper, loopback core, Kokoro Michael, event, and playback-gate adapters without eagerly opening hardware or loading models. `run_background.py` now creates this pipeline only after an accepted activation.

## Current wake-word implementation

The manually launched host listens through one 16 kHz microphone stream shared with clap detection:

```text
microphone frames
  -> local Silero VAD endpoints a candidate phrase
  -> bounded background worker writes a temporary local WAV
  -> faster-whisper small by default, CUDA if available, recognizes the candidate
  -> transcript starts with "Ultron"
  -> emit coarse voice.wake_detected only
  -> if Windows is unlocked, open/focus HUD and pass along any words already spoken after "Ultron"
```

This is not a dedicated low-power keyword model. Local Whisper runs on completed speech candidates, not on every 32 ms frame. Only one candidate transcription may be active; further candidates are dropped rather than queued without limit. Temporary candidate WAVs are deleted, and neither candidate transcript nor audio crosses the HUD event bridge.

Say `Ultron` and continue with your question in one utterance, or pause after `Ultron` and speak when the HUD starts listening. A wake utterance containing a command is sent directly to the core without a second recording. After Ultron replies, it listens for up to eight seconds for a follow-up, up to three turns without another wake word. `ULTRON_VOICE_FOLLOW_UP_TURNS=0` disables follow-ups; values 0–5 are accepted. The ordinary wake/command path defaults to multilingual `small`; `ULTRON_VOICE_STT_MODEL=base` is an optional speed/accuracy tradeoff. `ULTRON_VOICE_STT_DEVICE=auto` uses a local CUDA GPU when the NVIDIA runtime is installed and falls back to CPU; `cpu` and `cuda` force a device. `ULTRON_VOICE_VAD_THRESHOLD` (0.2–0.9, default 0.45) and `ULTRON_VOICE_END_SILENCE_MS` (500–2000, default 1100) adjust turn detection. `ULTRON_VOICE_TTS_GAIN` (0.5–3.0, default 1.8) raises generated speech level without changing Windows volume or clipping peaks. Authentication continues to use `small` separately. Wake activation is rejected while Windows is locked and never starts speaker authentication. TTS playback and its post-playback window suppress/reset both wake and clap detection. The activation host retries a microphone that becomes unavailable after it was initially ready; an unavailable microphone at startup still fails readiness. Kokoro playback is chunked, but barge-in, live partial transcripts, and streaming model output are not implemented. Activation logs contain safe stage durations but no transcripts or microphone audio.

### Current limitations and privacy

The Drive resource reviewed for this work was JezFlow, a macOS dictation app, not a speech-output engine. Its PolyForm Noncommercial code was not copied into Ultron. The local microphone stream, temporary WAV, Whisper inference, and Kokoro synthesis stay on this PC; the WAV is deleted before the request reaches the core. If Gemini is enabled, only finalized conversational text goes to that provider under its terms. Ultron does not record raw audio or transcripts in diagnostic logs. The HUD currently shows coarse states, not live partial words. Real accent/noise/latency evaluation still requires recordings deliberately supplied by the speaker; a synthetic loopback is not evidence of real-world accuracy.

For an opt-in live microphone check, run `python -m voice.evaluate_stt --live` while the background host is stopped. It prompts you for six phrases, uses the same Silero capture and Whisper STT as conversation, and deletes each temporary WAV when the evaluation ends. Use `--device-id N` if Windows chose the wrong microphone. For a repeatable private corpus, record 16 kHz mono WAVs outside the repository named `how_are_you.wav`, `what_time.wav`, `open_dashboard.wav`, `explain.wav`, `adda_ai.wav`, and `hear_clearly.wav`, corresponding to the six phrases in `evaluate_stt.py`. Run `python -m voice.evaluate_stt C:\path\to\private-recordings`. Both modes print per-phrase and overall word error rate, not the transcripts unless `--show-transcripts` is explicitly requested. Test quiet/noisy rooms, pauses, and speaking speeds separately. The evaluator does not retain audio from live mode; supplied corpus files remain under your control.

### Live voice reliability checklist

Automated tests cannot verify the microphone, Bluetooth routing, or the face on this PC. Keep any recordings outside the repository and do not paste private transcripts into issue reports.

1. With Ultron stopped, list devices using `python voice/stage2_stt_check.py --list-devices` and `python voice/stage3_tts_check.py --list-devices`; note the PC microphone and intended speaker IDs.
2. Run `python -m voice.evaluate_stt --live` in a quiet room, then repeat with normal home noise. Record overall WER and any clipped or incorrect phrases. If the wrong mic is chosen, rerun with `--device-id N`.
3. Start Ultron with `scripts/start-ultron.ps1` (add `-MicrophoneDevice N -OutputDevice N` only if Windows defaults are wrong). Enable voice in the HUD. From another app, double-clap or say `Ultron, how are you?` and check that the HUD appears, the entire question is shown, and the full spoken reply is audible on the intended speaker.
4. Observe idle → listening → thinking → speaking → idle over ten turns. Listening should react to the microphone; speaking should turn the face blue; neither a failed turn nor switching voice off should leave the face stuck. The speaking event currently begins before the first playback chunk, so exact animation/audio synchronization remains to be verified and improved.
5. Ask ten follow-up questions without repeating the wake word, test a brief pause within a sentence, then test a disconnected speaker and a changed Windows output device. A failed output must be visible/diagnosable, not silently counted as a successful spoken reply.
6. With voice enabled, watch a movie or play normal room audio for two hours and record false activations. With voice off, confirm no clap or wake activation occurs. Stop Ultron using `scripts/stop-ultron.ps1` when finished.

The local activation log records stage durations as `ultron.voice.stage stage=... duration_ms=...` without transcript text. Capture, transcription, core, first audio, and total TTS timings should be compared across several turns; a single cold-start sample is not a performance baseline. Proposed first-milestone targets are overall WER at or below 10% on a varied 30–50-phrase private set, median speech-end to first audible audio at or below six seconds, at most one false activation in two hours of movie audio, and audible replies on the intended device for every completed test turn. These are targets, not verified results.

If wake-word VAD fails transiently, the host keeps clap detection alive and retries wake VAD after three seconds instead of leaving wake disabled until a process restart. The private error log records only the exception type and a recovery notice, never audio or recognized words. This does not fix a missing model, a disconnected microphone, slow model responses, or the deliberate period when the shared detector pauses during a conversational turn. Check the microphone and stage logs if the user still cannot wake Ultron.

When Voice is enabled, the activation host loads the local Kokoro model once in a background thread before the first conversational reply. Voice Off does not start this warm-up. The warm-up does not open the microphone or speaker; failures are recorded as an error type and normal speech can retry the load. Look for `stage=tts_warmup` in the private activation log after switching Voice On. This removes model loading from the first reply only when warm-up completes before that reply. It does not remove Gemini, transcription, device, or Bluetooth latency, and the first audible response still requires a live measurement.

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
- `local_conversation_audio.py`: lazy CPU Silero capture, CUDA-or-CPU faster-whisper, and CPU Kokoro Michael adapters
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

The clap classifier itself does not use speech-to-text. It evaluates impulse energy, crest factor, spectral flatness/high-band characteristics, timing, and cooldown. The personal launcher defaults to two qualifying claps to reduce incidental activation; `-ClapCount 1` opts into the faster, more sensitive mode. Two-clap mode uses an 800 ms window and 160 ms minimum gap. In the composed host, the same frames also feed local Silero endpointing and bounded Whisper wake recognition. The HUD's **ULTRON VOICE ON/OFF** switch pauses both detectors and closes the background microphone while off; text chat remains usable. Its setting is local, ignored by Git, and retained across restarts.

While TTS is active, and during a short post-playback suppression period, clap candidates are ignored so Ultron does not summon itself. Music, doors, speech, and keyboard noise still require real-room evaluation; automated tests cannot guarantee acoustic performance.

## Unlocked Windows activation

The intended path is:

```text
qualifying double clap (two by default)
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
.\scripts\start-ultron.ps1 -ClapCount 1
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
