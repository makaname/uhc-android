# Brief: professional audit and polish pass

You are taking over a working Android port of The Unofficial Homestuck Collection (UHC) 2.8.1 for an audit and polish pass. The goal is to raise the code, UI and project to the standard of a well-run open-source Android app, without breaking what already works. The owner is not a programmer; they care about the app being **fast, themed exactly like UHC, and streamlined**.

Read `CLAUDE.md` and `README.md` first. They describe the architecture, commands, the test emulator and the owner's preferences, and they're binding.

## What exists (verified working on an Android 17 emulator and the owner's OnePlus 15)

- The official compiled UHC 2.8.1 bundle runs **unchanged** in a WebView. `shim/uhc-shim.js` fakes Electron/Node: IPC, electron-store, a read-only fs over HTTP, a CommonJS loader for the built-in "imods", and `assets://` redirection, including inside Ruffle's srcdoc iframe.
- `shim/mobile.js` and `shim/mobile.css` add the phone UI: a bottom "reader bar" with the next command pinned plus Back/Home/Save/Settings/progress, `.media` zoomed to the screen width keeping its shape, and light/dark following the phone through UHC's own "dark" theme.
- `android/` is a plain Java app with no AndroidX. `PackServer` answers WebView requests at `http://127.0.0.1:8137` (bundle from APK assets, `/pack/` from storage). `PackSource` reads the asset pack from a folder or, preferably, in place from `UHC-Asset-Pack-V2.zip`, a stored zip64 that is read through its central directory. `MainActivity` handles setup, all-files access, auto-finding the pack, the completeness check (18,880 files), `.nomedia`, back, and the system-bar insets.
- CI (`.github/workflows/build.yml`) builds every push. Tags `v2.8.1-android.N` publish a signed Release.

## Hard constraints

1. **Do not modify the compiled UHC bundle** beyond what `tools/prepare-web.mjs` already does, and do not switch to building UHC from source. Fix things in the shim, the phone layer or the Java side.
2. Keep the **reader-bar design** and the UHC/MSPA look: Courier story text, the grey frame, UHC's own themes. Polish it; don't replace it. **Do not put a theme toggle in the reader UI.** A manual light/dark choice belongs in Settings.
3. Panels and Flash must keep fitting the screen width with their shape preserved; text reflows.
4. Never commit the asset pack, the vendor bundle, build output, or anything from `~/.android/uhc-signing.*`.
5. Don't tag releases or push to `main`. Work on your branch and open **one PR**. The owner decides when to release.
6. Keep `minSdk 26`. The owner's phone is a OnePlus 15 on Android 17 (API 37); the test emulator `UHC_Android17` matches it.
7. Don't add heavy dependencies. AndroidX, Kotlin or a JS framework needs a clear win that you explain in the PR.

## What to audit, then improve

Work through these, highest impact first. For each finding, either fix it or explain in the PR why it's left.

**Correctness and robustness**
- `uhc-shim.js`: sync XHR use, error paths, the stubbed modules, `assets://` and mspaintadventures.com coverage (Electron's `webRequest` list in the original `background.js` is the reference; `tools/extract-sources.cjs` recovers the original UHC source from the bundle's source maps). Races between archive load, mods and `window.Resources`.
- Java: thread safety in `PackServer`/`PackSource`, stream and file-handle leaks, Range edge cases, 404/416 handling, behaviour while the zip is still being copied, behaviour after the pack is moved or deleted, process death and restore, rotation.
- Flash: the many Ruffle pages with unusual sizes (950px-wide panels, `[S] Collide`, `[S] Cascade`, Act 6/7 pages), fullscreen flashes, Flash links that open other pages, and audio. Sample them and report what breaks.
- Other UHC sections on a phone: the Log, Map, Search, Music, News, Extras, Settings, the jumpbox, new-reader spoiler mode, and pages with multiple next links. Anything unusable at 411px wide should get a phone-friendly treatment in `mobile.css`.

**Performance** (the owner asked for "fast")
- Measure cold start to the first story page, and page-to-page time on the emulator. Look at the 10 MB `mspa.json` parse, the sync XHRs at boot, the MutationObserver work in `mobile.js` (`fitMedia` on every mutation), image decoding and memory. Report numbers before and after.

**UI and UX polish, to a professional standard**
- The reader bar: touch targets (48dp), spacing, typography, pressed states, accessibility labels, contrast in both themes, landscape and tablet widths, foldables, gesture-nav insets, behaviour while a page loads (avoid flicker and a stale "next" label), and keyboard/TalkBack basics.
- The setup screen: wording, states, errors and progress (counting the files can take a moment).
- Smaller touches that make it feel native: a splash or loading state in UHC style instead of a blank WebView, keeping the screen on while a Flash plays if that's sensible, a correct app name and adaptive icon (built from the existing UHC icon), and status-bar colours that follow the active UHC theme.
- Add a **Settings entry** for the manual light/dark/auto choice. Prefer hooking UHC's existing Settings page (`themeOverride`); otherwise add a small native-styled section reachable from the reader bar's Settings.

**Security and hygiene**
- WebView settings, the `UHCNative` JS bridge (JavaScript inside the asset pack and its mods runs in the same page, so review what the bridge exposes), external link handling, cleartext on 127.0.0.1, and the `MANAGE_EXTERNAL_STORAGE` use: is there a narrower option that still reads the pack fast?

**Engineering**
- Tests: JVM unit tests for `PackSource` (folder, zip64, truncated zip, Range) and `PackServer` routing; node tests for the shim's `path`, the Store, `fixUrl` and the CommonJS loader. Wire them into CI.
- Linting/formatting for JS and Java, run in CI.
- Clean up leftovers, such as unused helpers in `PackServer`.
- Keep `README.md` and `CLAUDE.md` accurate. Add `CHANGELOG.md`.

## How to work

- Set up your worktree: `node tools/fetch-uhc.mjs "D:\Homestuck\The-Unofficial-Homestuck-Collection-2.8.1-win-x64.exe"` (the vendor bundle is gitignored), then `./build-apk.sh`.
- The unpacked pack for the browser harness is at `D:\Homestuck\Asset Pack V2 - The Unofficial Homestuck Collection\Asset Pack V2`. The single-file pack is `D:\Homestuck\uhc-android\dist\UHC-Asset-Pack-V2.zip`, and it's already in the emulator's `/sdcard/Download/`.
- Test on the emulator (`UHC_Android17`): `adb install -r`, `node tools/cdp.mjs "<js>"` to inspect the WebView, and `adb exec-out screencap -p` for screenshots. The browser harness (`tools/dev-server.mjs`) is good for fast CSS iteration. CLAUDE.md lists the Windows quirks: sandbox, `MSYS_NO_PATHCONV`, `JAVA_TOOL_OPTIONS`.
- Before opening the PR, run CLAUDE.md's full checklist on the emulator in both light and dark mode, and attach before/after screenshots for every visible change.
- Commit in small, reviewable steps with clear messages.

## Done means

One PR from your branch containing:
1. An **audit report** in the PR description: findings grouped by severity, what you fixed, what you deliberately left and why, and before/after performance numbers.
2. The fixes and polish, tested on the emulator, with screenshots.
3. Tests and lint running green in CI.
4. Updated docs and a `CHANGELOG.md` entry for the next version, `2.8.1-android.6`. Don't tag it.

If something needs the owner's decision (for example a visible design change beyond polish, or a new permission), don't guess: list it in the PR under "Decisions for the owner", with your recommendation.
