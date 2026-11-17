package uhc.android.reader;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.io.File;

/**
 * A single full-screen WebView running the unchanged UHC 2.8.1 bundle.
 * PackServer feeds it files; the JS bridge "UHCNative" handles setup and external links.
 */
public class MainActivity extends Activity {
    private static final int REQ_PICK_FOLDER = 1;
    private static final int REQ_READ_STORAGE = 2;
    private static final String PREF_PACK = "packPath";

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
    private static final String PREF_VERIFIED = "verifiedPackPath";

    private WebView web;
    private PackServer server;
    private SharedPreferences prefs;
    private volatile int lastCount = -1;
    private volatile boolean checking = false;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("uhc", MODE_PRIVATE);
        server = new PackServer(getAssets());

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true); // chrome://inspect from the PC
        }

        FrameLayout rootView = new FrameLayout(this);
        // Colour behind the status and navigation bars: MSPA grey, or black to match UHC's dark theme.
        boolean night = (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
            == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        rootView.setBackgroundColor(night ? Color.BLACK : Color.rgb(0x53, 0x53, 0x53));
        web = new WebView(this);
        rootView.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(rootView);
        applySystemBarInsets(rootView);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
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
                return server.handle(request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (PackServer.HOST.equals(u.getHost()) && u.getPort() == PackServer.PORT) return false;
                openExternal(u.toString());
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "UHCNative");

        File pack = findPack();
        if (pack != null && isVerified(pack)) {
            openPack(pack);
        } else {
            web.loadUrl(PackServer.ORIGIN + "/__setup/index.html");
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
            && prefs.getLong("verifiedLength", -2) == pack.length();
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
                if (n >= EXPECTED_FILES - FILE_TOLERANCE) {
                    prefs.edit().putString(PREF_VERIFIED, pack.getAbsolutePath()).putLong("verifiedLength", pack.length()).apply();
                    openPack(pack);
                } else {
                    notifySetupPageState();
                }
            });
        }, "pack-count").start();
    }

    private void notifySetupPageState() {
        if (web != null) web.evaluateJavascript("window.onNativeResume && onNativeResume()", null);
    }

    // ---------- keep the pack out of the photo gallery ----------

    /**
     * A ".nomedia" file tells Android's media scanner to skip the folder, so the pack's
     * 12,000 GIFs and PNGs don't show up in Photos/Gallery. Nothing is deleted.
     */
    private void hideFromGallery(File pack) {
        File marker = new File(pack, ".nomedia");
        try {
            if (!marker.exists()) marker.createNewFile();
        } catch (java.io.IOException ignored) {
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
        if (f.isFile() && f.getName().toLowerCase(java.util.Locale.ROOT).endsWith(".zip")) return true;
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
        notifySetupPage();
    }

    private void notifySetupPage() {
        if (web == null) return;
        String url = web.getUrl();
        if (url != null && url.contains("/__setup/")) {
            File pack = findPack();
            if (pack != null && isVerified(pack)) openPack(pack);
            else if (pack != null) verifyThenOpen(pack);
            else notifySetupPageState();
        }
    }

    // ---------- navigation ----------

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("(window.UHCMobile && UHCMobile.back()) ? 1 : 0", result -> {
            if (!"1".equals(result)) moveTaskToBack(true);
        });
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException ignored) { }
    }

    /** Android 15 draws behind the status and navigation bars; keep the page inside them. */
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

    private final class Bridge {
        @JavascriptInterface
        public String status() {
            try {
                File pack = findPack();
                return new JSONObject()
                    .put("hasAccess", hasFileAccess())
                    .put("packPath", pack == null ? JSONObject.NULL : pack.getAbsolutePath())
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
        public void requestAccess() { runOnUiThread(MainActivity.this::requestFileAccess); }

        @JavascriptInterface
        public void pickFolder() {
            runOnUiThread(() -> startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQ_PICK_FOLDER));
        }

        @JavascriptInterface
        public void openExternal(String url) { runOnUiThread(() -> MainActivity.this.openExternal(url)); }

        @JavascriptInterface
        public void recheck() {
            runOnUiThread(() -> {
                File pack = findPack();
                if (pack != null) verifyThenOpen(pack); else notifySetupPageState();
            });
        }

        @JavascriptInterface
        public void forgetPack() {
            prefs.edit().remove(PREF_PACK).apply();
            runOnUiThread(() -> web.loadUrl(PackServer.ORIGIN + "/__setup/index.html"));
        }
    }
}
