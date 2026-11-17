# Changelog

Versions are `2.8.1-android.N`: the UHC release it runs, then this port's build number.

## 2.8.1-android.10

### Changed
- Tapping the middle of a panel opens it fitted to the screen (the whole panel, as large as it fits).
  Double-tap or **Original size** shows it at the website's pixel size. "Show big panels full size first"
  still opens at original size.

### Fixed
- Some panels (page 204, for one) showed at full width, cropped on both sides, instead of fitting the
  screen. When UHC reused a panel element between pages it cleared the fit, and the app wrongly thought
  it was still applied. It now checks.

## 2.8.1-android.9

### New
- **Swipe to turn pages:** swipe left for the next page, right for the previous one. It only counts a clearly
  sideways swipe, so scrolling never turns a page, and it never starts on a Flash animation or while pinch-zoomed.
- **Tap a panel to turn pages:** tap the left or right third of a panel to go back or forward. Taps on the
  story text do nothing, as in long-scroll comic readers.
- **Full-size panel viewer:** tap the middle of a panel to open it at its original size (the pixels the website
  showed). Pinch to zoom, drag to move, double-tap to switch between fit-to-screen and original size; Android
  back or ✕ closes it. Animated panels keep playing.
- **Show big panels full size first** (off by default): when a panel had to shrink a lot to fit the screen,
  such as the 950 px panels in later acts, it opens full size before you read the page.
- Each gesture has its own switch in Settings → Application Theme → Reading gestures. A one-time tip explains them.

### Fixed
- After an app update, the WebView could keep using a cached copy of the old phone layer. The app now
  loads each version fresh.

## 2.8.1-android.8

### Fixed
- **Music plays.** UHC's Music pages play songs through Bandcamp's embedded player, which needs the
  internet (the asset pack has album art and booklets, not the songs). The app may now reach Bandcamp
  (bandcamp.com and its media servers) and nothing else: every other site is refused inside the app.
- The Bandcamp player and track details fit the phone's width on track pages.

## 2.8.1-android.7

### Fixed
- **Readable chat colours in dark mode.** Pesterlog and dialogue colours were picked for MSPA's white page,
  so some were near-unreadable on black: John's blue, Equius's navy, Gamzee's purple, Aradia's maroon,
  Karkat's grey. On dark backgrounds, any coloured text below 4.5:1 contrast is now lightened, keeping its
  hue, so every character reaches at least 4.5:1 and similar colours stay distinguishable (John stays
  lighter than Equius). It works for every character, not a fixed list. Light mode keeps the original colours.
- The command link at the bottom of a story page now uses the same bold Courier as the story text and
  the reader bar. UHC sets it in Verdana, which phones don't have.

## 2.8.1-android.6

A professional audit and polish pass. The full report is in [docs/audit/report.md](docs/audit/report.md).

### Faster
- Cold start to the first story page is about a third faster (3.5 s → 2.3 s on the test emulator).
  The archive data now loads alongside the app instead of after it, repeated mod files are read once,
  and asset pack files are read in large blocks.

### Fixed
- The app could not start on Android 8 and 9.
- A malformed request header from a page could crash the app.
- Flash pages with their own layout ([S] GAME OVER, [S] Collide, [S] Act 7 and others) now fit the
  screen width instead of running off the side.
- The Search page, Settings buttons, News and Home no longer overflow the screen.
- Moving or deleting the asset pack while the app is in the background now returns to setup instead
  of showing broken pages.
- Reading progress is saved when you leave the app, so a page turn just before Android closes it isn't lost.
- The Dark theme's animated Home logo now plays.
- The reader bar keeps the Dark theme on pages that have their own colours.

### Changed
- **No more "All files access".** Setup is now one step: pick `UHC-Asset-Pack-V2.zip` in Android's file
  picker. The app keeps read access to that one file only and asks for no permissions at all. It reads
  the zip in place, as fast as before. Unpacked `Asset Pack V2` folders are no longer supported on the
  phone; use the single zip. Updating from an earlier version shows setup once, to pick the zip.

### New
- **Go to page:** tap the page counter ("253 / 8130") in the reader bar and type a page number.
  The Android back gesture closes the box; pages past your new-reader limit still show UHC's spoiler page.
- Settings → Application Theme: **Match the phone**, **Always light** or **Always dark**.
- The status and navigation bars take the colours of the current UHC theme.
- The screen stays on while a Flash or video page is open.
- Links inside Flash files to other Homestuck pages open in the app.
- Landscape: the reader bar becomes a single row; on wide screens the story column is centred.
- An adaptive launcher icon (with a themed version for Android 13+) and a launch splash, from UHC's icon.

### Polish
- Reader bar: 48 dp touch targets, larger labels, pressed states, screen-reader labels, and a guard
  against accidental double taps skipping a page.
- Setup screen: clearer steps, a "checking" state, and specific messages for a zip that is still copying.

### Security and hygiene
- The in-page Android bridge only allows setup actions on the setup page and only opens web and mail links.
- Plain-http traffic is limited to the app's own local server.
- Android back uses the predictive-back API on Android 13 and later.

### Engineering
- Unit tests: JVM tests for the asset pack reader and local server (folder, zip, zip64, truncated zip,
  ranges), and Node tests for the shim (path, settings store, file reads, URL rewriting, module loader).
- ESLint and Android lint. CI runs all tests and lint on every push and pull request.
- `tools/perf.mjs` measures cold start and page turns on a device.
