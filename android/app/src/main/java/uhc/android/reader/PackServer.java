package uhc.android.reader;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Answers the WebView's requests without any real network server.
 *
 *   http://127.0.0.1:8137/          the UHC bundle + shim, from APK assets/web (single-page app fallback)
 *   http://127.0.0.1:8137/pack/     the asset pack (folder or zip, via {@link PackSource})
 *   http://127.0.0.1:8137/__setup/  first-run setup page, from APK assets/setup
 *   *.mspaintadventures.com/...     old URLs inside Flash files, mapped into the pack
 *   bandcamp.com, bcbits.com        Bandcamp's embedded player: the only requests allowed onto the network
 *   anything else                   403, so nothing else leaves the phone
 *
 * /pack/ follows the same contract as tools/dev-server.mjs:
 *   HEAD -> 200 + "X-UHC-Kind: file|dir" or 404;  GET dir/?list=1 -> JSON [{name, dir}];  Range supported.
 *
 * This class is plain Java (no android.* types) so it can be unit tested on the JVM;
 * MainActivity turns a {@link Reply} into a WebResourceResponse.
 */
final class PackServer {
    static final String ORIGIN = "http://127.0.0.1:8137";
    static final String HOST = "127.0.0.1";
    static final int PORT = 8137;

    /** Opens a file from the APK's assets folder (AssetManager::open in the app). */
    interface Assets {
        InputStream open(String path) throws IOException;
    }

    /** A response: status, MIME type, headers and body. {@code body} is never null. */
    static final class Reply {
        final int status;
        final String reason;
        final String mime;
        final Map<String, String> headers;
        final InputStream body;

        Reply(int status, String reason, String mime, Map<String, String> headers, InputStream body) {
            this.status = status;
            this.reason = reason;
            this.mime = mime;
            this.headers = headers;
            this.body = body;
        }

        /** Charset to declare for text types, else null. */
        String encoding() {
            return mime.startsWith("text/") || mime.endsWith("json") || mime.endsWith("javascript") ? "utf-8" : null;
        }
    }

    private static final Pattern RANGE = Pattern.compile("^\\s*bytes\\s*=\\s*(\\d*)\\s*-\\s*(\\d*)\\s*(?:,|$)");
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

    private final Assets assets;
    private volatile PackSource pack;

    PackServer(Assets assets) {
        this.assets = assets;
    }

    void setPack(PackSource source) {
        this.pack = source;
    }

    PackSource pack() {
        return pack;
    }

    /**
     * The only hosts the app may reach over the network: Bandcamp's embedded player (UHC's Music pages
     * play songs through it) and the servers it streams from. Everything else is served locally or refused.
     */
    static boolean isAllowedRemote(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        return h.equals("bandcamp.com") || h.endsWith(".bandcamp.com")
            || h.equals("bcbits.com") || h.endsWith(".bcbits.com");
    }

    /**
     * Routes one request. Returns null only for an allowed remote host ({@link #isAllowedRemote}), so the
     * WebView fetches it from the network; anything else that isn't ours gets a 403 and never leaves the phone.
     *
     * @param path  decoded URL path, e.g. "/pack/storyfiles/hs2/00001.gif"
     * @param list  true if the query has "list" (directory listing)
     * @param range the Range header, or null
     */
    Reply route(String method, String host, int port, String path, boolean list, String range) {
        if (host == null) return null;
        if (path == null || path.isEmpty()) path = "/";
        boolean head = "HEAD".equalsIgnoreCase(method);

        if (HOST.equals(host) && port == PORT) {
            if (path.equals("/pack") || path.startsWith("/pack/")) {
                return servePack(path.substring(5), list, head, range);
            }
            if (path.startsWith("/__setup/")) return serveAsset("setup/" + path.substring(9), false);
            return serveAsset("web" + (path.equals("/") ? "/index.html" : path), true);
        }
        // Old external URLs inside Flash files (Electron redirected these on desktop)
        String h = host.toLowerCase(Locale.ROOT);
        if (h.equals("mspaintadventures.com") || h.endsWith(".mspaintadventures.com")) {
            return servePack(path.replaceFirst("^/Sfiles/", "/"), false, head, range);
        }
        if (isAllowedRemote(h)) return null;   // Bandcamp's player: let the WebView fetch it
        return status(403, "Forbidden");
    }

    // ---------- APK assets ----------

    private Reply serveAsset(String assetPath, boolean spaFallback) {
        if (PackSource.clean(assetPath) == null) return status(403, "Forbidden");
        try {
            return ok(mime(assetPath), assets.open(assetPath), -1, baseHeaders());
        } catch (IOException missing) {
            String last = assetPath.substring(assetPath.lastIndexOf('/') + 1);
            if (spaFallback && !last.contains(".")) {
                try {
                    return ok("text/html", assets.open("web/index.html"), -1, baseHeaders());
                } catch (IOException ignored) {
                    // fall through to 404
                }
            }
            return status(404, "Not Found");
        }
    }

    // ---------- asset pack ----------

    private Reply servePack(String rel, boolean list, boolean head, String range) {
        PackSource src = pack;
        if (src == null) return status(503, "No Asset Pack");
        String r = PackSource.clean(rel);
        if (r == null) return status(403, "Forbidden");
        String kind = src.kind(r);
        if (kind == null) return status(404, "Not Found");

        if (PackSource.KIND_DIR.equals(kind)) {
            if (head) {
                Reply ok = status(200, "OK");
                ok.headers.put("X-UHC-Kind", "dir");
                return ok;
            }
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
            return new Reply(200, "OK", type, h, empty());
        }
        try {
            long[] span = parseRange(range, size);
            if (span == null) return ok(type, src.open(r, 0, -1), size, h);
            if (span.length == 0) {
                h.put("Content-Range", "bytes */" + size);
                return new Reply(416, "Range Not Satisfiable", type, h, empty());
            }
            long start = span[0], end = span[1], len = end - start + 1;
            h.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
            h.put("Content-Length", String.valueOf(len));
            return new Reply(206, "Partial Content", type, h, src.open(r, start, len));
        } catch (IOException e) {
            // The pack was moved, deleted or is unreadable.
            return status(500, "Internal Server Error");
        }
    }

    /**
     * Parses a single "bytes=a-b" range against a file of {@code size} bytes.
     * Returns null to serve the whole file (no or unusable header), an empty array for 416,
     * or {start, end} inclusive.
     */
    static long[] parseRange(String header, long size) {
        if (header == null) return null;
        Matcher m = RANGE.matcher(header);
        if (!m.find()) return null;
        String a = m.group(1), b = m.group(2);
        if (a.isEmpty() && b.isEmpty()) return null;
        try {
            long start, end;
            if (a.isEmpty()) {                       // bytes=-N: the last N bytes
                long n = Long.parseLong(b);
                if (n == 0 || size == 0) return new long[0];
                start = Math.max(0, size - n);
                end = size - 1;
            } else {
                start = Long.parseLong(a);
                end = b.isEmpty() ? size - 1 : Math.min(Long.parseLong(b), size - 1);
                if (!b.isEmpty() && Long.parseLong(b) < start) return null;   // invalid: ignore it
            }
            if (start >= size || start > end) return new long[0];
            return new long[]{start, end};
        } catch (NumberFormatException tooBig) {
            return new long[0];
        }
    }

    private static Reply listing(Map<String, Boolean> kids) {
        JSONArray arr = new JSONArray();
        if (kids != null) {
            try {
                for (Map.Entry<String, Boolean> k : new java.util.TreeMap<>(kids).entrySet()) {
                    arr.put(new JSONObject().put("name", k.getKey()).put("dir", k.getValue()));
                }
            } catch (JSONException impossible) {
                // only thrown for non-finite numbers
            }
        }
        byte[] body = arr.toString().getBytes(StandardCharsets.UTF_8);
        return ok("application/json", new ByteArrayInputStream(body), body.length, baseHeaders());
    }

    // ---------- helpers ----------

    private static Map<String, String> baseHeaders() {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        return h;
    }

    private static Reply ok(String type, InputStream in, long length, Map<String, String> h) {
        if (length >= 0) h.put("Content-Length", String.valueOf(length));
        return new Reply(200, "OK", type, h, in);
    }

    static Reply status(int code, String reason) {
        return new Reply(code, reason, "text/plain", baseHeaders(), empty());
    }

    private static InputStream empty() {
        return new ByteArrayInputStream(new byte[0]);
    }

    static String mime(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
        String t = TYPES.get(ext);
        return t != null ? t : "application/octet-stream";
    }
}
