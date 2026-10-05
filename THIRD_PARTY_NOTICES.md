# Third-party notices

Víbora Padel is MIT-licensed (see `LICENSE`). It ships the following third-party files unmodified
(the athletes, HDR panoramas and normal maps are re-encoded from CC0 sources, see below).
Everything else (court, hall, rackets, ball, textures, sounds, UI) is generated procedurally by this
project's own code; the humanoids are baked from MakeHuman CC0 assets, see below.

| Component | Files | License | Copyright / source |
|---|---|---|---|
| three.js r186 | `vendor/three/three.module.js`, `vendor/three/three.core.js`, `vendor/three/addons/**` | MIT — full text in `vendor/three/LICENSE` | © 2010–2026 three.js authors · https://threejs.org |
| MediaPipe Tasks Vision (Pose Landmarker) | `vendor/mediapipe/vision_bundle.mjs`, `vendor/mediapipe/wasm/*` | Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0 | © Google LLC · https://github.com/google-ai-edge/mediapipe (upstream readme: `vendor/mediapipe/README.upstream.md`) |
| MediaPipe pose landmarker models (lite / full / heavy) | `models/pose_landmarker_*.task` | Apache License 2.0 (model card: https://developers.google.com/mediapipe/solutions/vision/pose_landmarker) | © Google LLC |
| WebXR Input Profiles — generic hand models | `assets/hands/left.glb`, `assets/hands/right.glb` | MIT — full text in `assets/hands/LICENSE.md` | © 2019 Amazon · https://github.com/immersive-web/webxr-input-profiles |
| Big Shoulders Display (800, 900) | `fonts/big-shoulders-display-*.woff2` | SIL Open Font License 1.1 — full text in `fonts/LICENSE-big-shoulders.txt` | The Big Shoulders Project Authors |
| Barlow Semi Condensed (400, 600, 700) | `fonts/barlow-semi-condensed-*.woff2` | SIL Open Font License 1.1 — full text in `fonts/LICENSE-barlow.txt` | © 2017 The Barlow Project Authors |
| fflate 0.8.2 (bundled with three.js as `addons/libs/fflate.module.js`, used by EXRLoader) | `vendor/three/addons/libs/fflate.module.js` | MIT | © Arjun Barrett · https://github.com/101arrowz/fflate |
| MakeHuman 1.1 assets (base mesh hm08, macro targets, default skeleton + weights, eye / eyebrow / eyelash / hair proxies and skin / hair textures; via github.com/makehumancommunity/makehuman and npm makehuman-data@0.0.2), baked into the athletes | `assets/people/athletes.glb`, `assets/people/skin.webp`, `assets/people/hair.webp` | CC0 1.0 (MakeHuman LICENSE.md §C; full text LICENSE.ASSETS.md) — details in `assets/people/LICENSE.md` | MakeHuman Team · https://github.com/makehumancommunity/makehuman |
| @pmndrs/assets 1.7.0 normal maps 0021 / 0014 (emmelleppi/normal-maps) | `assets/people/pores.webp`, `assets/people/wrinkles.webp` | CC0 1.0 | Poimandres · https://github.com/pmndrs/assets |
| Poly Haven HDR panoramas (via @pmndrs/assets 1.7.0) | `assets/env/warehouse.exr`, `assets/env/sunset.exr`, `assets/env/esplanade.exr` | CC0 1.0 — details in `assets/env/LICENSE.md` | Poly Haven · https://polyhaven.com · distributed by https://github.com/pmndrs/assets |
| Tileable detail normal maps (via @pmndrs/assets 1.7.0) | `assets/tex/orange-peel-normal.webp`, `assets/tex/grit-normal.webp`, `assets/tex/grain-normal.webp` | CC0 1.0 — details in `assets/tex/LICENSE.md` | https://github.com/pmndrs/assets (previews: https://github.com/emmelleppi/normal-maps) |

Protocol references for the experimental glasses mode (no code copied verbatim; the formats are
re-implemented in `src/xr/protocol.js`):

- (a) viture-webxr-extension `viture-hid.js` (MIT; built for watchroom.moe; protocol research after
  wheaney/XRLinuxDriver and jakedowns/xreal-webxr): the legacy MCU/IMU packet layout, CRC-16-CCITT and
  the IMU enable command 0x15.
- (b) elasticjava/viture-v2 `PROTOCOL.md` (MIT, © 2026 Holger Bartnick,
  https://github.com/elasticjava/viture-v2): the Gen2 frame format, 0x0301 IMU control and 0x7308 pose
  events.
- (c) AlexwellChen/beast-panorama hardware notes: Beast axes, Smooth Follow and 1200p60 observations
  (informational).

Notes

- The MakeHuman application code (AGPL) is not used or shipped; only its CC0 asset data is read by the
  offline bake (`tools/people/*`, MIT).
- The Apache-2.0 components are redistributed in their original, unmodified form. If you redistribute
  this project in another form, include a copy of the Apache License 2.0 alongside them.
- No telemetry and no third-party network calls at runtime: the pose model, WASM runtime, fonts, hand
  models, athletes and HDR panoramas are loaded from this site with relative URLs, and camera frames
  never leave the device.
  The MediaPipe bundle contains built-in usage logging (POSTs to `odml.pa.googleapis.com`); the app
  answers those requests locally without sending them (`src/app/privacy.js`). The vendored file itself
  is unmodified.
- "VÍBORA" and the racket graphics are this project's own designs; no real brand is depicted.
  "VITURE" is named only to say which glasses work with the experimental glasses mode; no VITURE
  logo or trade dress is used.
