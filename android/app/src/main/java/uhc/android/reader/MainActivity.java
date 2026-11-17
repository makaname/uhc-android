package uhc.android.reader;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.Locale;
import java.util.Map;

/**
 * A single full-screen WebView running the unchanged UHC 2.8.1 bundle.
 * PackServer feeds it files; the JS bridge "UHCNative" handles setup, external links and system-bar colours.
 */
public class MainActivity extends Activity {
    private static final int REQ_PICK_FOLDER = 1;
    private static final int REQ_READ_STORAGE = 2;
    private static final String PREF_PACK = "packPath";
    private static final String PREF_VERIFIED = "verifiedPackPath";
    private static final String PREF_VERIFIED_LENGTH = "verifiedLength";

    /** Single-file pack (preferred: one transfer, read in place, invisible to the gallery). */
    private static final String PACK_ZIP = "UHC-Asset-Pack-V2.zip";
    private static final String[] ZIP_LOCATIONS = {
        "Download/" + PACK_ZIP, "Homestuck/" + PACK_ZIP, PACK_ZIP, "Documents/" + PACK_ZIP,
    };
    /** Unpacked folder locations people commonly copy to. */
    private static final String[] FOLDER_LOCATIONS = {
        "Homestuck/Asset Pack V2", "Asset Pack V2", "Download/Asset Pack V2", "Documents/Asset Pack V2",
        "Homestuck/Asset Pack V2 - The Unofficial Homestuck Collection/Asset Pack V2",
        "Download/Asset Pack V2 - The Unofficial Homestuck Collection/Asset Pack V2",
    };

    /** Regular (non-hidden) files in Asset Pack V2. Fewer means it's still copying or got cut short. */
    private static final int EXPECTED_FILES = 18880;
    private static final int FILE_TOLERANCE = 10;

    /** System-bar colours: UHC's light frame (MSPA greys) and its Dark theme. */
    static final int LIGHT_FRAME = 0xFF535353, LIGHT_BAR = 0xFFC6C6C6;
    static final int DARK_FRAME = 0xFF000000, DARK_BAR = 0xFF262626;

    private WebView web;
    private FrameLayout rootView;
    private PackServer server;
    private SharedPreferences prefs;
    private volatile int lastCount = -1;
    private volatile boolean checking = false;
    /** True while the setup page is showing; setup-only bridge calls are ignored otherwise. */
    private volatile boolean onSetupPage = false;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("uhc", MODE_PRIVATE);
        server = new PackServer(getAssets()::open);

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true); // chrome://inspect and tools/cdp.mjs
        }

        rootView = new FrameLayout(this);
        web = new WebView(this);
        rootView.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(rootView);
        applySystemBarInsets(rootView);
        // Until the page reports its theme: MSPA grey, or UHC's Dark theme when the phone is dark.
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            == Configuration.UI_MODE_NIGHT_YES;
        applyChrome(night ? DARK_FRAME : LIGHT_FRAME, night ? DARK_BAR : LIGHT_BAR);
        registerBackHandler();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // Flash music and page audio
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(true);                          // pinch-zoom on panels
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setTextZoom(100);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return toWebResponse(server, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (PackServer.HOST.equals(u.getHost()) && u.getPort() == PackServer.PORT) return false;
                String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
                if (!onSetupPage && (host.equals("mspaintadventures.com") || host.endsWith(".mspaintadventures.com"))) {
                    // A Flash linking to another page: open it in the app, as desktop UHC does.
                    view.evaluateJavascript("window.UHCMobile && UHCMobile.openInApp(" + JSONObject.quote(u.toString()) + ")", null);
                    return true;
                }
                openExternal(u.toString());
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                onSetupPage = url != null && url.startsWith(PackServer.ORIGIN + "/__setup/");
                if (onSetupPage) getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "UHCNative");

        File pack = findPack();
        if (pack != null && isVerified(pack)) {
            openPack(pack);
        } else {
            showSetup();
            if (pack != null) verifyThenOpen(pack);
        }
    }

    private void openPack(File pack) {
        PackSource src = sourceFor(pack);
        if (src == null) { verifyThenOpen(pack); return; }
        if (pack.isDirectory()) hideFromGallery(pack);
        server.setPack(src);
        web.loadUrl(PackServer.ORIGIN + "/");
    }

    private void showSetup() {
        server.setPack(null);
        web.loadUrl(PackServer.ORIGIN + "/__setup/index.html");
    }

    /** Adapts a WebView request to {@link PackServer#route} and its reply back. */
    static WebResourceResponse toWebResponse(PackServer server, WebResourceRequest req) {
        Uri u = req.getUrl();
        String range = null;
        Map<String, String> rh = req.getRequestHeaders();
        if (rh != null) {
            for (Map.Entry<String, String> e : rh.entrySet()) {
                if ("Range".equalsIgnoreCase(e.getKey())) range = e.getValue();
            }
        }
        boolean list = u.isHierarchical() && u.getQueryParameter("list") != null;
        PackServer.Reply r = server.route(req.getMethod(), u.getHost(), u.getPort(), u.getPath(), list, range);
        if (r == null) return null;
        return new WebResourceResponse(r.mime, r.encoding(), r.status, r.reason, r.headers, r.body);
    }

    // ---------- reading the pack (folder or zip), cached ----------

    private File cachedFile;
    private long cachedLength = -1, cachedModified = -1;
    private PackSource cachedSource;

    /** Opens the pack, reusing the parsed zip index while the file is unchanged. Null if unreadable. */
    private synchronized PackSource sourceFor(File f) {
        if (f == null) return null;
        if (f.equals(cachedFile) && f.length() == cachedLength && f.lastModified() == cachedModified) return cachedSource;
        PackSource s = PackSource.open(f);
        if (s != null && !s.looksLikePack()) s = null;
        cachedFile = f; cachedLength = f.length(); cachedModified = f.lastModified(); cachedSource = s;
        return s;
    }

    // ---------- completeness check ----------

    private boolean isVerified(File pack) {
        return pack.getAbsolutePath().equals(prefs.getString(PREF_VERIFIED, null))
            && prefs.getLong(PREF_VERIFIED_LENGTH, -2) == pack.length();
    }

    /** Counts the pack's files off the UI thread; opens the app if it's complete, else reports to the setup page. */
    private void verifyThenOpen(File pack) {
        if (checking) return;
        checking = true;
        if (pack.isDirectory()) hideFromGallery(pack); // early, so copying in progress stops filling the gallery
        notifySetupPageState();
        new Thread(() -> {
            PackSource src = sourceFor(pack);   // a zip that's still copying has no index yet -> null
            int n = src == null ? 0 : src.countFiles();
            lastCount = n;
            checking = false;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (n >= EXPECTED_FILES - FILE_TOLERANCE) {
                    prefs.edit().putString(PREF_VERIFIED, pack.getAbsolutePath()).putLong(PREF_VERIFIED_LENGTH, pack.length()).apply();
                    openPack(pack);
                } else {
                    notifySetupPageState();
                }
            });
        }, "pack-count").start();
    }

    private void notifySetupPageState() {
        if (web != null && onSetupPage) web.evaluateJavascript("window.onNativeResume && onNativeResume()", null);
    }

    // ---------- keep the pack out of the photo gallery ----------

    /**
     * A ".nomedia" file tells Android's media scanner to skip the folder, so the pack's
     * 12,000 GIFs and PNGs don't show up in Photos/Gallery. Nothing is deleted.
     */
    private void hideFromGallery(File pack) {
        File marker = new File(pack, ".nomedia");
        try {
            if (!marker.exists() && !marker.createNewFile()) return;
        } catch (IOException e) {
            return;
        }
        // Ask the media index to re-read the folder so already-indexed images drop out.
        android.media.MediaScannerConnection.scanFile(this,
            new String[]{marker.getAbsolutePath(), pack.getAbsolutePath()}, null, null);
        File parent = pack.getParentFile();
        if (parent != null) {
            android.media.MediaScannerConnection.scanFile(this, new String[]{parent.getAbsolutePath()}, null, null);
        }
    }

    // ---------- asset pack location ----------

    /** A pack candidate: the zip file exists (it may still be copying), or the folder has the archive data. */
    private static boolean isCandidate(File f) {
        if (f == null) return false;
        if (f.isFile() && f.getName().toLowerCase(Locale.ROOT).endsWith(".zip")) return true;
        return new File(f, "archive/data/mspa.json").isFile();
    }

    /** Finds the pack: a verified saved choice first, then the zip, then unpacked folders. */
    private File findPack() {
        if (!hasFileAccess()) return null;
        String saved = prefs.getString(PREF_PACK, null);
        File savedFile = saved == null ? null : new File(saved);
        if (savedFile != null && isCandidate(savedFile) && isVerified(savedFile)) return savedFile;

        File base = Environment.getExternalStorageDirectory();
        for (String rel : ZIP_LOCATIONS) {
            File f = new File(base, rel);
            if (isCandidate(f)) return remember(f);
        }
        if (savedFile != null && isCandidate(savedFile)) return savedFile;
        for (String rel : FOLDER_LOCATIONS) {
            File f = new File(base, rel);
            if (isCandidate(f)) return remember(f);
        }
        return null;
    }

    private File remember(File f) {
        prefs.edit().putString(PREF_PACK, f.getAbsolutePath()).apply();
        return f;
    }

    private boolean hasFileAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return Environment.isExternalStorageManager();
        return checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestFileAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getPackageName())));
            } catch (ActivityNotFoundException e) {
                startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
            }
        } else {
            requestPermissions(new String[]{Manifest.permission.READ_EXTERNAL_STORAGE}, REQ_READ_STORAGE);
        }
    }

    /** Turns a folder-picker tree URI into a real path, e.g. "primary:Homestuck/Asset Pack V2". */
    private static File treeUriToFile(Uri tree) {
        String id = DocumentsContract.getTreeDocumentId(tree);
        int colon = id.indexOf(':');
        if (colon < 0) return null;
        String volume = id.substring(0, colon), rel = id.substring(colon + 1);
        File base = "primary".equalsIgnoreCase(volume) ? Environment.getExternalStorageDirectory() : new File("/storage/" + volume);
        return rel.isEmpty() ? base : new File(base, rel);
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK_FOLDER || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        File dir = treeUriToFile(data.getData());
        // People often pick the folder that holds the pack; look for the zip or "Asset Pack V2" inside it.
        if (dir != null && !isCandidate(dir)) {
            if (isCandidate(new File(dir, PACK_ZIP))) dir = new File(dir, PACK_ZIP);
            else if (isCandidate(new File(dir, "Asset Pack V2"))) dir = new File(dir, "Asset Pack V2");
        }
        if (isCandidate(dir)) {
            prefs.edit().putString(PREF_PACK, dir.getAbsolutePath()).apply();
            if (isVerified(dir)) openPack(dir); else verifyThenOpen(dir);
        } else {
            String shown = dir == null ? "that folder" : dir.getAbsolutePath();
            web.evaluateJavascript("window.onPackRejected && onPackRejected(" + JSONObject.quote(shown) + ")", null);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        notifySetupPage();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // The pack was moved, deleted or replaced while the app was in the background.
        PackSource open = server.pack();
        if (open != null && !open.stillValid()) {
            prefs.edit().remove(PREF_VERIFIED).apply();
            showSetup();
            File pack = findPack();
            if (pack != null) verifyThenOpen(pack);
            return;
        }
        notifySetupPage();
    }

    private void notifySetupPage() {
        if (web == null || !onSetupPage) return;
        File pack = findPack();
        if (pack != null && isVerified(pack)) openPack(pack);
        else if (pack != null) verifyThenOpen(pack);
        else notifySetupPageState();
    }

    // ---------- navigation ----------

    /** Android 13+ delivers back through OnBackInvokedDispatcher; onBackPressed stops being called on 16+. */
    private void registerBackHandler() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        goBack();
    }

    /** Back in the reader's history; at the start of it, leave the app (it stays in memory). */
    private void goBack() {
        if (web == null) return;
        web.evaluateJavascript("(window.UHCMobile && UHCMobile.back()) ? 1 : 0", result -> {
            if (!"1".equals(result)) moveTaskToBack(true);
        });
    }

    private void openExternal(String url) {
        Uri u = Uri.parse(url);
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        // Only ordinary links leave the app; intent:, file:, content: and the like are dropped.
        if (!scheme.equals("http") && !scheme.equals("https") && !scheme.equals("mailto")) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException ignored) {
            // no app to open it
        }
    }

    // ---------- system bars follow the active UHC theme ----------

    private int chromeTop, chromeBottom;

    /** {@code top} shows behind the status bar, {@code bottom} behind the navigation bar. */
    private void applyChrome(int top, int bottom) {
        chromeTop = top;
        chromeBottom = bottom;
        rootView.setBackground(new ColorDrawable(bottom) {
            private final Paint paint = new Paint();

            @Override
            public void draw(Canvas c) {
                super.draw(c);
                paint.setColor(chromeTop);
                c.drawRect(0, 0, getBounds().width(), rootView.getPaddingTop(), paint);
            }
        });
        web.setBackgroundColor(bottom);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                int light = (isLight(top) ? WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS : 0)
                    | (isLight(bottom) ? WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS : 0);
                c.setSystemBarsAppearance(light, mask);
            }
        }
    }

    static boolean isLight(int color) {
        return 0.299 * Color.red(color) + 0.587 * Color.green(color) + 0.114 * Color.blue(color) > 150;
    }

    static Integer parseColor(String s) {
        if (s == null || !s.matches("#[0-9a-fA-F]{6}")) return null;
        return 0xFF000000 | Integer.parseInt(s.substring(1), 16);
    }

    /** Android 15 draws behind the status and navigation bars; keep the page inside them. */
    @SuppressWarnings("deprecation")
    private void applySystemBarInsets(View v) {
        v.setOnApplyWindowInsetsListener((view, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                l = i.left; t = i.top; r = i.right; b = i.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
            }
            view.setPadding(l, t, r, b);
            view.invalidate();
            return insets;
        });
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    // ---------- JS bridge (window.UHCNative) ----------

    /**
     * Every script in the page can call these, including JS from the asset pack and its mods, so the
     * bridge is kept small: setup actions only work on the setup page, links only open http(s)/mailto.
     */
    private final class Bridge {
        @JavascriptInterface
        public String status() {
            if (!onSetupPage) return "{}";
            try {
                File pack = findPack();
                return new JSONObject()
                    .put("hasAccess", hasFileAccess())
                    .put("packPath", pack == null ? JSONObject.NULL : pack.getAbsolutePath())
                    .put("isZip", pack != null && pack.isFile())
                    .put("needsAllFilesAccess", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
                    .put("checking", checking)
                    .put("fileCount", lastCount)
                    .put("expectedFiles", EXPECTED_FILES)
                    .toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void requestAccess() {
            if (onSetupPage) runOnUiThread(MainActivity.this::requestFileAccess);
        }

        @JavascriptInterface
        @SuppressWarnings("deprecation")
        public void pickFolder() {
            if (!onSetupPage) return;
            runOnUiThread(() -> startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQ_PICK_FOLDER));
        }

        @JavascriptInterface
        public void recheck() {
            if (!onSetupPage) return;
            runOnUiThread(() -> {
                File pack = findPack();
                if (pack != null) verifyThenOpen(pack); else notifySetupPageState();
            });
        }

        /** Opens an http(s) or mailto link in the phone's browser or mail app. */
        @JavascriptInterface
        public void openExternal(String url) {
            if (url != null) runOnUiThread(() -> MainActivity.this.openExternal(url));
        }

        /** Colours behind the status bar and the navigation bar ("#rrggbb"), to match the UHC theme. */
        @JavascriptInterface
        public void setChrome(String top, String bottom) {
            Integer t = parseColor(top), b = parseColor(bottom);
            if (t == null || b == null) return;
            runOnUiThread(() -> {
                if (web != null && (t != chromeTop || b != chromeBottom)) applyChrome(t, b);
            });
        }

        /** Keeps the screen on while a Flash or video page is showing. */
        @JavascriptInterface
        public void setKeepScreenOn(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }
    }
}
