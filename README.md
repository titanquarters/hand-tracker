# Hand Skeleton

A web app that turns your iPhone camera into a live hand tracker. Point it at a
hand and it draws a 21-point skeleton on top, following every finger in real
time. Up to two hands at once.

Pinch your thumb and index finger together to draw in the air, and turn on the
3D panel to see a rotating model of the hand's actual shape in space.

Everything runs on-device in the browser — no video is uploaded anywhere.

## Getting it onto your iPhone

Camera access requires an HTTPS origin, so the page has to be hosted. The
quickest route is GitHub Pages, which this repo is already set up for:

1. In this repo on GitHub, go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Push to `main` (or run the *Deploy to GitHub Pages* workflow by hand from the
   **Actions** tab). The workflow in `.github/workflows/pages.yml` does the rest.
4. Open the resulting `https://<user>.github.io/<repo>/` URL in **Safari** on
   your iPhone and tap **Start camera**, then **Allow**.

Add it to your Home Screen (Share → *Add to Home Screen*) and it launches
full-screen with no browser chrome, like a native app.

### Notes for iPhone

- Use **Safari**. On iOS every browser uses Safari's engine, but only Safari
  reliably gets camera permission from a Home Screen web app.
- `http://` will not work — iOS only exposes the camera on HTTPS (`localhost` is
  the one exception, which is what local development uses).
- If you denied the camera by accident: **Settings → Safari → Camera**, or tap
  the **ᴀA** button in the address bar → *Website Settings*.

## Using it

| Control | What it does |
| --- | --- |
| Camera | Switches between the front and rear camera |
| Pencil | Air drawing — pinch thumb to index to draw, open them to lift the pen |
| Eye | Dims the camera feed so only the skeleton shows |
| Gear | Settings: smoothing, 3D view, labels, skeleton style |

The pill at the top-left shows how many hands are being tracked; the one at the
top-right shows the frame rate. Each hand is tagged **Left** or **Right**.

Fingers are colour-coded: thumb rose, index amber, middle green, ring cyan,
pinky violet.

### Air drawing

Tap the pencil, then pinch. The pen tip sits between your thumb and index
fingertips, and a ring shows where it is — filled while you are drawing. Both
hands can draw at once. The palette, undo and clear appear above the controls.

Pinch is measured as the thumb-to-index distance divided by the length of your
palm, so it reads the same whether your hand is near the lens or far from it.
Strokes are stored in frame coordinates rather than screen pixels, so rotating
the phone re-maps them onto the same place in the scene instead of stretching
them.

### Settings

- **Smoothing** — on by default. Steadies the skeleton at rest without adding
  lag when the hand moves. The amount slider trades one against the other.
- **3D hand view** — a panel showing a rotating model of the hand. It rocks
  through a three-quarter view on its own; drag it to turn it yourself.
- **Left / right labels** — the tag under each wrist.
- **Skeleton style** — neon, minimal or x-ray.

Settings persist in `localStorage`.

## How it works

[MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
runs as WebAssembly with a WebGL backend and returns 21 landmarks per hand per
frame. `js/skeleton.js` draws those onto a `<canvas>` layered over the `<video>`.

Two sets of landmarks come back per frame, and the app uses both. The
**normalised** ones are relative to the picture and carry perspective — they say
where the hand *appears*, and drive the overlay. The **world** landmarks are in
metres, centred on the hand itself, and describe its actual shape in space,
which is what lets the 3D panel turn it around and look from another angle.

Two details do most of the work of making the overlay actually line up:

- **Cover-crop mapping.** The video is displayed with `object-fit: cover`, so
  the browser crops it to fill the screen. Landmarks come back normalised to the
  *uncropped* frame, so `makeMapper()` reproduces that same crop. Skip this and
  the skeleton drifts off the hand whenever the camera and screen aspect ratios
  differ — which on a phone is always.
- **Mirroring.** The selfie camera is mirrored for display only — in CSS for the
  preview and in the mapper for the overlay, together, off one predicate. Get
  one without the other and the skeleton is drawn as a mirror image of the hand.
  The pixels handed to the detector are always the raw, unmirrored frame, and
  MediaPipe reports anatomically correct handedness for that, so the Left/Right
  labels are used as-is.

Smoothing is a [One Euro filter](https://gery.casiez.net/1euro/) per landmark.
A plain low-pass would either leave the shimmer or smear fast motion into
visible lag; One Euro filters hard at rest and backs off as the hand speeds up.
Filter banks are keyed on handedness rather than array position, because
MediaPipe may reorder the hands between frames and a positional key would swap
two hands' histories.

The MediaPipe runtime (~12 MB of wasm) and model (~7.5 MB) load from a CDN on
first run and are then cached by the browser. `sw.js` caches the app shell so
subsequent launches are instant.

### Layout

```
index.html        markup, start screen, settings sheet
css/style.css     full-screen layout, safe-area insets, HUD, controls, sheet
js/app.js         camera, model loading, the render loop, UI wiring
js/skeleton.js    landmark topology, cover-crop mapper, the three draw styles
js/smoothing.js   One Euro filter, one bank per tracked hand
js/drawing.js     pinch detection and air-drawing strokes
js/hand3d.js      rotating 3D model from the metric world landmarks
sw.js             service worker, caches the app shell
```

## Development

```sh
npm install          # http-server + playwright
npm start            # serves on http://localhost:8080
```

`localhost` counts as a secure origin, so the camera works there without HTTPS.

### Tests

The suite drives the real app in Chromium, with `getUserMedia` stubbed to return
a canvas stream painting a photograph of real hands. The whole pipeline —
`<video>`, the detector, the mapper, the renderer — runs for real; only the
camera hardware is faked.

```sh
npm run setup:test   # downloads the MediaPipe runtime, model and fixtures to ./vendor (~42 MB, gitignored)
npm test
```

Three suites, all driving the real app:

- `test/e2e.mjs` — both hands found with 21 landmarks each, correct handedness,
  overlay sized to the device pixel ratio, tracking surviving rotation and a
  camera flip, pixels actually painted, no errors logged.
- `test/mirror.mjs` — the preview and the overlay agree about mirroring. The
  hand goes in one half of the fake sensor and the other half is filled with a
  solid colour; the skeleton must be painted in the opposite half from that
  colour, judged from a real screenshot so the CSS transform is genuinely
  accounted for. Centred fixtures hide a flip, because a mirror about the centre
  lands the skeleton almost on top of the hand — this one cannot.
- `test/features.mjs` — smoothing actually reduces jitter and resets across a
  lost hand, a scripted pinch produces exactly one stroke that follows the hand,
  a stationary pinch leaves nothing, the 3D model is the right way up, and
  settings survive a reload.

Screenshots land in `.screenshots/`.

`?assets=local` makes the page load the runtime from `./vendor` instead of the
CDN; that is how the tests run offline.

Frame rates measured in the test container are not meaningful — it renders WebGL
in software. On a recent iPhone the GPU backend tracks at the camera's frame rate.
