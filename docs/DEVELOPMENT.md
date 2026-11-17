# Development

How the Android port is put together, and how to build and test it.

## How it works

The official compiled UHC 2.8.1 bundle runs unchanged inside an Android WebView. A small shim stands in for
Electron and Node, and a phone layer adds the reader bar, screen-fitted panels and reading gestures. The app
serves the bundle from the APK and reads the asset pack straight out of its zip file, with no unpacking.

| Path | What it is |
|---|---|
| `tools/fetch-uhc.mjs` | Recreates `vendor/uhc-2.8.1-app/` (not committed) from the official installer, SHA-256 checked. |
| `shim/uhc-shim.js` | Fakes `electron`, `electron-store`, `fs`, `path` and more. Loads the archive JSON, runs the built-in mods, redirects `assets://` and old mspaintadventures.com URLs. |
| `shim/mobile.js`, `shim/mobile.css` | Phone layout: panels and Flash fit the screen width, the reader bar, reading gestures, light/dark, system-bar colours. |
| `tools/prepare-web.mjs` | Builds `build/assets/web`. Copies the bundle, injects the shim, and makes three edits: the chunk path, CSS asset URLs, and dropping the 80 MB desktop-only imods archive. |
| `android/` | Java WebView app. `PackServer` serves the bundle from the APK and the pack (via `PackSource`) at `http://127.0.0.1:8137`. |
| `tools/cdp.mjs`, `tools/gesture.mjs` | Run JavaScript and send real touch gestures inside the app on a device or emulator, for testing. |
| `tools/perf.mjs` | Measures cold start and page turns on a device or emulator. |
| `test/` | Node tests for the shim (run in a fake browser). Java tests are in `android/app/src/test/`. |
| `tools/extract-sources.cjs` | Recovers UHC's original source from the bundle's source maps, for reference. |

## Build

```bash
node tools/fetch-uhc.mjs          # downloads + verifies the official 2.8.1 installer, unpacks the UI bundle into vendor/
./build-apk.sh                    # -> android/app/build/outputs/apk/debug/app-debug.apk
```

Needs Node 18+, 7-Zip (`7z`), JDK 17 and the Android SDK (platform 35, build-tools 35). On Windows these all
install with Scoop: `7zip`, `java/temurin17-jdk`, `android-clt`.

## Test

```bash
npm ci && npm run lint && npm test                  # ESLint + shim unit tests (Node 18+)
cd android && ./gradlew testDebugUnitTest lintDebug # Java unit tests + Android lint
node tools/perf.mjs 5                               # cold start and page-turn timings on a device/emulator
```

CI runs these on every push and pull request.

## Try it on a PC

```bash
node tools/prepare-web.mjs
node tools/dev-server.mjs "<path to Asset Pack V2>"
```

Open http://127.0.0.1:8137/ in a browser window about 390px wide.

## Releases

Pushing a tag `v2.8.1-android.N` builds a signed APK and publishes it as a GitHub Release (versionCode N).
