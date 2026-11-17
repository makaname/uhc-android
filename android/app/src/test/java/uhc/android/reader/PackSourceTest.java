package uhc.android.reader;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public class PackSourceTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    /** A tiny pack: the two files looksLikePack() wants, a hidden file and an empty folder. */
    static Map<String, byte[]> sampleFiles() {
        Map<String, byte[]> m = new LinkedHashMap<>();
        m.put("archive/data/mspa.json", "{\"story\":{}}".getBytes(StandardCharsets.UTF_8));
        m.put("storyfiles/hs2/00001.gif", bytes(1000));
        m.put("archive/imods/_hqAudio.js", "module.exports = {}".getBytes(StandardCharsets.UTF_8));
        m.put("storyfiles/hs2/.nomedia", new byte[0]);
        return m;
    }

    static byte[] bytes(int n) {
        byte[] b = new byte[n];
        for (int i = 0; i < n; i++) b[i] = (byte) (i * 7 + 3);
        return b;
    }

    static byte[] read(InputStream in) throws IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[333];
            int n;
            while ((n = s.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    static byte[] slice(byte[] b, int start, int len) {
        byte[] r = new byte[len];
        System.arraycopy(b, start, r, 0, len);
        return r;
    }

    File folderPack() throws IOException {
        File root = tmp.newFolder("Asset Pack V2");
        for (Map.Entry<String, byte[]> e : sampleFiles().entrySet()) {
            File f = new File(root, e.getKey());
            f.getParentFile().mkdirs();
            Files.write(f.toPath(), e.getValue());
        }
        new File(root, "mods").mkdirs();
        return root;
    }

    /** Zip written by java.util.zip; {@code stored} picks STORED (like the real pack) or DEFLATED. */
    File zipPack(boolean stored, String prefix) throws IOException {
        File f = tmp.newFile();
        try (ZipOutputStream z = new ZipOutputStream(new FileOutputStream(f))) {
            z.putNextEntry(new ZipEntry(prefix + "mods/"));
            z.closeEntry();
            for (Map.Entry<String, byte[]> e : sampleFiles().entrySet()) {
                ZipEntry ze = new ZipEntry(prefix + e.getKey());
                if (stored) {
                    CRC32 crc = new CRC32();
                    crc.update(e.getValue());
                    ze.setMethod(ZipEntry.STORED);
                    ze.setSize(e.getValue().length);
                    ze.setCompressedSize(e.getValue().length);
                    ze.setCrc(crc.getValue());
                }
                z.putNextEntry(ze);
                z.write(e.getValue());
                z.closeEntry();
            }
        }
        File named = new File(f.getParentFile(), f.getName() + ".zip");
        assertTrue(f.renameTo(named));
        return named;
    }

    void checkPack(PackSource p) throws IOException {
        assertNotNull(p);
        assertTrue(p.looksLikePack());
        assertEquals(PackSource.KIND_FILE, p.kind("archive/data/mspa.json"));
        assertEquals(PackSource.KIND_DIR, p.kind("archive/data"));
        assertEquals(PackSource.KIND_DIR, p.kind(""));
        assertEquals(PackSource.KIND_DIR, p.kind("mods"));          // empty folder still exists
        assertNull(p.kind("archive/nope.json"));
        assertNull(p.kind("../etc/passwd"));
        assertEquals(1000, p.size("storyfiles/hs2/00001.gif"));
        assertEquals(3, p.countFiles());                              // hidden .nomedia not counted

        Map<String, Boolean> root = p.list("");
        assertEquals(Boolean.TRUE, root.get("archive"));
        assertEquals(Boolean.TRUE, root.get("storyfiles"));
        assertEquals(Boolean.FALSE, p.list("archive/imods").get("_hqAudio.js"));
        assertNull(p.list("archive/data/mspa.json"));

        byte[] gif = sampleFiles().get("storyfiles/hs2/00001.gif");
        assertArrayEquals(gif, read(p.open("storyfiles/hs2/00001.gif", 0, -1)));
        assertArrayEquals(slice(gif, 100, 50), read(p.open("storyfiles/hs2/00001.gif", 100, 50)));
        assertArrayEquals(slice(gif, 990, 10), read(p.open("storyfiles/hs2/00001.gif", 990, -1)));
        assertArrayEquals(slice(gif, 990, 10), read(p.open("storyfiles/hs2/00001.gif", 990, 500)));
        assertTrue(p.stillValid());
    }

    @Test public void folder() throws IOException {
        checkPack(PackSource.open(folderPack()));
    }

    @Test public void storedZip() throws IOException {
        checkPack(PackSource.open(zipPack(true, "")));
    }

    @Test public void deflatedZip() throws IOException {
        checkPack(PackSource.open(zipPack(false, "")));
    }

    @Test public void zipOfTheParentFolderIsUnwrapped() throws IOException {
        checkPack(PackSource.open(zipPack(true, "Asset Pack V2/")));
    }

    @Test public void zip64() throws IOException {
        File f = new File(tmp.getRoot(), "z64.zip");
        Map<String, byte[]> files = new LinkedHashMap<>();
        files.put("mods/", new byte[0]);              // folder entry
        files.putAll(sampleFiles());
        Zip64Writer.write(f, files);
        checkPack(PackSource.open(f));
    }

    @Test public void truncatedZipIsRejected() throws IOException {
        File f = zipPack(true, "");
        try (RandomAccessFile raf = new RandomAccessFile(f, "rw")) {
            raf.setLength(raf.length() / 2);          // still copying
        }
        assertNull(PackSource.open(f));
    }

    @Test public void notAZip() throws IOException {
        File f = tmp.newFile("junk.zip");
        Files.write(f.toPath(), bytes(5000));
        assertNull(PackSource.open(f));
        assertNull(PackSource.open(tmp.newFile("pack.txt")));
        assertNull(PackSource.open(new File(tmp.getRoot(), "missing")));
    }

    @Test public void replacedZipIsNoLongerValid() throws IOException {
        File f = zipPack(true, "");
        PackSource p = PackSource.open(f);
        assertTrue(p.stillValid());
        try (RandomAccessFile raf = new RandomAccessFile(f, "rw")) {
            raf.setLength(raf.length() + 10);
        }
        assertFalse(p.stillValid());
        p.close();   // the zip keeps its file open; Windows can't delete an open file
        assertTrue(f.delete());
        assertFalse(p.stillValid());
    }

    /** The Android path: a picked file arrives as an open channel, not a path. */
    @Test public void zipFromOpenChannel() throws IOException {
        File f = zipPack(true, "");
        RandomAccessFile raf = new RandomAccessFile(f, "r");
        PackSource p = PackSource.openZip(raf.getChannel(), "picked.zip", () -> true, raf);
        checkPack(p);
        assertEquals("picked.zip", p.describe());
        p.close();
        assertFalse(raf.getChannel().isOpen());
        assertFalse(p.stillValid());
    }

    @Test public void incompleteZipFromChannelClosesIt() throws IOException {
        File f = zipPack(true, "");
        try (RandomAccessFile raf = new RandomAccessFile(f, "rw")) {
            raf.setLength(raf.length() / 2);   // a zip that's still copying has no central directory
        }
        RandomAccessFile raf = new RandomAccessFile(f, "r");
        assertNull(PackSource.openZip(raf.getChannel(), "partial.zip", () -> true, raf));
        assertFalse(raf.getChannel().isOpen());
    }

    /** Pages load many files at once; the shared channel must serve them concurrently. */
    @Test public void concurrentReads() throws Exception {
        File f = zipPack(true, "");
        PackSource p = PackSource.open(f);
        String[] names = {"archive/data/mspa.json", "storyfiles/hs2/00001.gif"};
        byte[][] expected = new byte[names.length][];
        for (int i = 0; i < names.length; i++) expected[i] = readAll(p.open(names[i], 0, -1));
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(8);
        java.util.List<java.util.concurrent.Future<Boolean>> results = new java.util.ArrayList<>();
        for (int k = 0; k < 200; k++) {
            int i = k % names.length;
            results.add(pool.submit(() -> java.util.Arrays.equals(expected[i], readAll(p.open(names[i], 0, -1)))));
        }
        for (java.util.concurrent.Future<Boolean> r : results) assertTrue(r.get());
        pool.shutdown();
        p.close();
    }

    private static byte[] readAll(java.io.InputStream in) throws IOException {
        try (in) { return in.readAllBytes(); }
    }

    @Test public void clean() {
        assertEquals("a/b", PackSource.clean("/a/b/"));
        assertEquals("a/b", PackSource.clean("a\\b"));
        assertEquals("", PackSource.clean(null));
        assertNull(PackSource.clean("a/../../b"));
    }

    /** Writes a STORED zip in zip64 form (sizes and offsets in the zip64 extra field), like a 4.4 GB pack. */
    static final class Zip64Writer {
        static void write(File f, Map<String, byte[]> files) throws IOException {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            ByteArrayOutputStream cd = new ByteArrayOutputStream();
            int count = 0;
            for (Map.Entry<String, byte[]> e : files.entrySet()) {
                byte[] name = e.getKey().getBytes(StandardCharsets.UTF_8);
                byte[] data = e.getValue();
                CRC32 crc = new CRC32();
                crc.update(data);
                long local = out.size();
                // local header (sizes given plainly; readers use the central directory)
                le(out, 0x04034b50L, 4); le(out, 45, 2); le(out, 0, 2); le(out, 0, 2); le(out, 0, 4);
                le(out, crc.getValue(), 4); le(out, data.length, 4); le(out, data.length, 4);
                le(out, name.length, 2); le(out, 0, 2); out.write(name);
                out.write(data);
                // central directory entry with every 32-bit field pushed into the zip64 extra
                le(cd, 0x02014b50L, 4); le(cd, 45, 2); le(cd, 45, 2); le(cd, 0, 2); le(cd, 0, 2); le(cd, 0, 4);
                le(cd, crc.getValue(), 4); le(cd, 0xFFFFFFFFL, 4); le(cd, 0xFFFFFFFFL, 4);
                le(cd, name.length, 2); le(cd, 28, 2); le(cd, 0, 2); le(cd, 0, 2); le(cd, 0, 2); le(cd, 0, 4);
                le(cd, 0xFFFFFFFFL, 4); cd.write(name);
                le(cd, 0x0001, 2); le(cd, 24, 2); le(cd, data.length, 8); le(cd, data.length, 8); le(cd, local, 8);
                count++;
            }
            long cdOffset = out.size();
            out.write(cd.toByteArray());
            long z64 = out.size();
            le(out, 0x06064b50L, 4); le(out, 44, 8); le(out, 45, 2); le(out, 45, 2); le(out, 0, 4); le(out, 0, 4);
            le(out, count, 8); le(out, count, 8); le(out, cd.size(), 8); le(out, cdOffset, 8);
            le(out, 0x07064b50L, 4); le(out, 0, 4); le(out, z64, 8); le(out, 1, 4);
            le(out, 0x06054b50L, 4); le(out, 0, 2); le(out, 0, 2); le(out, 0xFFFF, 2); le(out, 0xFFFF, 2);
            le(out, 0xFFFFFFFFL, 4); le(out, 0xFFFFFFFFL, 4); le(out, 0, 2);
            Files.write(f.toPath(), out.toByteArray());
        }

        private static void le(ByteArrayOutputStream o, long v, int n) {
            for (int i = 0; i < n; i++) o.write((int) (v >>> (8 * i)) & 0xFF);
        }
    }
}
