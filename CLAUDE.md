# UHC for Android

Android port of The Unofficial Homestuck Collection 2.8.1. The **compiled** UHC bundle runs unchanged in a WebView;
`shim/` fakes Electron/Node for it. Do not switch to building UHC from its GitHub source: the owner reports an
unknown bug there, while the compiled 2.8.1 release works.

## Layout

- `tools/fetch-uhc.mjs` puts the compiled bundle in `vendor/uhc-2.8.1-app/` (gitignored) from the official installer, SHA-256 checked.
- `shim/uhc-shim.js` is the Electron/Node stand-in: `require()`, IPC, electron-store (localStorage), read-only fs over HTTP, imod CommonJS loader, `assets://` redirection.
- `shim/mobile.js` and `shim/mobile.css` hold the phone UI: reader bar, media zoom-to-fit (including custom Flash pages), light/dark (follow the phone, or Settings → Application Theme; stored as `uhc-theme-mode` in localStorage), system-bar colours and keep-screen-on via the bridge.
- `tools/prepare-web.mjs` builds `build/assets/web` (copied into the APK). It edits only index.html, the webpack public path and CSS `assets://` URLs, and drops the desktop-only imods archive chunk.
- `android/` is a plain Java WebView app, with no AndroidX. `PackServer` serves `http://127.0.0.1:8137/` (bundle) and `/pack/` (asset pack); it is plain Java (`route()` returns a `Reply`) so JVM tests cover it, and `MainActivity.toWebResponse` adapts it. `PackSource` reads the pack in place from `UHC-Asset-Pack-V2.zip`, which the reader picks once in Android's file picker (a persisted read grant on that one file; the app has no storage permission). It reads through a shared `FileChannel` with positional reads; `PackSource.Folder` remains for tests and the PC harness only.
- The `UHCNative` bridge is visible to all page JS, including the pack's mods: setup calls only work on the setup page, `openExternal` only opens http(s)/mailto. Keep it that small. INTERNET is only for Bandcamp's embedded player (Music pages): `PackServer.isAllowedRemote` lets bandcamp.com and bcbits.com through and answers every other remote host with 403, and `shouldOverrideUrlLoading` blocks other iframe navigations. Keep that allowlist that small.
- Tests: `test/` (Node, shim in a fake browser) and `android/app/src/test/` (JVM: PackSource, PackServer).
- The asset pack is copyrighted and 4.4 GB. Never commit it. Phones get it as one zip file (stored is fastest).

## Commands

```bash
node tools/fetch-uhc.mjs [path/to/installer.exe]   # once per checkout
node tools/prepare-web.mjs && node tools/dev-server.mjs "<path to Asset Pack V2>"   # browser harness at 127.0.0.1:8137 (use ~390px width)
./build-apk.sh                                     # debug APK -> android/app/build/outputs/apk/debug/app-debug.apk
npm ci && npm run lint && npm test                 # ESLint + shim tests
(cd android && ./gradlew testDebugUnitTest lintDebug)   # Java tests + Android lint (CI runs all four)
node tools/perf.mjs 5                              # cold start / page turn medians on the emulator
node tools/cdp.mjs "<js>"                          # evaluate JS in the app's WebView on the emulator/device
node tools/gesture.mjs tap|doubletap|swipe|pinch ...  # real (trusted) touch gestures in the app (see the file)
```

On Windows: Java needs `JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=<path without spaces>` (build-apk.sh sets it). adb, the emulator and Gradle need the sandbox disabled because they use loopback sockets. In Git Bash, set `MSYS_NO_PATHCONV=1` for adb paths like `/sdcard`.

## Testing

- The emulator is AVD `UHC_Android17` (Android 17 / API 37, matching the owner's OnePlus 15). Install with `adb install -r`, push the pack zip to `/sdcard/Download/`, and check with `tools/cdp.mjs` plus `adb exec-out screencap -p`.
- Before handing over a build, check: setup (pick the zip; it must survive a restart), story page panel fit and the reader bar next/back, Android back gesture, a Flash page with audio (page 2153 "[S] YOU THERE. BOY."), go to page (tap the counter; back closes the box), reading gestures (`tools/gesture.mjs`: swipe left/right turns pages but a short or vertical swipe does not; panel left/right third turns pages; middle opens the viewer fitted to the screen; double-tap switches to original size; pinch, back closes it), a custom-layout Flash page (/mspa/008801 "[S] GAME OVER", /mspa/009987 "[S] Collide"), dark mode, and Save (bookmarks).
- The emulator's reader is in new-reader mode; Flash pages past the limit are spoiler-locked. Save `settings.newReader`, set it to `false` to test, then restore it.
- `perf.mjs`: the WebView writes localStorage to disk 1-2 s after a change; don't force-stop sooner when you expect state to survive.
- Record changes in `CHANGELOG.md`.
- Bump `versionCode`/`versionName` in `android/app/build.gradle` for every APK the owner installs.

## GitHub and releases

- Repo: https://github.com/makaname/uhc-android (public). CI (`.github/workflows/build.yml`) builds every push and PR.
- Release: bump nothing by hand; tag and push. `git tag v2.8.1-android.N && git push origin v2.8.1-android.N` publishes a Release with `UHC-Android-v2.8.1-android.N.apk` (versionCode N). N must keep increasing.
- Signing: one permanent key at `~/.android/uhc-signing.jks` and `~/.android/uhc-signing.properties` (never commit it). CI uses repo secrets `UHC_KEYSTORE_B64` and `UHC_KEYSTORE_PASSWORD`, which the owner sets. Without them CI falls back to the debug key, and those APKs won't install over signed ones.
- Work on a branch and open a PR for anything non-trivial; `main` should always build.

## Owner preferences

- Reader-bar design. Theme follows the phone; the manual light/dark switch belongs in Settings, not in the reader UI.
- Panels and Flash scale to screen width keeping their shape (like the 650px column on the original site); text reflows.
- Keep it fast, themed like UHC, and streamlined.
