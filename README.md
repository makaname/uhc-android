# UHC for Android

[The Unofficial Homestuck Collection](https://github.com/GiovanH/unofficial-homestuck-collection) 2.8.1, running on an Android phone. The official compiled bundle runs unchanged inside a WebView; a small shim stands in for Electron and Node, and a phone layer adds a reader bar and screen-fitted panels.

This repo has no Homestuck content. You need your own copy of the UHC asset pack (Asset Pack V2).

## Install on a phone

1. Get the APK from [Releases](../../releases), or build it (below).
2. Make the single-file asset pack on a PC: zip the *contents* of your `Asset Pack V2` folder, uncompressed, as `UHC-Asset-Pack-V2.zip`. With 7-Zip: `7z a -tzip -mx0 UHC-Asset-Pack-V2.zip .` from inside the folder. If you've run the desktop app before, use that folder, since it includes the unpacked built-in mods (`archive/imods`).
3. Copy the zip into the phone's `Download` folder (LocalSend, USB, anything). Don't unzip it.
4. Install the APK, open it, and turn on file access when asked. It finds the zip by itself. An unpacked `Asset Pack V2` folder works too.

## Build

```bash
node tools/fetch-uhc.mjs          # downloads + verifies the official 2.8.1 installer, unpacks the UI bundle into vendor/
./build-apk.sh                    # -> android/app/build/outputs/apk/debug/app-debug.apk
```

Needs Node 18+, 7-Zip (`7z`), JDK 17 and the Android SDK (platform 35, build-tools 35). On Windows these all install with Scoop: `7zip`, `java/temurin17-jdk`, `android-clt`.

## Try it on a PC

```bash
node tools/prepare-web.mjs
node tools/dev-server.mjs "<path to Asset Pack V2>"
```

Open http://127.0.0.1:8137/ in a browser window about 390px wide.

## How it fits together

| Path | What it is |
|---|---|
| `tools/fetch-uhc.mjs` | Recreates `vendor/uhc-2.8.1-app/` (not committed) from the official installer. |
| `shim/uhc-shim.js` | Fakes `electron`, `electron-store`, `fs`, `path` and more. Loads the archive JSON, runs the built-in mods, redirects `assets://` and old mspaintadventures.com URLs. |
| `shim/mobile.js`, `shim/mobile.css` | Phone layout: panels and Flash fit the screen width, the reader bar, light/dark following the phone. |
| `tools/prepare-web.mjs` | Builds `build/assets/web`. Copies the bundle, injects the shim, and makes three edits: the chunk path, CSS asset URLs, and dropping the 80 MB desktop-only imods archive. |
| `android/` | Java WebView app. `PackServer` serves the bundle from the APK and the pack (zip or folder, via `PackSource`) at `http://127.0.0.1:8137`. |
| `tools/cdp.mjs` | Runs JavaScript inside the app on a device/emulator, for testing. |
| `tools/extract-sources.cjs` | Recovers UHC's original source from the bundle's source maps, for reference. |

## License

GPL-3.0, like UHC itself. Homestuck and its assets belong to their owners.
