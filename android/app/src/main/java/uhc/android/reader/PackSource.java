package uhc.android.reader;

import java.io.BufferedInputStream;
import java.io.Closeable;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.BooleanSupplier;
import java.util.zip.Inflater;
import java.util.zip.InflaterInputStream;

/**
 * Where the asset pack lives: either an unpacked folder, or a single .zip that is read in place
 * (no unpacking; entries are located through the zip's central directory).
 *
 * Paths are pack-relative with "/" separators, e.g. "archive/data/mspa.json"; "" is the root.
 */
abstract class PackSource {
    static final String KIND_FILE = "file", KIND_DIR = "dir";

    /** "file", "dir", or null if missing. */
    abstract String kind(String rel);
    abstract long size(String rel);
    /** Children of a folder as name -> isDirectory, or null if it isn't a folder. */
    abstract Map<String, Boolean> list(String rel);
    /** Opens a file at {@code start}; {@code len} < 0 reads to the end. */
    abstract InputStream open(String rel, long start, long len) throws IOException;
    /** Regular (non-hidden) files in the pack, for the completeness check. */
    abstract int countFiles();
    abstract String describe();
    /** False once the pack was moved, deleted or replaced since it was opened. */
    abstract boolean stillValid();
    /** Releases open file handles; the source must not be used afterwards. */
    void close() { }

    boolean looksLikePack() {
        return KIND_FILE.equals(kind("archive/data/mspa.json")) && KIND_FILE.equals(kind("storyfiles/hs2/00001.gif"));
    }

    /** Opens a folder or a .zip; returns null if it isn't readable as either. */
    static PackSource open(File f) {
        if (f == null || !f.exists()) return null;
        if (f.isDirectory()) return new Folder(f);
        if (f.getName().toLowerCase(java.util.Locale.ROOT).endsWith(".zip")) {
            try { return Zip.of(f); } catch (IOException | RuntimeException e) { return null; }
        }
        return null;
    }

    /**
     * Opens a zip pack from an already-open channel (on Android: a file the user picked, via a
     * ParcelFileDescriptor). {@code owner} is closed with the source. Returns null if it isn't a
     * complete, readable zip; {@code owner} is then closed too.
     */
    static PackSource openZip(FileChannel channel, String description, BooleanSupplier stillValid, Closeable owner) {
        try {
            return new Zip(channel, description, stillValid, owner);
        } catch (IOException | RuntimeException e) {
            closeQuietly(owner);
            return null;
        }
    }

    static void closeQuietly(Closeable c) {
        if (c == null) return;
        try { c.close(); } catch (IOException ignored) { /* nothing more to do */ }
    }

    static String clean(String rel) {
        if (rel == null) return "";
        String r = rel.replace('\\', '/');
        while (r.startsWith("/")) r = r.substring(1);
        while (r.endsWith("/")) r = r.substring(0, r.length() - 1);
        for (String part : r.split("/")) if (part.equals("..")) return null;
        return r;
    }

    // ---------------------------------------------------------------------------------------------

    static final class Folder extends PackSource {
        final File root;
        Folder(File root) { this.root = root; }

        private File file(String rel) {
            String r = clean(rel);
            return r == null ? null : (r.isEmpty() ? root : new File(root, r));
        }
        @Override String kind(String rel) {
            File f = file(rel);
            if (f == null || !f.exists()) return null;
            return f.isDirectory() ? KIND_DIR : KIND_FILE;
        }
        @Override long size(String rel) { File f = file(rel); return f == null ? 0 : f.length(); }
        @Override Map<String, Boolean> list(String rel) {
            File f = file(rel);
            File[] kids = f == null ? null : f.listFiles();
            if (kids == null) return null;
            Map<String, Boolean> out = new TreeMap<>();
            for (File k : kids) out.put(k.getName(), k.isDirectory());
            return out;
        }
        @Override InputStream open(String rel, long start, long len) throws IOException {
            File f = file(rel);
            if (f == null) throw new IOException("bad path");
            FileInputStream in = new FileInputStream(f);
            try {
                if (start > 0) in.getChannel().position(start);
            } catch (IOException e) {
                in.close();
                throw e;
            }
            return buffered(len < 0 ? in : new Bounded(in, len));
        }
        @Override int countFiles() {
            int n = 0;
            java.util.ArrayDeque<File> stack = new java.util.ArrayDeque<>();
            stack.push(root);
            while (!stack.isEmpty()) {
                File[] kids = stack.pop().listFiles();
                if (kids == null) continue;
                for (File k : kids) {
                    if (k.getName().startsWith(".")) continue;
                    if (k.isDirectory()) stack.push(k); else n++;
                }
            }
            return n;
        }
        @Override String describe() { return root.getAbsolutePath(); }
        @Override boolean stillValid() { return new File(root, "archive/data/mspa.json").isFile(); }
    }

    // ---------------------------------------------------------------------------------------------

    /** Minimal read-only zip reader (zip64 aware; stored and deflated entries). */
    static final class Zip extends PackSource {
        private static final class Entry {
            final int method; final long compSize, size, localHeader;
            volatile long dataStart = -1;
            Entry(int method, long compSize, long size, long localHeader) {
                this.method = method; this.compSize = compSize; this.size = size; this.localHeader = localHeader;
            }
        }

        /** One channel for the life of the source; positional reads are safe across threads. */
        private final FileChannel ch;
        private final String description;
        private final BooleanSupplier valid;
        private final Closeable owner;
        private final Map<String, Entry> files = new HashMap<>();
        private final Map<String, Map<String, Boolean>> dirs = new HashMap<>();
        private int visibleFiles = 0;

        /** Opens a zip file by path (tests, the PC harness, and anything with direct file access). */
        static Zip of(File file) throws IOException {
            RandomAccessFile raf = new RandomAccessFile(file, "r");
            long length = file.length(), modified = file.lastModified();
            try {
                return new Zip(raf.getChannel(), file.getAbsolutePath(),
                    () -> file.isFile() && file.length() == length && file.lastModified() == modified, raf);
            } catch (IOException | RuntimeException e) {
                raf.close();
                throw e;
            }
        }

        Zip(FileChannel ch, String description, BooleanSupplier valid, Closeable owner) throws IOException {
            this.ch = ch;
            this.description = description;
            this.valid = valid;
            this.owner = owner;
            Map<String, Entry> raw = new HashMap<>();
            List<String> emptyDirs = new ArrayList<>();   // folder entries, so empty folders still exist
            {
                long len = ch.size();
                // End of central directory record: within the last 64 KiB + 22 bytes.
                int tail = (int) Math.min(len, 65557);
                byte[] buf = new byte[tail];
                readFully(len - tail, buf);
                int eocd = -1;
                for (int i = tail - 22; i >= 0; i--) {
                    if (u32(buf, i) == 0x06054b50L) { eocd = i; break; }
                }
                if (eocd < 0) throw new IOException("Not a complete zip (no end record) - still copying?");
                long count = u16(buf, eocd + 10);
                long cdSize = u32(buf, eocd + 12);
                long cdOffset = u32(buf, eocd + 16);
                if (count == 0xFFFF || cdSize == 0xFFFFFFFFL || cdOffset == 0xFFFFFFFFL) {
                    // Zip64: a locator sits 20 bytes before the end record.
                    int loc = eocd - 20;
                    if (loc < 0 || u32(buf, loc) != 0x07064b50L) throw new IOException("Missing zip64 locator");
                    long z64 = u64(buf, loc + 8);
                    byte[] h = new byte[56];
                    readFully(z64, h);
                    if (u32(h, 0) != 0x06064b50L) throw new IOException("Bad zip64 end record");
                    count = u64(h, 32);
                    cdSize = u64(h, 40);
                    cdOffset = u64(h, 48);
                }
                if (cdSize > 64L * 1024 * 1024) throw new IOException("Central directory too large");
                byte[] cd = new byte[(int) cdSize];
                readFully(cdOffset, cd);

                int p = 0;
                for (long i = 0; i < count; i++) {
                    if (p + 46 > cd.length || u32(cd, p) != 0x02014b50L) throw new IOException("Bad central directory");
                    int method = (int) u16(cd, p + 10);
                    long comp = u32(cd, p + 20), size = u32(cd, p + 24);
                    int nameLen = (int) u16(cd, p + 28), extraLen = (int) u16(cd, p + 30), commentLen = (int) u16(cd, p + 32);
                    long local = u32(cd, p + 42);
                    String name = new String(cd, p + 46, nameLen, StandardCharsets.UTF_8).replace('\\', '/');
                    // Zip64 extra field carries the real values for any field set to 0xFFFFFFFF.
                    int e = p + 46 + nameLen, eEnd = e + extraLen;
                    while (e + 4 <= eEnd) {
                        int id = (int) u16(cd, e), sz = (int) u16(cd, e + 2);
                        if (id == 0x0001) {
                            int q = e + 4;
                            if (size == 0xFFFFFFFFL) { size = u64(cd, q); q += 8; }
                            if (comp == 0xFFFFFFFFL) { comp = u64(cd, q); q += 8; }
                            if (local == 0xFFFFFFFFL) { local = u64(cd, q); }
                        }
                        e += 4 + sz;
                    }
                    if (name.endsWith("/")) emptyDirs.add(name.substring(0, name.length() - 1));
                    else raw.put(name, new Entry(method, comp, size, local));
                    p += 46 + nameLen + extraLen + commentLen;
                }
            }

            // Packs zipped from the parent folder have everything under "Asset Pack V2/"; strip that.
            String prefix = "";
            if (!raw.containsKey("archive/data/mspa.json")) {
                for (String n : raw.keySet()) {
                    if (n.endsWith("/archive/data/mspa.json")) { prefix = n.substring(0, n.length() - "archive/data/mspa.json".length()); break; }
                }
            }
            dirs.put("", new TreeMap<>());
            for (String d : emptyDirs) {
                if (!d.startsWith(prefix)) continue;
                String n = d.substring(prefix.length());
                if (!n.isEmpty()) register(n, true);
            }
            for (Map.Entry<String, Entry> me : raw.entrySet()) {
                String n = me.getKey();
                if (!n.startsWith(prefix)) continue;
                n = n.substring(prefix.length());
                if (n.isEmpty()) continue;
                files.put(n, me.getValue());
                String base = n.substring(n.lastIndexOf('/') + 1);
                if (!base.startsWith(".")) visibleFiles++;
                register(n, false);
            }
        }

        /** Adds a path to its parent's listing, creating parent folders as needed. */
        private void register(String path, boolean pathIsDir) {
            if (pathIsDir && !dirs.containsKey(path)) dirs.put(path, new TreeMap<>());
            String child = path;
            boolean isDir = pathIsDir;
            while (true) {
                int slash = child.lastIndexOf('/');
                String parent = slash < 0 ? "" : child.substring(0, slash);
                String leaf = child.substring(slash + 1);
                Map<String, Boolean> kids = dirs.get(parent);
                boolean newParent = kids == null;
                if (newParent) { kids = new TreeMap<>(); dirs.put(parent, kids); }
                kids.put(leaf, isDir);
                if (!newParent || parent.isEmpty()) break;
                child = parent;
                isDir = true;
            }
        }

        @Override String kind(String rel) {
            String r = clean(rel);
            if (r == null) return null;
            if (files.containsKey(r)) return KIND_FILE;
            return dirs.containsKey(r) ? KIND_DIR : null;
        }
        @Override long size(String rel) { Entry e = files.get(clean(rel)); return e == null ? 0 : e.size; }
        @Override Map<String, Boolean> list(String rel) {
            Map<String, Boolean> d = dirs.get(clean(rel));
            return d == null ? null : Collections.unmodifiableMap(d);
        }
        @Override int countFiles() { return visibleFiles; }
        @Override String describe() { return description; }
        @Override boolean stillValid() { return ch.isOpen() && valid.getAsBoolean(); }
        @Override void close() { closeQuietly(owner); }

        /** Reads exactly {@code b.length} bytes at {@code pos}, without moving any shared position. */
        private void readFully(long pos, byte[] b) throws IOException {
            ByteBuffer bb = ByteBuffer.wrap(b);
            while (bb.hasRemaining()) {
                int n = ch.read(bb, pos + bb.position());
                if (n < 0) throw new EOFException("zip ends early");
            }
        }

        @Override InputStream open(String rel, long start, long len) throws IOException {
            Entry e = files.get(clean(rel));
            if (e == null) throw new IOException("missing " + rel);
            long data = dataStart(e);
            if (start < 0 || start > e.size) throw new IOException("bad offset");
            if (e.method == 0) {
                long n = len < 0 ? e.size - start : Math.min(len, e.size - start);
                return buffered(new Bounded(new ChannelStream(ch, data + start), Math.max(0, n)));
            }
            if (e.method != 8) throw new IOException("Unsupported compression in zip: " + e.method);
            InputStream in = new InflaterInputStream(new Bounded(new ChannelStream(ch, data), e.compSize), new Inflater(true), 64 * 1024);
            long skip = start;
            while (skip > 0) {
                long s = in.skip(skip);
                if (s <= 0) break;
                skip -= s;
            }
            return buffered(len < 0 ? in : new Bounded(in, len));
        }

        private long dataStart(Entry e) throws IOException {
            if (e.dataStart >= 0) return e.dataStart;
            byte[] h = new byte[30];
            readFully(e.localHeader, h);
            if (u32(h, 0) != 0x04034b50L) throw new IOException("Bad local header");
            e.dataStart = e.localHeader + 30 + u16(h, 26) + u16(h, 28);
            return e.dataStart;
        }

        private static long u16(byte[] b, int i) { return (b[i] & 0xFF) | ((b[i + 1] & 0xFF) << 8); }
        private static long u32(byte[] b, int i) { return u16(b, i) | (u16(b, i + 2) << 16); }
        private static long u64(byte[] b, int i) { return u32(b, i) | (u32(b, i + 4) << 32); }
    }

    // ---------------------------------------------------------------------------------------------

    /**
     * InputStream over a shared channel from a fixed offset. It keeps its own position and uses
     * positional reads, so many can read the same zip at once; closing it leaves the channel open.
     */
    private static final class ChannelStream extends InputStream {
        private final FileChannel ch;
        private long pos;
        ChannelStream(FileChannel ch, long pos) { this.ch = ch; this.pos = pos; }
        @Override public int read() throws IOException {
            byte[] one = new byte[1];
            return read(one, 0, 1) < 0 ? -1 : one[0] & 0xFF;
        }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) return 0;
            int n = ch.read(ByteBuffer.wrap(b, off, len), pos);
            if (n > 0) pos += n;
            return n;
        }
        @Override public long skip(long n) { pos += n; return n; }
    }

    /** Reads at most {@code remaining} bytes from the wrapped stream. */
    /**
     * The WebView pulls intercepted responses in small reads; a 64 KiB buffer turns those into few
     * file reads (mspa.json, 10 MB, loads in about half the time).
     */
    static InputStream buffered(InputStream in) {
        return new BufferedInputStream(in, 64 * 1024);
    }

    static final class Bounded extends FilterInputStream {
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
        @Override public long skip(long n) throws IOException {
            long s = super.skip(Math.min(n, remaining));
            if (s > 0) remaining -= s;
            return s;
        }
        @Override public int available() throws IOException { return (int) Math.min(super.available(), remaining); }
    }
}
