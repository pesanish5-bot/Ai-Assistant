# MediaPipe offline gesture assets

These files are vendored so Ultron's browser-local hand tracking does not
download executable WebAssembly or a camera-processing model at runtime.

- Runtime: `@mediapipe/tasks-vision` 0.10.35, Apache License 2.0
- Model: MediaPipe Hand Landmarker, float16, version 1
- Upstream model URL: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`
- Model SHA-256: `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`

The accompanying `LICENSE.txt` is the upstream MediaPipe Apache 2.0 license.
The WebAssembly file checksums are recorded below to make review reproducible:

```text
e7fd9858e8e8f221d9b96eddc11f8e077f263e0b7bbd79d3cbe882b134274f8c  vision_wasm_internal.js
6a5c64584c2ab61c763b6e204afbdbc7ce1caf7f5216187322bca8df94f646bc  vision_wasm_internal.wasm
1f1d6215324a1fe62f6742d49a3db911170987ca18ad8c1b75f1a1c82acf2b44  vision_wasm_module_internal.js
617b8e0248dbd27e9d7ece4218004eae4cefb499196d1bb4fa0e3fef21708756  vision_wasm_module_internal.wasm
438d1fe8ff7f4d946025bc211c291543c037d8a3785ed4eee60f1f521b236296  vision_wasm_nosimd_internal.js
8a3092d34c79d3f57e6ba8592105e8a90f6b07c27891ffecd14cca428bfd3e31  vision_wasm_nosimd_internal.wasm
```
