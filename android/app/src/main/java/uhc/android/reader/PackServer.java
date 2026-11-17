package uhc.android.reader;

import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Answers the WebView's requests without any real network server.
 *
 *   http://127.0.0.1:8137/          the UHC bundle + shim, from APK assets/web (single-page app fallback)
 *   http://127.0.0.1:8137/pack/     the asset pack folder on the phone
 *   http://127.0.0.1:8137/__setup/  first-run setup page, from APK assets/setup
 *   *.mspaintadventures.com/...     old URLs inside Flash files, mapped into the pack
 *
 * /pack/ follows the same contract as tools/dev-server.mjs:
 *   HEAD -> 200 + "X-UHC-Kind: file|dir" or 404;  GET dir/?list=1 -> JSON [{name, dir}];  Range supported.
 */
final class PackServer {
    static final String ORIGIN = "http://127.0.0.1:8137";
    static final String HOST = "127.0.0.1";
    static final int PORT = 8137;

    private static final Pattern RANGE = Pattern.compile("bytes=(\\d*)-(\\d*)");
    private static final Map<String, String> TYPES = new HashMap<>();
    static {
        String[][] t = {
            {"html", "text/html"}, {"js", "text/javascript"}, {"mjs", "text/javascript"}, {"css", "text/css"},
            {"json", "application/json"}, {"txt", "text/plain"}, {"xml", "application/xml"}, {"yaml", "text/yaml"},
            {"svg", "image/svg+xml"}, {"png", "image/png"}, {"gif", "image/gif"}, {"jpg", "image/jpeg"},
            {"jpeg", "image/jpeg"}, {"webp", "image/webp"}, {"ico", "image/x-icon"},
            {"swf", "application/x-shockwave-flash"}, {"wasm", "application/wasm"},
            {"mp3", "audio/mpeg"}, {"ogg", "audio/ogg"}, {"oga", "audio/ogg"}, {"m4a", "audio/mp4"},
            {"wav", "audio/wav"}, {"mp4", "video/mp4"}, {"webm", "video/webm"}, {"pdf", "application/pdf"},
            {"woff", "font/woff"}, {"woff2", "font/woff2"}, {"ttf", "font/ttf"}, {"otf", "font/otf"},
            {"eot", "application/vnd.ms-fontobject"}
        };
        for (String[] p : t) TYPES.put(p[0], p[1]);
    }

    private final AssetManager assets;
    private volatile PackSource pack;

    PackServer(AssetManager assets) { this.assets = assets; }

    void setPack(PackSource source) { this.pack = source; }

    WebResourceResponse handle(WebResourceRequest req) {
        Uri u = req.getUrl();
        String host = u.getHost();
        if (host == null) return null;
        String path = u.getPath() == null ? "/" : u.getPath();

        if (HOST.equals(host) && u.getPort() == PORT) {
            if (path.equals("/pack") || path.startsWith("/pack/")) {
                return servePack(req, path.substring(5), u.getQueryParameter("list") != null);
            }
            if (path.startsWith("/__setup/")) return serveAsset("setup/" + path.substring(9), false);
            return serveAsset("web" + (path.equals("/") ? "/index.html" : path), true);
        }
        // Old external URLs inside Flash files (Electron redirected these on desktop)
        if (host.endsWith("mspaintadventures.com")) return servePack(req, path, false);
        return null; // anything else goes to the real network
    }

    // ---------- APK assets ----------

    private WebResourceResponse serveAsset(String assetPath, boolean spaFallback) {
        try {
            return ok(mime(assetPath), assets.open(assetPath), -1, null);
        } catch (IOException missing) {
            String last = assetPath.substring(assetPath.lastIndexOf('/') + 1);
            if (spaFallback && !last.contains(".")) {
                try { return ok("text/html", assets.open("web/index.html"), -1, null); } catch (IOException ignored) { }
            }
            return status(404, "Not Found");
        }
    }

    // ---------- asset pack ----------

    private WebResourceResponse servePack(WebResourceRequest req, String rel, boolean list) {
        PackSource src = pack;
        if (src == null) return status(404, "Not Found");
        String r = PackSource.clean(rel);
        if (r == null) return status(403, "Forbidden");
        String kind = src.kind(r);
        if (kind == null) return status(404, "Not Found");

        boolean head = "HEAD".equalsIgnoreCase(req.getMethod());
        if (PackSource.KIND_DIR.equals(kind)) {
            if (head) return withHeaders(status(200, "OK"), "X-UHC-Kind", "dir");
            if (list) return listing(src.list(r));
            return status(404, "Not Found");
        }

        long size = src.size(r);
        Map<String, String> h = baseHeaders();
        h.put("X-UHC-Kind", "file");
        h.put("Accept-Ranges", "bytes");
        String type = mime(r);
        if (head) {
            h.put("Content-Length", String.valueOf(size));
            return new WebResourceResponse(type, null, 200, "OK", h, new ByteArrayInputStream(new byte[0]));
        }
        try {
            String range = header(req, "Range");
            Matcher m = range == null ? null : RANGE.matcher(range);
            if (m != null && m.find() && size > 0) {
                long start, end;
                if (m.group(1).isEmpty()) {           // bytes=-N (last N bytes)
                    start = Math.max(0, size - Long.parseLong(m.group(2)));
                    end = size - 1;
                } else {
                    start = Long.parseLong(m.group(1));
                    end = m.group(2).isEmpty() ? size - 1 : Math.min(Long.parseLong(m.group(2)), size - 1);
                }
                if (start > end || start >= size) {
                    h.put("Content-Range", "bytes */" + size);
                    return new WebResourceResponse(type, null, 416, "Range Not Satisfiable", h, new ByteArrayInputStream(new byte[0]));
                }
                long len = end - start + 1;
                h.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
                h.put("Content-Length", String.valueOf(len));
                return new WebResourceResponse(type, null, 206, "Partial Content", h, src.open(r, start, len));
            }
            return ok(type, src.open(r, 0, -1), size, h);
        } catch (IOException e) {
            return status(500, "Internal Server Error");
        }
    }

    private WebResourceResponse listing(Map<String, Boolean> kids) {
        JSONArray arr = new JSONArray();
        if (kids != null) {
            try {
                for (Map.Entry<String, Boolean> k : new java.util.TreeMap<>(kids).entrySet()) {
                    arr.put(new JSONObject().put("name", k.getKey()).put("dir", k.getValue()));
                }
            } catch (Exception ignored) { }
        }
        byte[] body = arr.toString().getBytes(StandardCharsets.UTF_8);
        return ok("application/json", new ByteArrayInputStream(body), body.length, null);
    }

    // ---------- helpers ----------

    private static Map<String, String> baseHeaders() {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        return h;
    }

    private static WebResourceResponse ok(String type, InputStream in, long length, Map<String, String> headers) {
        Map<String, String> h = headers != null ? headers : baseHeaders();
        if (length >= 0) h.put("Content-Length", String.valueOf(length));
        String enc = type.startsWith("text/") || type.endsWith("json") || type.endsWith("javascript") ? "utf-8" : null;
        return new WebResourceResponse(type, enc, 200, "OK", h, in);
    }

    private static WebResourceResponse status(int code, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason, baseHeaders(), new ByteArrayInputStream(new byte[0]));
    }

    private static WebResourceResponse withHeaders(WebResourceResponse r, String k, String v) {
        Map<String, String> h = new HashMap<>(r.getResponseHeaders());
        h.put(k, v);
        r.setResponseHeaders(h);
        return r;
    }

    private static String header(WebResourceRequest req, String name) {
        Map<String, String> h = req.getRequestHeaders();
        if (h == null) return null;
        for (Map.Entry<String, String> e : h.entrySet()) if (e.getKey().equalsIgnoreCase(name)) return e.getValue();
        return null;
    }

    static String mime(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
        String t = TYPES.get(ext);
        return t != null ? t : "application/octet-stream";
    }

    private static void skipFully(InputStream in, long n) throws IOException {
        while (n > 0) {
            long s = in.skip(n);
            if (s <= 0) throw new IOException("skip failed");
            n -= s;
        }
    }

    /** Reads at most {@code remaining} bytes from the wrapped stream. */
    private static final class Bounded extends FilterInputStream {
        private long remaining;
        Bounded(InputStream in, long len) { super(in); remaining = len; }
        @Override public int read() throws IOException {
            if (remaining <= 0) return -1;
            int b = super.read();
            if (b >= 0) remaining--;
            return b;
        }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (remaining <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, remaining));
            if (n > 0) remaining -= n;
            return n;
        }
        @Override public int available() throws IOException { return (int) Math.min(super.available(), remaining); }
    }
}
