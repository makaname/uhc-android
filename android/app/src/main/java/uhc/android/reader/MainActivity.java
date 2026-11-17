package uhc.android.reader;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
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

import java.io.FileInputStream;
import java.util.Locale;
import java.util.Map;

/**
 * A single full-screen WebView running the unchanged UHC 2.8.1 bundle.
 * PackServer feeds it files; the JS bridge "UHCNative" handles setup, external links and system-bar colours.
 *
 * The asset pack is one zip the reader picks once in Android's file picker. The app keeps read access
 * to that one file (a persisted URI permission) and reads it in place; it has no broad storage permission.
 */
public class MainActivity extends Activity {
    private static final int REQ_PICK_ZIP = 1;
    private static final String PREF_URI = "packUri";

    static final String PACK_ZIP = "UHC-Asset-Pack-V2.zip";

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

    // Setup state, read by the setup page through status()
    private volatile boolean checking = false;
    private volatile int lastCount = -1;
    private volatile String packName = null;
    /** "incomplete", "notzip", "unreadable", "moved" or null. */
    private volatile String problem = null;
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
                // Embedded frames: only Bandcamp's player may load (UHC's Music pages); others stay blocked.
                if (!request.isForMainFrame()) return !PackServer.isAllowedRemote(host);
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

        Uri pack = savedPack();
        if (pack == null) showSetup();
        else openOrCheck(pack, true);
    }

    private void showSetup() {
        closeOpenPack();
        web.loadUrl(PackServer.ORIGIN + "/__setup/index.html");
    }

    private void closeOpenPack() {
        PackSource old = server.pack();
        server.setPack(null);
        if (old != null) old.close();
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

    // ---------- the picked zip ----------

    /** The picked zip, if the app still holds read access to it. */
    private Uri savedPack() {
        String s = prefs.getString(PREF_URI, null);
        if (s == null) return null;
        Uri u = Uri.parse(s);
        for (UriPermission p : getContentResolver().getPersistedUriPermissions()) {
            if (p.isReadPermission() && p.getUri().equals(u)) return u;
        }
        return null;   // access was revoked (app data cleared, or the file's app forgot it)
    }

    /** Opens the zip through its file descriptor; null if it can't be opened or isn't a complete zip. */
    private PackSource openZip(Uri uri) {
        ParcelFileDescriptor pfd;
        try {
            pfd = getContentResolver().openFileDescriptor(uri, "r");
        } catch (Exception e) {
            return null;
        }
        if (pfd == null) return null;
        long size = pfd.getStatSize();
        FileInputStream in = new FileInputStream(pfd.getFileDescriptor());
        return PackSource.openZip(in.getChannel(), displayName(uri), () -> sizeOf(uri) == size, () -> {
            in.close();
            pfd.close();
        });
    }

    /** The file's size now, or -1 if it's gone (used to notice a moved, deleted or replaced pack). */
    private long sizeOf(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) {
            // provider gone or file deleted
        }
        return -1;
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) {
            // fall through
        }
        return PACK_ZIP;
    }

    /**
     * Opens the pack off the UI thread. A pack already checked at this size opens straight away;
     * otherwise its files are counted first, and the setup page shows the result.
     */
    private void openOrCheck(Uri uri, boolean quietIfVerified) {
        if (checking) return;
        checking = true;
        problem = null;
        if (!quietIfVerified) notifySetupPageState();
        new Thread(() -> {
            String name = displayName(uri);
            PackSource src = openZip(uri);
            int n = src == null ? 0 : src.countFiles();
            boolean looksRight = src != null && src.looksLikePack();
            boolean complete = looksRight && n >= EXPECTED_FILES - FILE_TOLERANCE;

            runOnUiThread(() -> {
                checking = false;
                packName = name;
                lastCount = n;
                if (isFinishing() || isDestroyed()) {
                    if (src != null) src.close();
                    return;
                }
                if (complete) {

                    closeOpenPack();
                    server.setPack(src);
                    problem = null;
                    web.loadUrl(PackServer.ORIGIN + "/");
                    return;
                }
                if (src != null) src.close();
                problem = src == null ? (name.toLowerCase(Locale.ROOT).endsWith(".zip") ? "unreadable" : "notzip")
                    : !looksRight ? "notzip" : "incomplete";
                if (!onSetupPage) showSetup(); else notifySetupPageState();
            });
        }, "pack-open").start();
    }

    private void notifySetupPageState() {
        if (web != null && onSetupPage) web.evaluateJavascript("window.onNativeResume && onNativeResume()", null);
    }

    private void pickZip() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "application/zip", "application/x-zip-compressed", "application/x-zip", "application/octet-stream"})
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        // Start in Download, where LocalSend and most transfers put it.
        i.putExtra(DocumentsContract.EXTRA_INITIAL_URI,
            Uri.parse("content://com.android.externalstorage.documents/document/primary%3ADownload"));
        try {
            startActivityForResult(i, REQ_PICK_ZIP);
        } catch (ActivityNotFoundException e) {
            problem = "unreadable";
            notifySetupPageState();
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK_ZIP || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        ContentResolver cr = getContentResolver();
        try {
            cr.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException e) {
            // Some file apps don't offer lasting access; it still works until the app restarts.
        }
        // Keep access to the newly picked file only.
        for (UriPermission p : cr.getPersistedUriPermissions()) {
            if (!p.getUri().equals(uri)) {
                try { cr.releasePersistableUriPermission(p.getUri(), Intent.FLAG_GRANT_READ_URI_PERMISSION); }
                catch (SecurityException ignored) { /* already gone */ }
            }
        }
        prefs.edit().putString(PREF_URI, uri.toString()).apply();
        openOrCheck(uri, false);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // The pack was moved, deleted or replaced while the app was in the background.
        PackSource open = server.pack();
        if (open != null && !open.stillValid()) {

            problem = "moved";
            showSetup();
            return;
        }
        notifySetupPageState();
    }

    @Override
    protected void onPause() {
        super.onPause();
        // UHC saves reading progress 1 s after each page turn; save now, in case Android ends the app.
        if (web != null && !onSetupPage) {
            web.evaluateJavascript("(function(v){v&&v.applySaveIfPending&&v.applySaveIfPending()})"
                + "(window.vm&&vm.$localData&&vm.$localData.VM)", null);
        }
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
        closeOpenPack();
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
                return new JSONObject()
                    .put("hasPack", prefs.getString(PREF_URI, null) != null)
                    .put("packName", packName == null ? JSONObject.NULL : packName)
                    .put("checking", checking)
                    .put("problem", problem == null ? JSONObject.NULL : problem)
                    .put("fileCount", lastCount)
                    .put("expectedFiles", EXPECTED_FILES)
                    .toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void pickZip() {
            if (onSetupPage) runOnUiThread(MainActivity.this::pickZip);
        }

        @JavascriptInterface
        public void recheck() {
            if (!onSetupPage) return;
            runOnUiThread(() -> {
                Uri pack = savedPack();
                if (pack != null) openOrCheck(pack, false);
                else { problem = null; notifySetupPageState(); }
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
