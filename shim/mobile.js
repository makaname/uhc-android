/*
 * mobile.js: phone behaviour layered on the unchanged UHC bundle.
 *  - Fits each panel/Flash to the screen width, keeping its shape (like the 650px column on the original site)
 *  - Reader bar: next command pinned at the bottom, plus Back / Home / Save / Settings and progress
 *  - Light/dark: follows the phone through UHC's own Dark theme, or a fixed choice from Settings
 *  - Android chrome: system-bar colours follow the theme; the screen stays on while a Flash shows
 */
(function () {
  'use strict';

  var PHONE_MAX = 760;
  var HOMESTUCK_PAGES = 8130;
  var NATIVE = window.UHCNative || null;
  var root = document.documentElement;

  function isPhone() { return Math.min(window.innerWidth, screen.width) <= PHONE_MAX || !!NATIVE; }
  function applyPhoneClass() { root.classList.toggle('uhc-phone', isPhone()); }
  // In the Android app the native shell already keeps the page clear of the system bars.
  if (NATIVE) root.classList.add('uhc-native');
  applyPhoneClass();

  function whenAppReady(cb) {
    (function check() {
      if (window.vm && window.vm.$root && window.vm.$root.archive && window.vm.$localData) cb(window.vm);
      else setTimeout(check, 50);
    })();
  }

  function activeTabEl(vm) {
    return document.getElementById(vm.$localData.tabData.activeTabKey);
  }
  function activeUrl(vm) {
    var td = vm.$localData.tabData;
    var tab = td.tabs[td.activeTabKey];
    return tab ? tab.url : '/';
  }
  function storage(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    } catch (e) { /* private mode */ }
    return null;
  }

  // ---------- fit media to screen width ----------

  function naturalWidth(media) {
    var w = 0;
    for (var i = 0; i < media.children.length; i++) {
      var c = media.children[i];
      var cw = c.offsetWidth;
      if (c.tagName === 'IMG' && c.naturalWidth) cw = Math.max(cw, c.naturalWidth);
      w = Math.max(w, cw, c.scrollWidth || 0);
    }
    return w;
  }
  // Remembers what each .media was fitted for, so unrelated DOM changes don't re-measure it
  // (re-measuring means clearing zoom, which forces a layout and can flicker).
  var fitted = new WeakMap();
  function mediaKey(m, avail) {
    // Vue reuses elements between pages (a 650px Flash iframe becomes a 950px one), so the key
    // includes each child's own width; offsetWidth is not affected by the zoom on .media.
    var key = String(avail);
    for (var c = 0; c < m.children.length; c++) {
      var el = m.children[c];
      key += ':' + el.tagName + el.offsetWidth + (el.tagName === 'IMG' ? (el.complete ? 'c' + el.naturalWidth : 'p') : '');
    }
    return key;
  }
  function fitMedia(scope) {
    if (!scope || !root.classList.contains('uhc-phone')) return;
    var list = scope.querySelectorAll('.pageBody .media');
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var avail = (m.parentElement || m).clientWidth;
      if (!avail) continue;
      var key = mediaKey(m, avail);
      if (fitted.get(m) === key) continue;
      m.style.zoom = '';
      var nat = naturalWidth(m);
      if (!nat) continue;
      var z = Math.min(1, avail / nat);
      if (z < 0.999) m.style.zoom = String(z);
      fitted.set(m, key);
    }
    // Some special pages ([S] GAME OVER and other Act 6 pages) put the Flash straight into
    // .mediaContent without a .media wrapper; zoom the embed itself.
    var bare = scope.querySelectorAll('.pageBody .mediaContent > iframe.mediaembed, .pageBody .mediaContent > video.mediaembed');
    for (var j = 0; j < bare.length; j++) {
      var e = bare[j];
      var room = e.parentElement.clientWidth, w = e.offsetWidth;
      if (!room || !w) continue;
      var k = room + ':' + w;
      if (fitted.get(e) === k) continue;
      var zz = Math.min(1, room / w);
      e.style.zoom = zz < 0.999 ? String(zz) : '';
      fitted.set(e, k);
    }
    // Fully custom pages ([S] Collide, [S] Act 7, ...) have their own fixed-width layout:
    // scale any block that is still wider than the screen as a whole.
    var bodies = scope.querySelectorAll('.pageBody');
    for (var b = 0; b < bodies.length; b++) {
      var body = bodies[b], room2 = body.clientWidth;
      if (!room2) continue;
      for (var c = 0; c < body.children.length; c++) {
        var blk = body.children[c];
        if (blk.classList.contains('pageFrame') || blk.id === 'uhcReaderBar') continue;
        var bw = Math.max(blk.offsetWidth, blk.scrollWidth);
        var bk = room2 + ':' + bw;
        if (fitted.get(blk) === bk) continue;
        var bz = bw > room2 + 2 ? room2 / bw : 1;
        blk.style.zoom = bz < 0.999 ? String(bz) : '';
        fitted.set(blk, bk);
      }
    }
  }

  // Autoplay videos (the Dark theme's Home logo, some pages) can be left paused by the WebView.
  // Start each one once; a video the reader paused afterwards stays paused.
  var autoplayed = new WeakSet();
  function startAutoplay(scope) {
    if (!scope) return;
    var vids = scope.querySelectorAll('video[autoplay]');
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      if (autoplayed.has(v) || !v.paused) continue;
      autoplayed.add(v);
      var p = v.play();
      if (p && p.catch) p.catch(function () { /* not allowed or no data yet */ });
    }
  }

  // ---------- reader bar ----------

  var ICONS = {
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7M6 9.5V20h12V9.5"/></svg>',
    save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>'
  };

  var lastNavAt = 0;
  function navigate(fn) {
    // A second tap while the next page is still coming in would skip a page.
    var now = Date.now();
    if (now - lastNavAt < 250) return;
    lastNavAt = now;
    fn();
  }

  /** Next page, as the reader bar's command: one next link is followed; several scroll to the choices. */
  function goNext(vm) {
    var links = currentNextLinks(vm);
    if (links.length === 1) { navigate(function () { links[0].click(); }); return true; }
    if (links.length > 1) {
      var nav = activeTabEl(vm).querySelector('.pageNavigation');
      if (nav) nav.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    }
    return false;
  }
  /** Previous page: the page's own "Go Back" link, else the reader's history. */
  function goBack(vm) {
    navigate(function () {
      var tab = activeTabEl(vm);
      var back = tab && tab.querySelector('.pageNavigation .goBack');
      if (back) back.click();
      else window.UHCShim.ipcRenderer.emit('TABS_HISTORY_BACK');
    });
    return true;
  }

  function buildBar(vm) {
    var bar = document.createElement('nav');
    bar.id = 'uhcReaderBar';
    bar.setAttribute('aria-label', 'Reader controls');
    bar.innerHTML =
      '<a class="uhc-next" href="#" hidden></a>' +
      '<div class="uhc-controls">' +
        '<button type="button" data-act="back" aria-label="Back">' + ICONS.back + '<span aria-hidden="true">Back</span></button>' +
        '<button type="button" data-act="home" aria-label="Home">' + ICONS.home + '<span aria-hidden="true">Home</span></button>' +
        '<button type="button" data-act="save" aria-label="Save or load your place">' + ICONS.save + '<span aria-hidden="true">Save</span></button>' +
        '<button type="button" data-act="settings" aria-label="Settings">' + ICONS.settings + '<span aria-hidden="true">Settings</span></button>' +
        '<button type="button" class="uhc-progress" data-act="jump" hidden>' +
          '<span class="uhc-progress-text"></span><span class="uhc-track"><span class="uhc-fill"></span></span></button>' +
      '</div>';
    document.body.appendChild(bar);

    bar.querySelector('.uhc-next').addEventListener('click', function (e) {
      e.preventDefault();
      goNext(vm);
    });
    bar.querySelector('.uhc-controls').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'back') {
        goBack(vm);
      } else if (act === 'home') {
        vm.$pushURL('/');
      } else if (act === 'save') {
        var b = document.querySelector('.bookmarksButton');
        if (b) b.click();
      } else if (act === 'settings') {
        vm.$pushURL('/settings');
      } else if (act === 'jump') {
        openJump(vm);
      }
    });
    return bar;
  }

  // ---------- go to page (tap the "253 / 8130" counter) ----------
  // Replaces the desktop jumpbox, which lives in the hidden header. Pages past the reader's
  // new-reader limit still land on UHC's own spoiler page.

  var jump = null;
  function buildJump(vm) {
    var d = document.createElement('dialog');
    d.id = 'uhcJump';
    d.setAttribute('aria-labelledby', 'uhcJumpTitle');
    d.innerHTML =
      '<form method="dialog" novalidate>' +
        '<label id="uhcJumpTitle" for="uhcJumpInput">Go to page</label>' +
        '<input id="uhcJumpInput" type="number" inputmode="numeric" min="1" max="' + HOMESTUCK_PAGES + '" ' +
          'enterkeyhint="go" autocomplete="off">' +
        '<p class="uhc-jump-hint" aria-live="polite"></p>' +
        '<div class="uhc-jump-actions">' +
          '<button type="button" value="cancel" class="uhc-jump-cancel">Cancel</button>' +
          '<button type="submit" value="go" class="uhc-jump-go">Go</button>' +
        '</div>' +
      '</form>';
    document.body.appendChild(d);
    var input = d.querySelector('input'), hint = d.querySelector('.uhc-jump-hint');
    function defaultHint() { hint.textContent = 'Homestuck page 1 to ' + HOMESTUCK_PAGES.toLocaleString(); hint.className = 'uhc-jump-hint'; }
    d.querySelector('.uhc-jump-cancel').addEventListener('click', function () { d.close(); });
    d.addEventListener('click', function (e) { if (e.target === d) d.close(); });   // tap outside the box
    d.querySelector('form').addEventListener('submit', function (e) {
      e.preventDefault();
      var n = Number(String(input.value).trim());
      if (!Number.isInteger(n) || n < 1 || n > HOMESTUCK_PAGES) {
        hint.textContent = 'Enter a page number from 1 to ' + HOMESTUCK_PAGES.toLocaleString() + '.';
        hint.className = 'uhc-jump-hint bad';
        input.focus();
        return;
      }
      d.close();
      navigate(function () { vm.$pushURL('/homestuck/' + n); });
    });
    d.addEventListener('close', defaultHint);
    defaultHint();
    return d;
  }
  function openJump(vm) {
    if (!jump) jump = buildJump(vm);
    var input = jump.querySelector('input');
    var m = /^\/homestuck\/(\d+)/.exec(activeUrl(vm));
    input.value = '';
    input.placeholder = m ? m[1] : '1';
    jump.showModal();
    input.focus();
  }

  function currentNextLinks(vm) {
    var tab = activeTabEl(vm);
    return tab ? Array.prototype.slice.call(tab.querySelectorAll('.pageNavigation .nextArrow a')) : [];
  }

  var shown = {};   // last values written to the bar, to skip no-op DOM writes
  function setOnce(key, value, apply) {
    if (shown[key] === value) return;
    shown[key] = value;
    apply(value);
  }

  function updateBar(vm, bar) {
    var links = currentNextLinks(vm);
    var next = bar.querySelector('.uhc-next');
    var label = links.length === 1 ? links[0].textContent.trim()
      : links.length > 1 ? 'Choose what happens next' : '';
    setOnce('next', label, function (v) {
      next.textContent = v;
      next.hidden = !v;
    });

    var m = /^\/homestuck\/(\d+)/.exec(activeUrl(vm));
    var prog = bar.querySelector('.uhc-progress');
    setOnce('page', m ? m[1] : '', function (v) {
      prog.hidden = !v;
      if (!v) return;
      var n = Number(v);
      prog.querySelector('.uhc-progress-text').textContent = n + ' / ' + HOMESTUCK_PAGES;
      prog.setAttribute('aria-label', 'Page ' + n + ' of ' + HOMESTUCK_PAGES + '. Go to a page');
      prog.querySelector('.uhc-fill').style.width = Math.min(100, (n / HOMESTUCK_PAGES) * 100).toFixed(2) + '%';
    });

    var tabFrame = activeTabEl(vm);
    // Pages with their own theme (Cascade, Act 6 pages) drop the "dark" class; the bar keeps the reader's theme.
    var dark = !!(tabFrame && /\bdark\b/.test(tabFrame.className)) || vm.$localData.settings.themeOverride === 'dark';
    setOnce('theme', dark ? 'dark' : 'light', function (v) { root.setAttribute('data-uhc-theme', v); });
    setOnce('barH', bar.offsetHeight, function (v) { root.style.setProperty('--uhc-bar-h', v + 'px'); });
    syncNative(tabFrame, bar);
  }

  // ---------- Android: system bars and keep-screen-on ----------

  function toHex(css) {
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(css || '');
    if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null;
    return '#' + [m[1], m[2], m[3]].map(function (x) { return ('0' + Number(x).toString(16)).slice(-2); }).join('');
  }
  function syncNative(tabFrame, bar) {
    if (!NATIVE) return;
    if (NATIVE.setChrome && viewerOpen()) {
      // The full-size viewer is black edge to edge, with the dark bar at the bottom.
      setOnce('chrome', '#000000#262626', function () { NATIVE.setChrome('#000000', '#262626'); });
    } else if (NATIVE.setChrome && tabFrame) {
      // Status bar: the theme's outer frame colour; navigation bar: the reader bar's colour.
      var top = toHex(getComputedStyle(tabFrame).backgroundColor) || toHex(getComputedStyle(document.body).backgroundColor);
      var bottom = toHex(getComputedStyle(bar).backgroundColor);
      if (top && bottom) setOnce('chrome', top + bottom, function () { NATIVE.setChrome(top, bottom); });
    }
    if (NATIVE.setKeepScreenOn) {
      var playing = !!(tabFrame && tabFrame.querySelector('.pageBody iframe.mediaembed, .pageBody video, ruffle-player, ruffle-embed, ruffle-object'));
      setOnce('awake', playing, function (v) { NATIVE.setKeepScreenOn(v); });
    }
  }

  // ---------- light/dark ----------
  // Uses UHC's own "Dark" theme. Mode (Settings): "auto" follows the phone, "light"/"dark" are fixed.
  // In auto mode it only touches the theme when the reader left it on the default, or we set it.

  var MODE_KEY = 'uhc-theme-mode', OURS_KEY = 'uhc-auto-dark';
  var settingTheme = false;
  function themeMode() {
    var m = storage(MODE_KEY);
    return m === 'light' || m === 'dark' ? m : 'auto';
  }

  function setTheme(vm, value) {
    var s = vm.$localData.settings;
    if (s.themeOverride === value) return;
    settingTheme = true;
    s.themeOverride = value;
    vm.$localData.VM.saveLocalStorage();
    vm.$nextTick(function () { settingTheme = false; });
  }

  function applyTheme(vm) {
    var s = vm.$localData.settings;
    var mode = themeMode();
    var mq = window.matchMedia && matchMedia('(prefers-color-scheme: dark)');
    if (mode === 'dark') {
      if (s.themeOverride === 'default') setTheme(vm, 'dark');
    } else if (mode === 'light') {
      if (s.themeOverride === 'dark') setTheme(vm, 'default');
      storage(OURS_KEY, null);
    } else if (mq && mq.matches && s.themeOverride === 'default') {
      setTheme(vm, 'dark');
      storage(OURS_KEY, '1');
    } else if (mq && !mq.matches && storage(OURS_KEY) === '1' && s.themeOverride === 'dark') {
      setTheme(vm, 'default');
      storage(OURS_KEY, null);
    }
  }

  function followTheme(vm) {
    applyTheme(vm);
    var mq = window.matchMedia && matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) mq.addEventListener('change', function () { applyTheme(vm); });
    // UHC's own "Dark Mode" switch (or any theme pick) is a manual choice: stop following the phone.
    vm.$watch(function () { return vm.$localData.settings.themeOverride; }, function (v) {
      if (settingTheme) return;
      storage(OURS_KEY, null);
      if (v === 'dark') storage(MODE_KEY, 'dark');
      else if (v === 'default') storage(MODE_KEY, 'light');
      syncThemeChoice();
    });
  }

  // The choice lives in UHC's own Settings page, in the Application Theme section, styled like its
  // neighbours (it copies their scoped-style attributes). It replaces the plain "Dark Mode" checkbox.
  var CHOICES = [
    ['auto', 'Match the phone', "Light or dark, following Android's dark theme setting."],
    ['light', 'Always light', 'The standard grey MSPA look.'],
    ['dark', 'Always dark', 'UHC\'s "Dark" page theme.']
  ];
  function syncThemeChoice() {
    var mode = themeMode();
    var inputs = document.querySelectorAll('input[name="uhcThemeMode"]');
    for (var i = 0; i < inputs.length; i++) inputs[i].checked = inputs[i].value === mode;
  }
  function addThemeChoice(vm, scope) {
    if (!scope) return;
    var dark = scope.querySelector('.settings.themes input[name="toggleDarkMode"]');
    if (!dark || scope.querySelector('.uhc-theme-choice')) return;
    var dt = dark.closest('dt'), dl = dt && dt.parentElement;
    if (!dl) return;
    var scopeAttrs = Array.prototype.filter.call(dt.attributes, function (a) { return /^data-v-/.test(a.name); })
      .map(function (a) { return a.name + '=""'; }).join(' ');
    var html = '<dt ' + scopeAttrs + ' class="uhc-theme-choice uhc-theme-title">Light and dark</dt>';
    CHOICES.forEach(function (c) {
      html += '<dt ' + scopeAttrs + ' class="uhc-theme-choice"><label ' + scopeAttrs + '><input ' + scopeAttrs +
        ' type="radio" name="uhcThemeMode" value="' + c[0] + '">' + c[1] + '</label></dt>' +
        '<dd ' + scopeAttrs + ' class="settingDesc uhc-theme-choice">' + c[2] + '</dd>';
    });
    dt.insertAdjacentHTML('beforebegin', html);
    // The old checkbox and its description
    dt.classList.add('uhc-replaced');
    if (dt.nextElementSibling && dt.nextElementSibling.tagName === 'LABEL') dt.nextElementSibling.classList.add('uhc-replaced');
    dl.addEventListener('change', function (e) {
      if (e.target.name !== 'uhcThemeMode') return;
      storage(MODE_KEY, e.target.value);
      storage(OURS_KEY, null);
      if (e.target.value === 'auto') {
        // Start from the default so "auto" can take over whatever was picked before.
        if (vm.$localData.settings.themeOverride === 'dark') setTheme(vm, 'default');
      }
      applyTheme(vm);
    });
    syncThemeChoice();
  }

  // ---------- links from Flash to other pages ----------

  function openInApp(url) {
    var vm = window.vm, R = window.Resources;
    try {
      var target = R && R.getResourceURL ? R.getResourceURL(url) : url;
      if (vm && typeof target === 'string' && target.charAt(0) === '/') { vm.$pushURL(target); return true; }
    } catch (e) { /* fall through */ }
    if (NATIVE && NATIVE.openExternal) NATIVE.openExternal(url);
    return false;
  }

  // ---------- wire up ----------

  // Android's back gesture: go back in the app's history; returns false when there's nowhere to go.
  window.UHCMobile = {
    back: function () {
      if (jump && jump.open) { jump.close(); return true; }   // back closes the go-to-page box first
      if (viewerOpen()) { closeViewer(); return true; }        // and the full-size viewer
      var vm = window.vm;
      if (!vm || !vm.$localData) return false;
      var td = vm.$localData.tabData, tab = td.tabs[td.activeTabKey];
      if (!tab || !tab.history || !tab.history.length) return false;
      window.UHCShim.ipcRenderer.emit('TABS_HISTORY_BACK');
      return true;
    },
    openInApp: openInApp
  };

  // ---------- reading gestures ----------
  // Conventions from comic and e-book readers (Kindle, Mihon, Komic):
  //  - swipe left = next page, swipe right = previous, with a direction lock so scrolling never turns a page;
  //  - tap zones only on the panel image, not the text (long-scrolling pages turn whole-screen zones off):
  //    left third = back, right third = next, middle = open the panel full size;
  //  - full-size viewer: opens at original size (the pixels the website showed), pinch to zoom, drag to pan,
  //    double-tap to switch fit/original, back or ✕ to close.
  // Each is a switch in UHC's Settings (Application Theme section); stored in localStorage.

  var GESTURE_KEY = 'uhc-gestures';
  var GESTURE_DEFAULTS = { swipe: true, tapTurn: true, tapZoom: true, bigFirst: false };
  function gestures() {
    var saved = {};
    try { saved = JSON.parse(storage(GESTURE_KEY) || '{}') || {}; } catch (e) { saved = {}; }
    var out = {};
    Object.keys(GESTURE_DEFAULTS).forEach(function (k) { out[k] = k in saved ? !!saved[k] : GESTURE_DEFAULTS[k]; });
    return out;
  }
  function setGesture(key, on) {
    var g = gestures();
    g[key] = !!on;
    storage(GESTURE_KEY, JSON.stringify(g));
  }

  function isStoryPage(vm) {
    var tab = activeTabEl(vm);
    return !!(tab && tab.querySelector('.pageNavigation'));
  }
  function pageZoomed() {
    return !!(window.visualViewport && window.visualViewport.scale > 1.01);
  }
  /** Things a gesture must never start on: Flash/video, form fields, the bar, dialogs, the viewer. */
  function gestureBlocked(target) {
    return !target || !target.closest ||
      !!target.closest('iframe, video, embed, object, ruffle-player, ruffle-object, ruffle-embed, input, textarea, select, ' +
        'button, dialog, #uhcReaderBar, #uhcViewer, .bookmarkWrapper, .uhc-gesture-skip');
  }

  // A short arrow at the screen edge confirms a swipe was understood.
  var swipeHint = null;
  function flashSwipeHint(dir) {
    if (!swipeHint) {
      swipeHint = document.createElement('div');
      swipeHint.id = 'uhcSwipeHint';
      swipeHint.setAttribute('aria-hidden', 'true');
      document.body.appendChild(swipeHint);
    }
    swipeHint.textContent = dir > 0 ? '›' : '‹';
    swipeHint.className = dir > 0 ? 'next' : 'back';
    void swipeHint.offsetWidth;   // restart the animation
    swipeHint.classList.add('show');
  }

  var suppressClickUntil = 0;
  function installSwipe(vm) {
    var start = null;   // {x, y, t, lock}
    document.addEventListener('touchstart', function (e) {
      start = null;
      if (!gestures().swipe || e.touches.length !== 1 || viewerOpen() || pageZoomed()) return;
      if (gestureBlocked(e.target) || !isStoryPage(vm)) return;
      var t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, t: Date.now(), lock: null };
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (!start) return;
      if (e.touches.length !== 1) { start = null; return; }   // a second finger means pinch, not swipe
      var t = e.touches[0], dx = t.clientX - start.x, dy = t.clientY - start.y;
      start.dx = dx;   // the end event doesn't reliably carry the final position; keep the last one
      start.dy = dy;
      if (!start.lock && (Math.abs(dx) > 12 || Math.abs(dy) > 12)) {
        start.lock = Math.abs(dx) > Math.abs(dy) * 1.5 ? 'x' : 'y';
      }
    }, { passive: true });
    document.addEventListener('touchend', function () {
      var s = start;
      start = null;
      if (!s || s.lock !== 'x') return;
      var dx = s.dx || 0, dy = s.dy || 0;
      var far = Math.abs(dx) > Math.max(64, window.innerWidth * 0.18);
      var quick = Date.now() - s.t < 900;
      if (!far || !quick || Math.abs(dy) > Math.abs(dx)) return;
      var sel = window.getSelection && String(window.getSelection());
      if (sel) return;   // the reader was selecting text
      suppressClickUntil = Date.now() + 400;
      if (dx < 0) { if (goNext(vm)) flashSwipeHint(1); } else { goBack(vm); flashSwipeHint(-1); }
    }, { passive: true });
    document.addEventListener('touchcancel', function () { start = null; }, { passive: true });
  }

  /** The panel image a tap landed on (a still/animated GIF or PNG, not Flash), or null. */
  function tappedPanel(target) {
    var img = target && target.closest && target.closest('.pageBody .media img, .pageBody .mediaContent > img');
    if (!img || img.closest('a')) return null;   // panels that are links keep their link
    return img;
  }
  function installPanelTaps(vm) {
    // Capture phase, so the decision is made before UHC's own handlers see the click.
    document.addEventListener('click', function (e) {
      // Swallow a real tap that lands right after a swipe, never our own programmatic clicks (goNext
      // follows the page's next link with link.click(), which isn't trusted).
      if (e.isTrusted && Date.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); return; }
      var img = tappedPanel(e.target);
      if (!img || viewerOpen() || pageZoomed()) return;
      var g = gestures();
      if (!g.tapTurn && !g.tapZoom) return;
      var r = img.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width;
      var zone = !g.tapTurn ? 'middle' : fx < 1 / 3 ? 'left' : fx > 2 / 3 ? 'right' : 'middle';
      if (zone === 'middle' && !g.tapZoom) return;
      e.preventDefault();
      e.stopPropagation();
      if (zone === 'left') { goBack(vm); flashSwipeHint(-1); }
      else if (zone === 'right') { if (goNext(vm)) flashSwipeHint(1); }
      else openViewer(img, 'original');
    }, true);
  }

  // ---------- full-size panel viewer ----------

  var viewer = null, vstate = null;
  var requestRefresh = function () {};   // set once the app is ready; updates bar colours etc.
  function viewerOpen() { return !!(viewer && viewer.classList.contains('open')); }

  function buildViewer() {
    var v = document.createElement('div');
    v.id = 'uhcViewer';
    v.setAttribute('role', 'dialog');
    v.setAttribute('aria-modal', 'true');
    v.setAttribute('aria-label', 'Panel at full size');
    v.innerHTML =
      '<div class="uhc-v-stage"><img class="uhc-v-img" alt=""></div>' +
      '<div class="uhc-v-bar">' +
        '<button type="button" class="uhc-v-mode" aria-label="Switch between fit to screen and original size"></button>' +
        '<span class="uhc-v-tip">Pinch to zoom, drag to move, double-tap to switch</span>' +
        '<button type="button" class="uhc-v-close" aria-label="Close">✕</button>' +
      '</div>';
    document.body.appendChild(v);
    v.querySelector('.uhc-v-close').addEventListener('click', closeViewer);
    v.querySelector('.uhc-v-mode').addEventListener('click', function () {
      setMode(vstate.mode === 'fit' ? 'original' : 'fit');
    });
    installViewerGestures(v.querySelector('.uhc-v-stage'));
    window.addEventListener('resize', function () { if (viewerOpen()) setMode(vstate.mode); });
    return v;
  }

  function stageSize() {
    var st = viewer.querySelector('.uhc-v-stage');
    return { w: st.clientWidth, h: st.clientHeight };
  }
  function fitScale() {
    var s = stageSize();
    return Math.min(s.w / vstate.nw, s.h / vstate.nh);
  }
  /** Keeps the image on screen: centred when smaller than the stage, edges never pulled inside it. */
  function clampPan() {
    var s = stageSize(), w = vstate.nw * vstate.scale, h = vstate.nh * vstate.scale;
    vstate.x = w <= s.w ? (s.w - w) / 2 : Math.min(0, Math.max(s.w - w, vstate.x));
    vstate.y = h <= s.h ? (s.h - h) / 2 : Math.min(0, Math.max(s.h - h, vstate.y));
  }
  function render() {
    clampPan();
    var img = viewer.querySelector('.uhc-v-img');
    img.style.transform = 'translate(' + vstate.x + 'px,' + vstate.y + 'px) scale(' + vstate.scale + ')';
    // Pixel art stays crisp when enlarged; smooth when shrunk.
    img.style.imageRendering = vstate.scale > 1.01 ? 'pixelated' : 'auto';
    var btn = viewer.querySelector('.uhc-v-mode');
    btn.textContent = vstate.mode === 'fit' ? 'Original size' : 'Fit screen';
  }
  /** Zoom to {@code scale}, keeping the image point under (px, py) on the stage still. */
  function zoomAt(scale, px, py) {
    var min = Math.min(fitScale(), 1), max = Math.max(4, fitScale() * 2);
    scale = Math.max(min, Math.min(max, scale));
    var ix = (px - vstate.x) / vstate.scale, iy = (py - vstate.y) / vstate.scale;
    vstate.scale = scale;
    vstate.x = px - ix * scale;
    vstate.y = py - iy * scale;
    render();
  }
  function setMode(mode, px, py) {
    vstate.mode = mode;
    if (px === undefined) {
      // Original size starts at the top-left corner (where the panel begins); fit is centred.
      vstate.scale = mode === 'fit' ? fitScale() : 1;
      vstate.x = 0;
      vstate.y = 0;
      render();
    } else {
      zoomAt(mode === 'fit' ? fitScale() : 1, px, py);
    }
  }

  function openViewer(img, mode) {
    if (!viewer) viewer = buildViewer();
    var vimg = viewer.querySelector('.uhc-v-img');
    vimg.src = img.currentSrc || img.src;   // same URL: animated GIFs keep playing
    vimg.alt = img.alt || '';
    vstate = { nw: img.naturalWidth || img.width, nh: img.naturalHeight || img.height, scale: 1, x: 0, y: 0, mode: mode };
    vimg.style.width = vstate.nw + 'px';
    vimg.style.height = vstate.nh + 'px';
    viewer.classList.add('open');
    document.documentElement.classList.add('uhc-viewer-open');
    setMode(mode);
    viewer.querySelector('.uhc-v-close').focus({ preventScroll: true });
    requestRefresh();
  }
  function closeViewer() {
    if (!viewerOpen()) return;
    viewer.classList.remove('open');
    document.documentElement.classList.remove('uhc-viewer-open');
    viewer.querySelector('.uhc-v-img').removeAttribute('src');
    requestRefresh();
  }

  function installViewerGestures(stage) {
    var pts = new Map(), pinch = null, pan = null, lastTap = null;
    stage.addEventListener('pointerdown', function (e) {
      stage.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      var r = stage.getBoundingClientRect();
      if (pts.size === 2) {
        var a = Array.from(pts.values());
        pinch = { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y), scale: vstate.scale,
                  cx: (a[0].x + a[1].x) / 2 - r.left, cy: (a[0].y + a[1].y) / 2 - r.top };
        pan = null;
      } else if (pts.size === 1) {
        pan = { x: e.clientX, y: e.clientY, ox: vstate.x, oy: vstate.y, moved: false };
      }
    });
    stage.addEventListener('pointermove', function (e) {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size === 2) {
        var a = Array.from(pts.values());
        var d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        zoomAt(pinch.scale * d / pinch.d, pinch.cx, pinch.cy);
        vstate.mode = Math.abs(vstate.scale - 1) < 0.02 ? 'original' : Math.abs(vstate.scale - fitScale()) < 0.02 ? 'fit' : 'free';
        render();
      } else if (pan) {
        var dx = e.clientX - pan.x, dy = e.clientY - pan.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) pan.moved = true;
        vstate.x = pan.ox + dx;
        vstate.y = pan.oy + dy;
        render();
      }
    });
    function end(e) {
      if (!pts.has(e.pointerId)) return;
      var wasPan = pan && !pan.moved && pts.size === 1;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) pan = null;
      if (!wasPan || e.type === 'pointercancel') return;
      // A tap: two quick taps close together switch between fit and original at that point.
      var now = Date.now(), r = stage.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      if (lastTap && now - lastTap.t < 320 && Math.hypot(px - lastTap.x, py - lastTap.y) < 40) {
        setMode(vstate.mode === 'original' ? 'fit' : 'original', px, py);
        lastTap = null;
      } else {
        lastTap = { t: now, x: px, y: py };
      }
    }
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
  }

  // ---------- big panels full size first (optional) ----------
  // When a page's panel had to shrink a lot to fit the phone (wide Act 5-6 panels), open it at
  // original size first; closing the viewer shows the page as usual. Once per page visit.

  var autoOpenedFor = null;
  function maybeOpenBigFirst(vm, tab) {
    if (!tab || !gestures().bigFirst || viewerOpen()) return;
    var url = activeUrl(vm);
    if (autoOpenedFor === url) return;
    var img = tab.querySelector('.pageBody .media img');
    if (!img || !img.complete || !img.naturalWidth) return;
    var room = (img.closest('.media').parentElement || img).clientWidth;
    if (!room) return;
    autoOpenedFor = url;
    if (img.naturalWidth > room / 0.75) openViewer(img, 'original');
  }

  // A one-time tip on the first story page.
  function maybeShowGestureTip(vm) {
    if (storage('uhc-gesture-tip') || !isStoryPage(vm)) return;
    var g = gestures();
    if (!g.swipe && !g.tapTurn && !g.tapZoom) return;
    storage('uhc-gesture-tip', '1');
    var tip = document.createElement('div');
    tip.id = 'uhcGestureTip';
    tip.setAttribute('role', 'status');
    tip.textContent = 'Tip: swipe, or tap the sides of a panel, to turn pages. Tap the middle of a panel to see it full size.';
    tip.addEventListener('click', function () { tip.remove(); });
    document.body.appendChild(tip);
    setTimeout(function () { tip.classList.add('gone'); setTimeout(function () { tip.remove(); }, 400); }, 6500);
  }

  // ---------- gesture switches in UHC's Settings page ----------

  var GESTURE_CHOICES = [
    ['swipe', 'Swipe to turn pages', 'Swipe left for the next page, right for the previous one.'],
    ['tapTurn', 'Tap panel sides to turn pages', 'Tap the left or right third of a panel to go back or forward.'],
    ['tapZoom', 'Tap a panel to see it full size', 'Tap the middle of a panel to open it at its original size; pinch to zoom, drag to move.'],
    ['bigFirst', 'Show big panels full size first', 'When a panel had to shrink a lot to fit your screen, open it at original size before you read the page.']
  ];
  function addGestureChoices(scope) {
    if (!scope) return;
    var anchor = scope.querySelector('.settings.themes .uhc-theme-choice');
    if (!anchor || scope.querySelector('.uhc-gesture-choice')) return;
    var scopeAttrs = Array.prototype.filter.call(anchor.attributes, function (a) { return /^data-v-/.test(a.name); })
      .map(function (a) { return a.name + '=""'; }).join(' ');
    var g = gestures();
    var html = '<dt ' + scopeAttrs + ' class="uhc-gesture-choice uhc-theme-title">Reading gestures</dt>';
    GESTURE_CHOICES.forEach(function (c) {
      html += '<dt ' + scopeAttrs + ' class="uhc-gesture-choice"><label ' + scopeAttrs + '><input ' + scopeAttrs +
        ' type="checkbox" name="uhcGesture" value="' + c[0] + '"' + (g[c[0]] ? ' checked' : '') + '>' + c[1] + '</label></dt>' +
        '<dd ' + scopeAttrs + ' class="settingDesc uhc-gesture-choice">' + c[2] + '</dd>';
    });
    // After the last light/dark choice
    var choices = scope.querySelectorAll('.settings.themes .uhc-theme-choice');
    choices[choices.length - 1].insertAdjacentHTML('afterend', html);
    anchor.parentElement.addEventListener('change', function (e) {
      if (e.target.name === 'uhcGesture') setGesture(e.target.value, e.target.checked);
    });
  }

  // ---------- readable chat colours on dark backgrounds ----------
  // Pesterlog and dialogue colours were picked for MSPA's white page; on UHC's Dark theme (or any dark
  // page) some are near-unreadable: John #0715cd, Equius #000056, Gamzee #2b0057, Aradia, Karkat's grey.
  // Any coloured text with too little contrast on a dark background is lightened, keeping its hue and
  // saturation, just until it reaches WCAG AA (4.5:1). Light backgrounds keep the original colours.

  var MIN_CONTRAST = 4.5;
  var adjustedCache = {};

  function parseRgb(s) {
    var m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(s || '');
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  }
  function luminance(c) {
    function ch(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }
  function contrast(l1, l2) { return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
  function toHsl(c) {
    var r = c.r / 255, g = c.g / 255, b = c.b / 255, max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2, d = max - min;
    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    return { h: h, s: s, l: l };
  }
  function fromHsl(h, s, l) {
    function f(p, q, t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    }
    if (!s) { var v = Math.round(l * 255); return { r: v, g: v, b: v }; }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return { r: Math.round(f(p, q, h + 1 / 3) * 255), g: Math.round(f(p, q, h) * 255), b: Math.round(f(p, q, h - 1 / 3) * 255) };
  }
  /** The lightened colour, or null if the original is already readable on this background. */
  function readableOn(fg, bgLum) {
    var key = fg.r + ',' + fg.g + ',' + fg.b + '|' + bgLum.toFixed(3);
    if (key in adjustedCache) return adjustedCache[key];
    var out = null;
    if (contrast(luminance(fg), bgLum) < MIN_CONTRAST) {
      var hsl = toHsl(fg), l = hsl.l;
      while (l < 0.97 && contrast(luminance(fromHsl(hsl.h, hsl.s, l)), bgLum) < MIN_CONTRAST) l += 0.01;
      // Keep the cast's relative shades: an originally lighter colour stays a bit lighter than a darker
      // one of the same hue (John #0715cd vs Equius #000056 would otherwise land on the same blue).
      var c = fromHsl(hsl.h, hsl.s, Math.min(0.97, l + 0.3 * hsl.l));
      out = 'rgb(' + c.r + ', ' + c.g + ', ' + c.b + ')';
    }
    adjustedCache[key] = out;
    return out;
  }
  function backgroundOf(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
      var c = parseRgb(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  function fixChatColors(tab) {
    if (!tab) return;
    var els = tab.querySelectorAll('.pageBody [style*="color"], .pageBody font[color]');
    var bgCache = new Map();
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest('svg, .media')) continue;   // leave artwork and Flash alone
      // Remember the author's colour the first time we see the element.
      if (!el.hasAttribute('data-uhc-color')) {
        var authored = el.style.color || el.getAttribute('color') || '';
        if (!authored) continue;
        el.setAttribute('data-uhc-color', authored);
      }
      var parent = el.parentElement;
      var bg = bgCache.get(parent);
      if (!bg) { bg = backgroundOf(parent); bgCache.set(parent, bg); }
      var bgKey = bg.r + ',' + bg.g + ',' + bg.b;
      if (el.getAttribute('data-uhc-bg') === bgKey) continue;   // already handled for this background
      el.setAttribute('data-uhc-bg', bgKey);

      var original = el.getAttribute('data-uhc-color');
      el.style.color = original;   // measure (and restore, on light pages) the authored colour
      var bgLum = luminance(bg);
      if (bgLum > 0.2) continue;   // light background: keep MSPA's colours as they were
      // (Near-black colours like Equius's #000056 were written for a white page, so they get lightened
      // too; MSPA's hidden messages were light-on-light, which a dark background already reveals.)
      var fg = parseRgb(getComputedStyle(el).color);
      if (!fg) continue;
      var better = readableOn(fg, bgLum);
      if (better) el.style.color = better;
    }
  }

  whenAppReady(function (vm) {
    var bar = buildBar(vm);
    installSwipe(vm);
    installPanelTaps(vm);
    followTheme(vm);

    var pending = false;
    function refresh() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        applyPhoneClass();
        var tab = activeTabEl(vm);
        fitMedia(tab);
        fixChatColors(tab);
        startAutoplay(tab);
        addThemeChoice(vm, tab);
        addGestureChoices(tab);
        maybeOpenBigFirst(vm, tab);
        maybeShowGestureTip(vm);
        updateBar(vm, bar);
      });
    }

    new MutationObserver(refresh).observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
    document.addEventListener('load', function (e) { if (e.target && e.target.tagName === 'IMG') refresh(); }, true);
    window.addEventListener('resize', refresh);
    vm.$watch(function () { return activeUrl(vm); }, function () { closeViewer(); refresh(); });
    requestRefresh = refresh;
    vm.$watch(function () { return vm.$localData.settings.themeOverride; }, refresh);
    refresh();
    root.classList.add('uhc-ready');
  });
})();
