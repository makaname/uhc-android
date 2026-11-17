package uhc.android.reader;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.json.JSONArray;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;

public class PackServerTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private PackServer server;
    private final Map<String, String> apkAssets = new HashMap<>();
    private static final String H = PackServer.HOST;
    private static final int P = PackServer.PORT;
    private static final byte[] GIF = PackSourceTest.bytes(1000);

    @Before public void setUp() throws IOException {
        apkAssets.put("web/index.html", "<html>app</html>");
        apkAssets.put("web/js/app.js", "console.log(1)");
        apkAssets.put("setup/index.html", "<html>setup</html>");
        server = new PackServer(path -> {
            String s = apkAssets.get(path);
            if (s == null) throw new FileNotFoundException(path);
            return new ByteArrayInputStream(s.getBytes(StandardCharsets.UTF_8));
        });
        File root = tmp.newFolder("pack");
        for (Map.Entry<String, byte[]> e : PackSourceTest.sampleFiles().entrySet()) {
            File f = new File(root, e.getKey());
            f.getParentFile().mkdirs();
            Files.write(f.toPath(), e.getValue());
        }
        server.setPack(PackSource.open(root));
    }

    private PackServer.Reply get(String path) {
        return server.route("GET", H, P, path, false, null);
    }

    private static String text(PackServer.Reply r) throws IOException {
        return new String(PackSourceTest.read(r.body), StandardCharsets.UTF_8);
    }

    @Test public void bundleAndSpaFallback() throws IOException {
        assertEquals("<html>app</html>", text(get("/")));
        PackServer.Reply js = get("/js/app.js");
        assertEquals("text/javascript", js.mime);
        assertEquals("utf-8", js.encoding());
        assertEquals("<html>app</html>", text(get("/homestuck/413")));   // router path
        assertEquals(404, get("/js/missing.js").status);                  // a file is never the SPA
        assertEquals("<html>setup</html>", text(get("/__setup/index.html")));
        assertEquals(403, get("/../setup/index.html").status);
    }

    @Test public void packFiles() throws IOException {
        PackServer.Reply r = get("/pack/storyfiles/hs2/00001.gif");
        assertEquals(200, r.status);
        assertEquals("image/gif", r.mime);
        assertNull(r.encoding());
        assertEquals("1000", r.headers.get("Content-Length"));
        assertEquals("file", r.headers.get("X-UHC-Kind"));
        assertArrayEquals(GIF, PackSourceTest.read(r.body));
        assertEquals(404, get("/pack/storyfiles/hs2/99999.gif").status);
        assertEquals(403, get("/pack/../secret").status);
        assertEquals(404, get("/pack/archive").status);                    // folders need ?list=1
    }

    @Test public void head() {
        PackServer.Reply f = server.route("HEAD", H, P, "/pack/storyfiles/hs2/00001.gif", false, null);
        assertEquals(200, f.status);
        assertEquals("file", f.headers.get("X-UHC-Kind"));
        assertEquals("1000", f.headers.get("Content-Length"));
        PackServer.Reply d = server.route("HEAD", H, P, "/pack/archive/imods", false, null);
        assertEquals(200, d.status);
        assertEquals("dir", d.headers.get("X-UHC-Kind"));
        assertEquals(404, server.route("HEAD", H, P, "/pack/nope", false, null).status);
    }

    @Test public void listing() throws Exception {
        PackServer.Reply r = server.route("GET", H, P, "/pack/archive/", true, null);
        assertEquals("application/json", r.mime);
        JSONArray a = new JSONArray(text(r));
        assertEquals(2, a.length());
        assertEquals("data", a.getJSONObject(0).getString("name"));
        assertEquals(true, a.getJSONObject(0).getBoolean("dir"));
    }

    @Test public void ranges() throws IOException {
        PackServer.Reply r = server.route("GET", H, P, "/pack/storyfiles/hs2/00001.gif", false, "bytes=10-19");
        assertEquals(206, r.status);
        assertEquals("bytes 10-19/1000", r.headers.get("Content-Range"));
        assertEquals("10", r.headers.get("Content-Length"));
        assertArrayEquals(PackSourceTest.slice(GIF, 10, 10), PackSourceTest.read(r.body));

        r = server.route("GET", H, P, "/pack/storyfiles/hs2/00001.gif", false, "bytes=-5");
        assertEquals("bytes 995-999/1000", r.headers.get("Content-Range"));
        assertArrayEquals(PackSourceTest.slice(GIF, 995, 5), PackSourceTest.read(r.body));

        r = server.route("GET", H, P, "/pack/storyfiles/hs2/00001.gif", false, "bytes=900-");
        assertEquals("bytes 900-999/1000", r.headers.get("Content-Range"));

        r = server.route("GET", H, P, "/pack/storyfiles/hs2/00001.gif", false, "bytes=0-99999");
        assertEquals("bytes 0-999/1000", r.headers.get("Content-Range"));

        r = server.route("GET", H, P, "/pack/storyfiles/hs2/00001.gif", false, "bytes=1000-");
        assertEquals(416, r.status);
        assertEquals("bytes */1000", r.headers.get("Content-Range"));
    }

    @Test public void parseRange() {
        assertNull(PackServer.parseRange(null, 10));
        assertNull(PackServer.parseRange("items=0-1", 10));
        assertNull(PackServer.parseRange("bytes=-", 10));
        assertNull(PackServer.parseRange("bytes=5-2", 10));                // invalid: whole file
        assertArrayEquals(new long[]{0, 1}, PackServer.parseRange("bytes=0-1, 4-5", 10));
        assertArrayEquals(new long[0], PackServer.parseRange("bytes=-0", 10));
        assertArrayEquals(new long[0], PackServer.parseRange("bytes=0-", 0));
        assertArrayEquals(new long[0], PackServer.parseRange("bytes=99999999999999999999-", 10));  // no crash
        assertArrayEquals(new long[]{0, 9}, PackServer.parseRange("bytes=-99999999", 10));
    }

    @Test public void oldMspaUrlsMapIntoThePack() throws IOException {
        PackServer.Reply r = server.route("GET", "www.mspaintadventures.com", 80, "/storyfiles/hs2/00001.gif", false, null);
        assertEquals(200, r.status);
        r = server.route("GET", "cdn.mspaintadventures.com", 80, "/Sfiles/storyfiles/hs2/00001.gif", false, null);
        assertEquals(200, r.status);
        // Anything else that isn't ours is refused, not sent to the network.
        assertEquals(403, server.route("GET", "example.com", 443, "/", false, null).status);
        assertEquals(403, server.route("GET", "evilmspaintadventures.com", 80, "/", false, null).status);
        assertNull(server.route("GET", null, -1, "/", false, null));
    }

    /** Bandcamp's embedded player (UHC's Music pages) is the only thing allowed onto the network. */
    @Test public void onlyBandcampGoesToTheNetwork() {
        assertNull(server.route("GET", "bandcamp.com", 443, "/EmbeddedPlayer/size=small/track=123/", false, null));
        assertNull(server.route("GET", "homestuck.bandcamp.com", 443, "/track/x", false, null));
        assertNull(server.route("GET", "f4.bcbits.com", 443, "/img/a1.jpg", false, null));
        assertNull(server.route("GET", "t4.bcbits.com", 443, "/stream/abc/mp3-128/1", false, null));
        assertEquals(403, server.route("GET", "notbandcamp.com", 443, "/", false, null).status);
        assertEquals(403, server.route("GET", "bandcamp.com.evil.example", 443, "/", false, null).status);
        assertEquals(403, server.route("GET", "www.google-analytics.com", 443, "/collect", false, null).status);
        assertEquals(403, server.route("GET", "fonts.googleapis.com", 443, "/css", false, null).status);
    }

    @Test public void noPackYet() {
        server.setPack(null);
        assertEquals(503, get("/pack/archive/data/mspa.json").status);
    }
}
