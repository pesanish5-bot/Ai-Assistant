# AI Assistant

An interactive AI assistant interface built with **Next.js**, **Three.js**, and **MediaPipe** hand tracking. Use mouse, touch, keyboard, or webcam gestures to explore the holographic orb.

This repository contains the interface layer only. It does not include a conversational AI backend, microphone input, speech recognition, or text-to-speech.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Controls

### Mouse / touch

| Input | Action |
| --- | --- |
| Drag | Spin the orb |
| Scroll or pinch | Zoom in and out |

### Hand gestures (webcam)

Click **GESTURES OFF** (or press `G`) and allow camera access.

| Gesture | Action |
| --- | --- |
| Pinch one hand and move it | Spin the orb |
| Pinch both hands, then spread or bring them together | Zoom in or out |

### Keyboard

| Key | Action |
| --- | --- |
| `G` | Toggle hand gestures |
| `R` | Reset the view |
| `+` / `-` | Zoom in or out |

## Project structure

- `lib/orbScene.ts` — Three.js orb scene, controls, animation, and effects.
- `lib/handTracker.ts` — MediaPipe webcam hand tracking and gesture handling.
- `components/AssistantOrb.tsx` — Interface HUD and input integration.

## License

MIT. See [LICENSE](LICENSE) for the full license notice.
