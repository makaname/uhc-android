/*
 * mobile.js: phone behaviour layered on the unchanged UHC bundle.
 *  - Fits each panel/Flash to the screen width, keeping its shape (like the 650px column on the original site)
 *  - Reader bar: next command pinned at the bottom, plus Back / Home / Save / Settings and progress
 *  - Follows the phone's light/dark setting using UHC's own Dark theme (a Settings toggle comes later)
 */
(function () {
  'use strict';

  var PHONE_MAX = 760;
  var HOMESTUCK_PAGES = 8130;
  var root = document.documentElement;

  function isPhone() { return Math.min(window.innerWidth, screen.width) <= PHONE_MAX || !!window.UHCNative; }
  function applyPhoneClass() { root.classList.toggle('uhc-phone', isPhone()); }
  // In the Android app the native shell already keeps the page clear of the system bars.
  if (window.UHCNative) root.classList.add('uhc-native');
  applyPhoneClass();

  function whenAppReady(cb) {
    (function check() {
      if (window.vm && window.vm.$root && window.vm.$root.archive && window.vm.$localData) cb(window.vm);
      else setTimeout(check, 200);
    })();
  }

  function activeTabEl(vm) {
    var key = vm.$localData.tabData.activeTabKey;
    return document.getElementById(key);
  }
  function activeUrl(vm) {
    var td = vm.$localData.tabData;
    var tab = td.tabs[td.activeTabKey];
    return tab ? tab.url : '/';
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
  function fitMedia(scope) {
    if (!root.classList.contains('uhc-phone')) return;
    var list = (scope || document).querySelectorAll('.pageBody .media');
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      m.style.zoom = '';
      var avail = (m.parentElement || m).clientWidth;
      var nat = naturalWidth(m);
      if (!nat || !avail) continue;
      var z = Math.min(1, avail / nat);
      if (z < 0.999) m.style.zoom = String(z);
    }
  }

  // ---------- reader bar ----------

  var ICONS = {
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7M6 9.5V20h12V9.5"/></svg>',
    save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>'
  };

  function buildBar(vm) {
    var bar = document.createElement('nav');
    bar.id = 'uhcReaderBar';
    bar.setAttribute('aria-label', 'Reader');
    bar.innerHTML =
      '<a class="uhc-next" href="#" hidden></a>' +
      '<div class="uhc-controls">' +
        '<button type="button" data-act="back">' + ICONS.back + '<span>Back</span></button>' +
        '<button type="button" data-act="home">' + ICONS.home + '<span>Home</span></button>' +
        '<button type="button" data-act="save">' + ICONS.save + '<span>Save</span></button>' +
        '<button type="button" data-act="settings">' + ICONS.settings + '<span>Settings</span></button>' +
        '<div class="uhc-progress" hidden><span class="uhc-progress-text"></span><div class="uhc-track"><div class="uhc-fill"></div></div></div>' +
      '</div>';
    document.body.appendChild(bar);

    bar.querySelector('.uhc-next').addEventListener('click', function (e) {
      e.preventDefault();
      var links = currentNextLinks(vm);
      if (links.length === 1) links[0].click();
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
        var goBack = activeTabEl(vm) && activeTabEl(vm).querySelector('.pageNavigation .goBack');
        if (goBack) goBack.click();
        else window.UHCShim.ipcRenderer.emit('TABS_HISTORY_BACK');
      } else if (act === 'home') {
        vm.$pushURL('/');
      } else if (act === 'save') {
        var b = document.querySelector('.bookmarksButton');
        if (b) b.click();
      } else if (act === 'settings') {
        vm.$pushURL('/settings');
      }
    });
    return bar;
  }

  function currentNextLinks(vm) {
    var tab = activeTabEl(vm);
    return tab ? Array.prototype.slice.call(tab.querySelectorAll('.pageNavigation .nextArrow a')) : [];
  }

  function updateBar(vm, bar) {
    var links = currentNextLinks(vm);
    var next = bar.querySelector('.uhc-next');
    if (links.length === 1) {
      next.textContent = links[0].textContent.trim();
      next.hidden = false;
    } else if (links.length > 1) {
      next.textContent = 'Choose what happens next';
      next.hidden = false;
    } else {
      next.hidden = true;
    }

    var url = activeUrl(vm);
    var m = /^\/homestuck\/(\d+)/.exec(url);
    var prog = bar.querySelector('.uhc-progress');
    if (m) {
      var n = Number(m[1]);
      prog.querySelector('.uhc-progress-text').textContent = n + ' / ' + HOMESTUCK_PAGES;
      prog.querySelector('.uhc-fill').style.width = Math.min(100, (n / HOMESTUCK_PAGES) * 100).toFixed(2) + '%';
      prog.hidden = false;
    } else {
      prog.hidden = true;
    }

    var tabFrame = activeTabEl(vm);
    var dark = !!(tabFrame && /\bdark\b/.test(tabFrame.className));
    root.setAttribute('data-uhc-theme', dark ? 'dark' : 'light');
    root.style.setProperty('--uhc-bar-h', bar.offsetHeight + 'px');
  }

  // ---------- light/dark follows the phone ----------
  // Uses UHC's own "Dark" theme. Only changes the theme if the reader left it on Auto (or we set it).

  function followSystemTheme(vm) {
    var mq = window.matchMedia && matchMedia('(prefers-color-scheme: dark)');
    if (!mq) return;
    function apply() {
      var s = vm.$localData.settings;
      var ours = false;
      try { ours = localStorage.getItem('uhc-auto-dark') === '1'; } catch (e) {}
      if (mq.matches && s.themeOverride === 'default') {
        s.themeOverride = 'dark';
        try { localStorage.setItem('uhc-auto-dark', '1'); } catch (e) {}
        vm.$localData.VM.saveLocalStorage();
      } else if (!mq.matches && ours && s.themeOverride === 'dark') {
        s.themeOverride = 'default';
        try { localStorage.removeItem('uhc-auto-dark'); } catch (e) {}
        vm.$localData.VM.saveLocalStorage();
      }
    }
    apply();
    if (mq.addEventListener) mq.addEventListener('change', apply);
  }

  // ---------- wire up ----------

  // Android's back gesture: go back in the app's history; returns false when there's nowhere to go.
  window.UHCMobile = {
    back: function () {
      var vm = window.vm;
      if (!vm || !vm.$localData) return false;
      var td = vm.$localData.tabData, tab = td.tabs[td.activeTabKey];
      if (!tab || !tab.history || !tab.history.length) return false;
      window.UHCShim.ipcRenderer.emit('TABS_HISTORY_BACK');
      return true;
    }
  };

  whenAppReady(function (vm) {
    var bar = buildBar(vm);
    followSystemTheme(vm);

    var pending = false;
    function refresh() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        applyPhoneClass();
        fitMedia();
        updateBar(vm, bar);
      });
    }

    new MutationObserver(refresh).observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
    document.addEventListener('load', function (e) { if (e.target && e.target.tagName === 'IMG') refresh(); }, true);
    window.addEventListener('resize', refresh);
    vm.$watch(function () { return activeUrl(vm); }, refresh);
    refresh();
  });
})();
