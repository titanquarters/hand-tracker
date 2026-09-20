# Hand Skeleton

A web app that turns your iPhone camera into a live hand tracker. Point it at a
hand and it draws a 21-point skeleton on top, following every finger in real
time. Up to two hands at once.

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
| Camera button | Switches between the front and rear camera |
| Node button | Cycles the skeleton style — neon, minimal, x-ray |
| Eye button | Dims the camera feed so only the skeleton shows |

The pill at the top-left shows how many hands are being tracked; the one at the
top-right shows the frame rate. Each hand is tagged **Left** or **Right**.

Fingers are colour-coded: thumb rose, index amber, middle green, ring cyan,
pinky violet.

## How it works

[MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
runs as WebAssembly with a WebGL backend and returns 21 landmarks per hand per
frame. `js/skeleton.js` draws those onto a `<canvas>` layered over the `<video>`.

Two details do most of the work of making the overlay actually line up:

- **Cover-crop mapping.** The video is displayed with `object-fit: cover`, so
  the browser crops it to fill the screen. Landmarks come back normalised to the
  *uncropped* frame, so `makeMapper()` reproduces that same crop. Skip this and
  the skeleton drifts off the hand whenever the camera and screen aspect ratios
  differ — which on a phone is always.
- **Mirroring.** The selfie camera is mirrored for display only, in the mapper.
  The pixels handed to the detector are always the raw, unmirrored frame, and
  MediaPipe reports anatomically correct handedness for that, so the Left/Right
  labels are used as-is.

The MediaPipe runtime (~12 MB of wasm) and model (~7.5 MB) load from a CDN on
first run and are then cached by the browser. `sw.js` caches the app shell so
subsequent launches are instant.

### Layout

```
index.html        markup and the start screen
css/style.css     full-screen layout, safe-area insets, HUD and controls
js/app.js         camera, model loading, the render loop, UI wiring
js/skeleton.js    landmark topology, cover-crop mapper, the three draw styles
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

It asserts that both hands are found with 21 landmarks each, that handedness is
correct, that the overlay is sized to the device pixel ratio and survives
rotation, that pixels are actually painted, and that nothing logs an error.
Screenshots of each style land in `.screenshots/`.

`?assets=local` makes the page load the runtime from `./vendor` instead of the
CDN; that is how the tests run offline.

Frame rates measured in the test container are not meaningful — it renders WebGL
in software. On a recent iPhone the GPU backend tracks at the camera's frame rate.
