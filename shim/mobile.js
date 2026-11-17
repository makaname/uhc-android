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
      var links = currentNextLinks(vm);
      if (links.length === 1) navigate(function () { links[0].click(); });
      else if (links.length > 1) {
        var nav = activeTabEl(vm).querySelector('.pageNavigation');
        if (nav) nav.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    bar.querySelector('.uhc-controls').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'back') {
        navigate(function () {
          var tab = activeTabEl(vm);
          var goBack = tab && tab.querySelector('.pageNavigation .goBack');
          if (goBack) goBack.click();
          else window.UHCShim.ipcRenderer.emit('TABS_HISTORY_BACK');
        });
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
    if (NATIVE.setChrome && tabFrame) {
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
      var vm = window.vm;
      if (!vm || !vm.$localData) return false;
      var td = vm.$localData.tabData, tab = td.tabs[td.activeTabKey];
      if (!tab || !tab.history || !tab.history.length) return false;
      window.UHCShim.ipcRenderer.emit('TABS_HISTORY_BACK');
      return true;
    },
    openInApp: openInApp
  };

  whenAppReady(function (vm) {
    var bar = buildBar(vm);
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
        startAutoplay(tab);
        addThemeChoice(vm, tab);
        updateBar(vm, bar);
      });
    }

    new MutationObserver(refresh).observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
    document.addEventListener('load', function (e) { if (e.target && e.target.tagName === 'IMG') refresh(); }, true);
    window.addEventListener('resize', refresh);
    vm.$watch(function () { return activeUrl(vm); }, refresh);
    vm.$watch(function () { return vm.$localData.settings.themeOverride; }, refresh);
    refresh();
    root.classList.add('uhc-ready');
  });
})();
