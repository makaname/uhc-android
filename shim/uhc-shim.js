/*
 * uhc-shim.js: runs before the compiled UHC 2.8.1 bundle and stands in for Electron + Node.
 *
 * The bundle was built for Electron with nodeIntegration, so it calls a global `require()` for
 * electron, electron-store, fs, path and friends. This file provides those, backed by:
 *   - the asset pack, served at  <origin>/pack/   (dev-server.mjs on PC, the WebView on Android)
 *   - localStorage for settings (electron-store)
 *   - window.UHCNative, an optional Android bridge (open links, save files)
 *
 * Contract for whatever serves /pack/ (both servers implement it):
 *   GET  /pack/<path>          file bytes (Range supported)
 *   HEAD /pack/<path>          200 + header "X-UHC-Kind: file|dir", or 404
 *   GET  /pack/<dir>?list=1    JSON array of {name, dir:boolean}
 */
(function () {
  'use strict';

  var ORIGIN = location.origin;
  var PACK_URL = ORIGIN + '/pack/';
  var ASSET_DIR = '/pack';        // what the app thinks the asset folder's path is
  var USER_DATA = '/userdata';
  var NATIVE = window.UHCNative || null;

  // ---------- small helpers ----------

  var warned = {};
  function warnOnce(what) {
    if (warned[what]) return;
    warned[what] = true;
    console.warn('[uhc-shim] not available on Android:', what);
  }

  // A do-nothing object/function that tolerates any property access or call.
  function stub(name) {
    var fn = function () { warnOnce(name + '()'); return undefined; };
    return new Proxy(fn, {
      get: function (t, prop) {
        if (prop === 'then') return undefined;            // don't look like a Promise
        if (prop === Symbol.toPrimitive) return function () { return ''; };
        if (prop === '__esModule') return false;
        if (prop in t) return t[prop];
        return stub(name + '.' + String(prop));
      }
    });
  }

  function packUrlFor(p) {
    // Map a fake filesystem path (/pack/...) to its URL.
    p = String(p).replace(/\\/g, '/');
    if (p.indexOf(ASSET_DIR + '/') === 0) p = p.slice(ASSET_DIR.length + 1);
    else if (p === ASSET_DIR) p = '';
    else return null;
    return PACK_URL + p.split('/').map(encodeURIComponent).join('/');
  }

  function enoent(p) {
    var e = new Error("ENOENT: no such file or directory, '" + p + "'");
    e.code = 'ENOENT';
    return e;
  }

  // ---------- Buffer (just enough for checksums and electron-log) ----------

  var te = new TextEncoder(), td = new TextDecoder();
  class Buffer extends Uint8Array {
    static from(v, enc) {
      if (typeof v === 'string') {
        if (enc === 'base64') { var bin = atob(v), b = new Buffer(bin.length); for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
        var u = te.encode(v), out = new Buffer(u.length); out.set(u); return out;
      }
      if (v instanceof ArrayBuffer) return new Buffer(v);
      var r = new Buffer(v.length); r.set(v); return r;
    }
    static alloc(n, fill) { var b = new Buffer(n); if (fill) b.fill(fill); return b; }
    static allocUnsafe(n) { return new Buffer(n); }
    static isBuffer(b) { return b instanceof Buffer; }
    static byteLength(s) { return typeof s === 'string' ? te.encode(s).length : s.length; }
    static concat(list) {
      var n = list.reduce(function (a, b) { return a + b.length; }, 0), out = new Buffer(n), o = 0;
      list.forEach(function (b) { out.set(b, o); o += b.length; }); return out;
    }
    toString(enc) {
      if (enc === 'base64') { var s = ''; for (var i = 0; i < this.length; i++) s += String.fromCharCode(this[i]); return btoa(s); }
      if (enc === 'hex') return Array.prototype.map.call(this, function (x) { return x.toString(16).padStart(2, '0'); }).join('');
      return td.decode(this);
    }
  }
  window.Buffer = Buffer;

  // ---------- EventEmitter (used by ipcRenderer and the "events" module) ----------

  function EventEmitter() { this._ev = {}; }
  EventEmitter.prototype.on = EventEmitter.prototype.addListener = function (ch, fn) {
    (this._ev[ch] = this._ev[ch] || []).push(fn); return this;
  };
  EventEmitter.prototype.once = function (ch, fn) {
    var self = this;
    function w() { self.removeListener(ch, w); fn.apply(this, arguments); }
    w._orig = fn;
    return this.on(ch, w);
  };
  EventEmitter.prototype.removeListener = EventEmitter.prototype.off = function (ch, fn) {
    var l = this._ev[ch]; if (!l) return this;
    this._ev[ch] = l.filter(function (x) { return x !== fn && x._orig !== fn; });
    return this;
  };
  EventEmitter.prototype.removeAllListeners = function (ch) {
    if (ch === undefined) this._ev = {}; else delete this._ev[ch]; return this;
  };
  EventEmitter.prototype.emit = function (ch) {
    var args = Array.prototype.slice.call(arguments, 1);
    var l = (this._ev[ch] || []).slice();
    l.forEach(function (fn) { fn.apply(null, args); });
    return l.length > 0;
  };
  EventEmitter.prototype.listenerCount = function (ch) { return (this._ev[ch] || []).length; };
  EventEmitter.prototype.setMaxListeners = function () { return this; };
  EventEmitter.EventEmitter = EventEmitter;

  // ---------- path (posix) ----------

  function normalizeArray(parts, allowAboveRoot) {
    var res = [];
    parts.forEach(function (p) {
      if (!p || p === '.') return;
      if (p === '..') { if (res.length && res[res.length - 1] !== '..') res.pop(); else if (allowAboveRoot) res.push('..'); }
      else res.push(p);
    });
    return res;
  }
  var path = {
    sep: '/', delimiter: ':',
    normalize: function (p) {
      p = String(p).replace(/\\/g, '/');
      var abs = p.charAt(0) === '/', trail = p.slice(-1) === '/';
      var out = normalizeArray(p.split('/'), !abs).join('/');
      if (!out && !abs) out = '.';
      if (out && trail) out += '/';
      return (abs ? '/' : '') + out;
    },
    join: function () {
      var parts = Array.prototype.filter.call(arguments, function (a) { return a !== undefined && a !== null && a !== ''; });
      return parts.length ? path.normalize(parts.join('/')) : '.';
    },
    resolve: function () {
      var r = '';
      for (var i = arguments.length - 1; i >= 0 && r.charAt(0) !== '/'; i--) {
        var a = String(arguments[i] || '').replace(/\\/g, '/');
        if (a) r = a + (r ? '/' + r : '');
      }
      if (r.charAt(0) !== '/') r = '/' + r;
      var n = path.normalize(r);
      return n.length > 1 && n.slice(-1) === '/' ? n.slice(0, -1) : n;
    },
    isAbsolute: function (p) { return String(p).charAt(0) === '/'; },
    dirname: function (p) {
      p = String(p).replace(/\/+$/, '');
      var i = p.lastIndexOf('/');
      return i < 0 ? '.' : (i === 0 ? '/' : p.slice(0, i));
    },
    basename: function (p, ext) {
      var b = String(p).replace(/\/+$/, '').split('/').pop();
      if (ext && b.slice(-ext.length) === ext) b = b.slice(0, -ext.length);
      return b;
    },
    extname: function (p) {
      var b = path.basename(p), i = b.lastIndexOf('.');
      return i <= 0 ? '' : b.slice(i);
    },
    relative: function (from, to) {
      var f = path.resolve(from).split('/').filter(Boolean), t = path.resolve(to).split('/').filter(Boolean);
      var i = 0; while (i < f.length && i < t.length && f[i] === t[i]) i++;
      return f.slice(i).map(function () { return '..'; }).concat(t.slice(i)).join('/');
    },
    parse: function (p) {
      var base = path.basename(p), ext = path.extname(p);
      return { root: path.isAbsolute(p) ? '/' : '', dir: path.dirname(p), base: base, ext: ext, name: base.slice(0, base.length - ext.length) };
    },
    format: function (o) { return (o.dir ? o.dir + '/' : '') + (o.base || (o.name || '') + (o.ext || '')); },
    toNamespacedPath: function (p) { return p; }
  };
  path.posix = path;
  path.win32 = path;

  // ---------- fs (read-only view of the asset pack) ----------

  var statCache = {};
  function headSync(p) {
    if (p in statCache) return statCache[p];
    var url = packUrlFor(p);
    var kind = null;
    if (url) {
      try {
        var x = new XMLHttpRequest();
        x.open('HEAD', url, false);
        x.send();
        if (x.status >= 200 && x.status < 300) kind = x.getResponseHeader('X-UHC-Kind') || 'file';
      } catch (e) { kind = null; }
    }
    statCache[p] = kind;
    return kind;
  }
  function makeStat(kind, p) {
    if (!kind) throw enoent(p);
    return {
      isFile: function () { return kind === 'file'; },
      isDirectory: function () { return kind === 'dir'; },
      isSymbolicLink: function () { return false; },
      size: 0, mtime: new Date(0), mtimeMs: 0
    };
  }
  // The pack is read-only, so text files read more than once (mods re-read mod.js and the 1.6 MB
  // epilogues.yaml on every load) come from memory. Capped so a big file can't pin much RAM.
  var textCache = {}, textCacheBytes = 0, TEXT_CACHE_MAX = 8 * 1024 * 1024;
  function getSync(p, enc) {
    var url = packUrlFor(p);
    if (!url) throw enoent(p);
    var wantText = typeof enc === 'string' || (enc && enc.encoding);
    if (wantText && Object.prototype.hasOwnProperty.call(textCache, url)) return textCache[url];
    var x = new XMLHttpRequest();
    x.open('GET', url, false);
    // Sync XHR can't return an ArrayBuffer; this charset trick keeps each byte in the low 8 bits.
    if (!wantText) x.overrideMimeType('text/plain; charset=x-user-defined');
    x.send();
    if (x.status < 200 || x.status >= 300) throw enoent(p);
    if (wantText) {
      var t = x.responseText;
      if (textCacheBytes + t.length <= TEXT_CACHE_MAX) { textCache[url] = t; textCacheBytes += t.length; }
      return t;
    }
    var s = x.responseText, b = new Buffer(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  }
  function listSync(p) {
    var url = packUrlFor(p);
    if (!url) throw enoent(p);
    var x = new XMLHttpRequest();
    x.open('GET', url.replace(/\/?$/, '/') + '?list=1', false);
    x.send();
    if (x.status < 200 || x.status >= 300) throw enoent(p);
    return JSON.parse(x.responseText);
  }
  function dirent(e) {
    return { name: e.name, isDirectory: function () { return e.dir; }, isFile: function () { return !e.dir; }, isSymbolicLink: function () { return false; } };
  }
  function cbify(fn) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      var cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      var res, err = null;
      try { res = fn.apply(null, args); } catch (e) { err = e; }
      if (cb) setTimeout(function () { cb(err, res); }, 0);
    };
  }
  function promisify(fn) {
    return function () {
      var args = arguments;
      return new Promise(function (resolve, reject) {
        try { resolve(fn.apply(null, args)); } catch (e) { reject(e); }
      });
    };
  }

  var fs = {
    existsSync: function (p) { return !!headSync(p); },
    statSync: function (p) { return makeStat(headSync(p), p); },
    lstatSync: function (p) { return makeStat(headSync(p), p); },
    accessSync: function (p) { if (!headSync(p)) throw enoent(p); },
    readFileSync: function (p, opts) { return getSync(p, opts); },
    readdirSync: function (p, opts) {
      var list = listSync(p);
      return (opts && opts.withFileTypes) ? list.map(dirent) : list.map(function (e) { return e.name; });
    },
    opendirSync: function (p) {
      var list = listSync(p).map(dirent), i = 0;
      return {
        readSync: function () { return i < list.length ? list[i++] : null; },
        closeSync: function () {},
        close: function () { return Promise.resolve(); },
        read: function () { return Promise.resolve(i < list.length ? list[i++] : null); }
      };
    },
    // Writes are not supported (the pack is read-only on the phone); succeed quietly.
    mkdirSync: function () { warnOnce('fs.mkdirSync'); },
    writeFileSync: function () { warnOnce('fs.writeFileSync'); },
    appendFileSync: function () {},
    writeSync: function () {},
    openSync: function () { return 0; },
    closeSync: function () {},
    unlinkSync: function () { warnOnce('fs.unlinkSync'); },
    unlink: function (p, cb) { warnOnce('fs.unlink'); if (cb) setTimeout(cb, 0); },
    createReadStream: function () { warnOnce('fs.createReadStream'); return new EventEmitter(); },
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 }
  };
  fs.readFile = cbify(fs.readFileSync);
  fs.stat = cbify(fs.statSync);
  fs.lstat = cbify(fs.lstatSync);
  fs.readdir = cbify(fs.readdirSync);
  fs.exists = function (p, cb) { var r = fs.existsSync(p); if (cb) setTimeout(function () { cb(r); }, 0); };
  fs.promises = {
    readFile: promisify(fs.readFileSync),
    readdir: promisify(fs.readdirSync),
    stat: promisify(fs.statSync),
    lstat: promisify(fs.lstatSync),
    access: promisify(fs.accessSync),
    opendir: promisify(fs.opendirSync),
    mkdir: function () { return Promise.resolve(); },
    writeFile: function () { warnOnce('fs.promises.writeFile'); return Promise.resolve(); },
    unlink: function () { return Promise.resolve(); }
  };

  // ---------- electron-store (localStorage) ----------

  function getPath(obj, key) {
    var parts = String(key).split('.');
    for (var i = 0; i < parts.length; i++) {
      if (obj === null || typeof obj !== 'object' || !(parts[i] in obj)) return undefined;
      obj = obj[parts[i]];
    }
    return obj;
  }
  function setPath(obj, key, val) {
    var parts = String(key).split('.');
    for (var i = 0; i < parts.length - 1; i++) {
      if (obj[parts[i]] === null || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = val;
  }
  function delPath(obj, key) {
    var parts = String(key).split('.');
    for (var i = 0; i < parts.length - 1; i++) {
      obj = obj && obj[parts[i]];
      if (!obj || typeof obj !== 'object') return;
    }
    delete obj[parts[parts.length - 1]];
  }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  function Store(opts) {
    opts = opts || {};
    this._key = 'uhc-store:' + (opts.name || 'config');
    this.path = USER_DATA + '/' + (opts.name || 'config') + '.json';
    var data = this._read();
    if (opts.defaults) {
      Object.keys(opts.defaults).forEach(function (k) { if (!(k in data)) data[k] = clone(opts.defaults[k]); });
    }
    if (!opts.name || opts.name === 'config') {
      data.assetDir = ASSET_DIR;            // the pack always lives at /pack on the phone
    }
    this._write(data);
  }
  Store.prototype._read = function () {
    var d;
    try { d = JSON.parse(localStorage.getItem(this._key)) || {}; } catch (e) { d = {}; }
    if (this._key === 'uhc-store:config') {
      // There is no Flash plugin on Android: always play Flash through Ruffle.
      d.settings = d.settings || {};
      d.settings.ruffleFallback = true;
    }
    return d;
  };
  Store.prototype._write = function (d) {
    try { localStorage.setItem(this._key, JSON.stringify(d)); } catch (e) { console.error('[uhc-shim] could not save settings', e); }
  };
  Store.prototype.get = function (key, def) {
    if (key === undefined) return this._read();   // electron-store returns everything for get()
    var v = getPath(this._read(), key);
    return v === undefined ? def : v;
  };
  Store.prototype.set = function (key, val) {
    var d = this._read();
    if (key !== null && typeof key === 'object') Object.keys(key).forEach(function (k) { setPath(d, k, clone(key[k])); });
    else setPath(d, key, clone(val));
    this._write(d);
  };
  Store.prototype.has = function (key) { return getPath(this._read(), key) !== undefined; };
  Store.prototype.delete = function (key) { var d = this._read(); delPath(d, key); this._write(d); };
  Store.prototype.clear = function () { this._write({}); };
  Store.prototype.onDidChange = function () { return function () {}; };
  Store.prototype.onDidAnyChange = function () { return function () {}; };
  Object.defineProperty(Store.prototype, 'store', {
    get: function () { return this._read(); },
    set: function (v) { this._write(clone(v) || {}); }
  });
  Object.defineProperty(Store.prototype, 'size', { get: function () { return Object.keys(this._read()).length; } });

  // ---------- the "main process": archive loading and IPC ----------

  var ARCHIVE_FILES = ['mspa', 'social', 'news', 'music', 'comics', 'extras', 'tweaks'];

  function fetchJson(rel) {
    return fetch(PACK_URL + rel).then(function (r) {
      if (!r.ok) throw new Error('Could not load ' + rel + ' from the asset pack (HTTP ' + r.status + ')');
      return r.json();
    });
  }

  function fetchArchiveJson() {
    return Promise.all([fetchJson('archive/data/version.json')].concat(
      ARCHIVE_FILES.map(function (k) { return fetchJson('archive/data/' + k + '.json'); })
    ));
  }
  // Start the ~13 MB of archive JSON now, while the bundle is still parsing; on desktop the main
  // process has it ready too. Used once (mods edit the objects, so a reload fetches fresh ones).
  var prefetchedArchive = null;
  if (!/^\/__setup\//.test(location.pathname)) {
    prefetchedArchive = fetchArchiveJson();
    prefetchedArchive.catch(function () { /* reported when the app asks for it */ });
  }

  function loadArchiveData() {
    ipcRenderer.emit('SET_LOAD_STAGE', 'ARCHIVE');
    var pending = prefetchedArchive || fetchArchiveJson();
    prefetchedArchive = null;
    return pending.catch(function () { return fetchArchiveJson(); }).then(function (res) {
      var data = Object.assign({}, res[0]);
      ARCHIVE_FILES.forEach(function (k, i) { data[k] = res[i + 1]; });
      data.audioData = {}; data.flags = {}; data.mspfa = {};
      if (!fs.existsSync(ASSET_DIR + '/storyfiles/hs2/00001.gif')) {
        throw new Error('The asset pack looks incomplete: storyfiles/hs2/00001.gif is missing.');
      }
      ipcRenderer.emit('SET_LOAD_STAGE', 'LOADED_ARCHIVE_VANILLA');
      return data;
    });
  }

  function openExternal(url) {
    if (NATIVE && NATIVE.openExternal) NATIVE.openExternal(String(url));
    else window.open(String(url), '_blank');
    return Promise.resolve();
  }

  var ipcRenderer = new EventEmitter();
  var _emit = ipcRenderer.emit;
  // Renderer listeners get (event, ...args) like Electron.
  ipcRenderer.emit = function (ch) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (args.length === 0 || args[0] === null || typeof args[0] !== 'object' || !args[0].__uhcEvent) {
      args.unshift({ __uhcEvent: true, sender: ipcRenderer });
    }
    return _emit.apply(ipcRenderer, [ch].concat(args));
  };
  function emitLater(ch) {
    var args = Array.prototype.slice.call(arguments);
    setTimeout(function () { ipcRenderer.emit.apply(ipcRenderer, args); }, 0);
  }

  ipcRenderer.send = function (ch) {
    var a = Array.prototype.slice.call(arguments, 1);
    switch (ch) {
      case 'RELOAD_ARCHIVE_DATA':
        emitLater('SET_LOAD_STATE', 'LOADING');
        loadArchiveData().then(function (archive) {
          ipcRenderer.emit('ARCHIVE_UPDATE', archive);
        }).catch(function (e) {
          console.error('[uhc-shim] archive load failed', e);
          ipcRenderer.emit('SET_LOAD_STATE', 'ERROR');
          ipcRenderer.emit('SET_LOAD_ERROR', JSON.stringify({ stack: String(e && e.stack || e), message: String(e && e.message || e) }));
        });
        return;
      case 'set-title':
        if (typeof a[0] === 'string') document.title = a[0];
        return;
      default:
        return; // set-sys-icon, ondragstart, log forwarding, etc.
    }
  };

  ipcRenderer.sendSync = function (ch) {
    switch (ch) {
      case 'STARTUP_GET_INFO':
        // main.js builds the asset root as `http://127.0.0.1:${port}/`, so "port" carries the /pack path too.
        return { port: (location.port || '80') + '/pack', userData: USER_DATA, appVersion: '2.8.1' };
      case 'win-close-sync':
        return true;
      default:
        return undefined;
    }
  };

  ipcRenderer.invoke = function (ch) {
    var a = Array.prototype.slice.call(arguments, 1);
    switch (ch) {
      case 'reload':
      case 'restart':
        location.reload();
        return Promise.resolve();
      case 'prompt-okay-cancel': {
        var o = a[0] || {};
        return Promise.resolve(window.confirm([o.title, o.message, o.detail].filter(Boolean).join('\n\n')));
      }
      case 'check-archive-version':
        return fetchJson('archive/data/version.json').then(function (v) { return v.version; }).catch(function () { return undefined; });
      case 'locate-assets':
        return Promise.resolve(ASSET_DIR);
      case 'steam-open':
        return openExternal(a[0]);
      case 'save-file':
      case 'pick-file':
      case 'pick-new-file':
      case 'pick-directory':
      case 'copy-image':
      case 'inspect-element':
        warnOnce('ipc ' + ch);
        return Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined); // win-minimize / win-maximize / win-close
    }
  };
  ipcRenderer.sendTo = ipcRenderer.sendToHost = function () {};

  // ---------- electron ----------

  var electron = {
    ipcRenderer: ipcRenderer,
    shell: { openExternal: openExternal, openPath: function () { return Promise.resolve(''); }, showItemInFolder: function () {} },
    dialog: {
      showMessageBox: function (o) { window.alert([o && o.title, o && o.message, o && o.detail].filter(Boolean).join('\n\n')); return Promise.resolve({ response: 0 }); },
      showMessageBoxSync: function (o) { window.alert([o && o.title, o && o.message].filter(Boolean).join('\n\n')); return 0; }
    },
    clipboard: { writeText: function (t) { try { navigator.clipboard.writeText(t); } catch (e) {} }, readText: function () { return ''; } },
    webFrame: { setZoomFactor: function () {}, getZoomFactor: function () { return 1; }, setVisualZoomLevelLimits: function () {} },
    ipcMain: undefined,       // mods.js checks this to detect the main process
    remote: undefined
  };

  // ---------- other Node modules the bundle declares ----------

  var modules = {
    electron: electron,
    'electron-store': Store,
    fs: fs,
    'fs/promises': fs.promises,
    path: path,
    events: EventEmitter,
    os: { platform: function () { return 'linux'; }, homedir: function () { return USER_DATA; }, tmpdir: function () { return '/tmp'; }, EOL: '\n', type: function () { return 'Linux'; }, arch: function () { return 'arm64'; } },
    url: { URL: URL, URLSearchParams: URLSearchParams, parse: function (u) { return new URL(u, ORIGIN); }, fileURLToPath: function (u) { return new URL(u).pathname; }, pathToFileURL: function (p) { return new URL('file://' + p); } },
    util: {
      inspect: function (x) { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); } },
      format: function () { return Array.prototype.join.call(arguments, ' '); },
      promisify: function (fn) { return function () { var args = Array.prototype.slice.call(arguments); return new Promise(function (res, rej) { fn.apply(null, args.concat(function (e, r) { e ? rej(e) : res(r); })); }); }; },
      inherits: function (c, p) { c.prototype = Object.create(p.prototype, { constructor: { value: c } }); },
      deprecate: function (fn) { return fn; },
      TextDecoder: window.TextDecoder, TextEncoder: window.TextEncoder
    },
    querystring: { parse: function (s) { return Object.fromEntries(new URLSearchParams(s)); }, stringify: function (o) { return new URLSearchParams(o).toString(); } },
    assert: function (c, m) { if (!c) throw new Error(m || 'Assertion failed'); },
    constants: {}
  };
  modules.buffer = { Buffer: Buffer };
  modules['js-yaml'] = window.jsyaml || stub('js-yaml');   // loaded from shim/vendor before this file
  ['crypto', 'stream', 'zlib', 'http', 'https', 'tar'].forEach(function (n) { modules[n] = stub(n); });

  // CommonJS loader for JS files inside the asset pack (the built-in "imods" are loaded this way).
  var fileCache = {};
  function requireFile(abs) {
    var candidates = [abs, abs + '.js', abs + '.json', abs + '/index.js'];
    var file = null;
    for (var i = 0; i < candidates.length; i++) {
      if (fileCache[candidates[i]]) return fileCache[candidates[i]].exports;
      if (headSync(candidates[i]) === 'file') { file = candidates[i]; break; }
    }
    if (!file) throw enoent(abs);
    var src = getSync(file, 'utf8');
    var mod = { exports: {}, id: file, filename: file, loaded: false };
    fileCache[file] = mod;
    try {
      if (/\.json$/i.test(file)) {
        mod.exports = JSON.parse(src);
      } else {
        var dir = path.dirname(file);
        var localRequire = function (name) {
          if (name.charAt(0) === '.' || name.charAt(0) === '/') return requireFile(path.resolve(dir, name));
          return window.require(name);
        };
        localRequire.cache = fileCache;
        localRequire.resolve = function (n) { return path.resolve(dir, n); };
        var fn = new Function('module', 'exports', 'require', '__filename', '__dirname',
          src + '\n//# sourceURL=' + packUrlFor(file));
        fn.call(mod.exports, mod, mod.exports, localRequire, file, dir);
      }
    } catch (e) {
      delete fileCache[file];
      throw e;
    }
    mod.loaded = true;
    return mod.exports;
  }

  window.require = function (name) {
    if (name in modules) return modules[name];
    if (typeof name === 'string' && name.charAt(0) === '/') return requireFile(path.normalize(name));
    warnOnce('require("' + name + '")');
    return stub(name);
  };
  window.require.cache = fileCache;
  window.require.resolve = function (n) { return n; };
  window.global = window;
  window.process = window.process || {
    type: 'renderer', platform: 'linux', arch: 'arm64', argv: [], env: { NODE_ENV: 'production' },
    versions: { node: '18.20.0', electron: '0.0.0', chrome: '' },
    cwd: function () { return '/'; },
    nextTick: function (fn) { var a = Array.prototype.slice.call(arguments, 1); Promise.resolve().then(function () { fn.apply(null, a); }); },
    on: function () {}, once: function () {}, emit: function () {}
  };

  // ---------- URL redirection (Electron's webRequest.onBeforeRequest, done in-page) ----------
  //
  // On desktop, the main process redirects every assets:// request (and a few old external URLs)
  // by asking the UI's own resolver, Resources.resolveURL. A WebView has no such hook, so:
  //  1. When main.js publishes window.Resources, make $getResourceURL return final URLs
  //     (this is what the bundle's own web-app mode does).
  //  2. Safety net: rewrite any assets:// URL that still reaches the DOM, CSS, fetch or XHR.

  var Resources = null;
  var REDIRECT_RE = /^assets:\/\/|mspaintadventures\.com|^https?:\/\/asset\.uhc\/|sweetcred\.com|turner\.com\/planet\/mp3\/cp_close\.mp3|fozzy42\.com\/SoundClips|pasko\.webs\.com\/foreign|timelesschaos\.com\/transferFiles/i;

  function fixUrl(u) {
    if (typeof u !== 'string' || !REDIRECT_RE.test(u)) return u;
    try {
      if (Resources && Resources.isReady && Resources.isReady()) {
        return u.indexOf('assets://') === 0 ? Resources.resolveAssetsProtocol(u) : Resources.resolveURL(u);
      }
    } catch (e) { /* fall through */ }
    return u.indexOf('assets://') === 0 ? PACK_URL + u.slice('assets://'.length) : u;
  }
  function fixCss(text) {
    if (typeof text !== 'string' || text.indexOf('assets://') < 0) return text;
    return text.replace(/assets:\/\/[^"')\s]+/g, fixUrl);
  }

  Object.defineProperty(window, 'Resources', {
    configurable: true,
    get: function () { return Resources; },
    set: function (R) {
      Resources = R;
      if (R && R.resolveURL && !R.__uhcPatched) {
        R.__uhcPatched = true;
        // Already-final pack URLs must pass through untouched, or they come back as /pack/pack/...
        var resolveURL = R.resolveURL;
        R.resolveURL = function (url) {
          return (typeof url === 'string' && url.indexOf(PACK_URL) === 0) ? url : resolveURL(url);
        };
        R.getResourceURL = R.resolveURL;
      }
    }
  });

  // Attributes set by Vue (setAttribute) and by code (element.src = ...)
  var URL_ATTRS = { src: 1, href: 1, poster: 1, data: 1 };
  var origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var n = String(name).toLowerCase();
    if (URL_ATTRS[n] && !(this instanceof HTMLAnchorElement)) value = fixUrl(value);
    else if (n === 'style') value = fixCss(value);
    else if (n === 'srcdoc' && this instanceof HTMLIFrameElement) value = hookSrcdoc(value);
    return origSetAttribute.call(this, name, value);
  };
  [[HTMLImageElement, 'src'], [HTMLMediaElement, 'src'], [HTMLSourceElement, 'src'], [HTMLIFrameElement, 'src'],
   [HTMLEmbedElement, 'src'], [HTMLObjectElement, 'data'], [HTMLScriptElement, 'src'], [HTMLLinkElement, 'href'],
   [HTMLVideoElement, 'poster']].forEach(function (pair) {
    var proto = pair[0].prototype, d = Object.getOwnPropertyDescriptor(proto, pair[1]);
    if (!d || !d.set) return;
    Object.defineProperty(proto, pair[1], {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set: function (v) { d.set.call(this, fixUrl(v)); }
    });
  });

  // Inline styles (Vue style bindings use setProperty or direct property sets)
  var origSetProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function (prop, value, prio) {
    return origSetProperty.call(this, prop, fixCss(value), prio);
  };
  ['background', 'backgroundImage', 'cssText', 'content', 'listStyleImage', 'borderImage', 'borderImageSource', 'cursor'].forEach(function (prop) {
    var d = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, prop);
    if (!d || !d.set) return;
    Object.defineProperty(CSSStyleDeclaration.prototype, prop, {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set: function (v) { d.set.call(this, fixCss(v)); }
    });
  });

  // Network calls. Also applied inside same-origin iframes: the Flash player (Ruffle) runs in a
  // srcdoc iframe, and SWFs fetch their music from the old mspaintadventures.com URLs.
  function patchNetwork(win) {
    if (win.__uhcNetPatched) return;
    win.__uhcNetPatched = true;
    var origFetch = win.fetch;
    win.fetch = function (input, init) {
      if (typeof input === 'string') input = fixUrl(input);
      else if (input instanceof win.URL) input = fixUrl(input.href);
      else if (input && input.url && REDIRECT_RE.test(input.url)) input = new win.Request(fixUrl(input.url), input);
      return origFetch.call(this, input, init);
    };
    var origOpen = win.XMLHttpRequest.prototype.open;
    win.XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      args[1] = fixUrl(typeof url === 'string' ? url : String(url));
      return origOpen.apply(this, args);
    };
  }
  patchNetwork(window);

  // Put a one-line hook at the top of every srcdoc iframe so it is patched before its scripts run.
  var SRCDOC_HOOK = '<script>try{parent.UHCShim.patchNetwork(window)}catch(e){}</scr' + 'ipt>';
  function hookSrcdoc(html) {
    return (typeof html === 'string' && html.indexOf('UHCShim.patchNetwork') < 0) ? SRCDOC_HOOK + html : html;
  }
  var srcdocDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc');
  if (srcdocDesc && srcdocDesc.set) {
    Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
      configurable: true, enumerable: srcdocDesc.enumerable, get: srcdocDesc.get,
      set: function (v) { srcdocDesc.set.call(this, hookSrcdoc(v)); }
    });
  }

  // Markup inserted with innerHTML (story text, mod pages) and <style> blocks
  function fixNode(el) {
    if (el.nodeType !== 1) return;
    if (el.tagName === 'STYLE') {
      var t = el.textContent;
      if (t.indexOf('assets://') >= 0) el.textContent = fixCss(t);
      return;
    }
    ['src', 'poster', 'data'].forEach(function (a) {
      var v = el.getAttribute(a);
      if (v && v.indexOf('assets://') === 0) origSetAttribute.call(el, a, fixUrl(v));
    });
    var st = el.getAttribute('style');
    if (st && st.indexOf('assets://') >= 0) origSetAttribute.call(el, 'style', fixCss(st));
  }
  function fixTree(root) {
    fixNode(root);
    if (root.querySelectorAll) {
      var list = root.querySelectorAll('[src^="assets://"],[poster^="assets://"],[data^="assets://"],[style*="assets://"],style');
      for (var i = 0; i < list.length; i++) fixNode(list[i]);
    }
  }
  new MutationObserver(function (records) {
    records.forEach(function (r) {
      if (r.type === 'childList') {
        r.addedNodes.forEach(function (n) { if (n.nodeType === 1) fixTree(n); else if (n.parentNode && n.parentNode.tagName === 'STYLE') fixNode(n.parentNode); });
      } else if (r.type === 'characterData' && r.target.parentNode && r.target.parentNode.tagName === 'STYLE') {
        fixNode(r.target.parentNode);
      }
    });
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  window.UHCShim = { PACK_URL: PACK_URL, ASSET_DIR: ASSET_DIR, ipcRenderer: ipcRenderer, Store: Store, fixUrl: fixUrl, patchNetwork: patchNetwork };
})();
