// ============================================================
// Hesper: tiny .zip reader (used by the plugin installer).
// Reads stored and deflated files, checks each file's CRC and enforces size limits
// while unpacking (so a "zip bomb" can't use up memory). Uses the browser's built-in
// DecompressionStream when it exists, otherwise a small inflate written here, so it
// also works in older WebViews and TV browsers.
// Not supported (and reported as an error): ZIP64, encrypted zips, multi-disk zips.
// ============================================================

const HesperZip = (() => {

    // ---------------- inflate (RFC 1951), after zlib's "puff" ----------------
    const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    const LEXT  = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    const DEXT  = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

    function huffman(lengths, n) {
        const count = new Uint16Array(16), symbol = new Uint16Array(n), offs = new Uint16Array(16);
        for (let i = 0; i < n; i++) count[lengths[i]]++;
        let left = 1;
        for (let len = 1; len < 16; len++) {
            left <<= 1;
            left -= count[len];
            if (left < 0) throw new Error('corrupt zip data (bad code lengths)');
        }
        for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
        for (let i = 0; i < n; i++) if (lengths[i] !== 0) symbol[offs[lengths[i]]++] = i;
        return { count, symbol };
    }

    let fixedTables = null;
    function getFixed() {
        if (fixedTables) return fixedTables;
        const l = new Uint8Array(288);
        for (let i = 0; i < 144; i++) l[i] = 8;
        for (let i = 144; i < 256; i++) l[i] = 9;
        for (let i = 256; i < 280; i++) l[i] = 7;
        for (let i = 280; i < 288; i++) l[i] = 8;
        const d = new Uint8Array(30).fill(5);
        fixedTables = { lit: huffman(l, 288), dist: huffman(d, 30) };
        return fixedTables;
    }

    function inflateRaw(src, maxOut) {
        let pos = 0, bitBuf = 0, bitCnt = 0;
        let out = new Uint8Array(Math.min(Math.max(1024, src.length * 3), maxOut));
        let outPos = 0;

        const bits = (need) => {
            while (bitCnt < need) {
                if (pos >= src.length) throw new Error('corrupt zip data (ended early)');
                bitBuf |= src[pos++] << bitCnt;
                bitCnt += 8;
            }
            const v = bitBuf & ((1 << need) - 1);
            bitBuf >>>= need;
            bitCnt -= need;
            return v;
        };
        const decode = (h) => {
            let code = 0, first = 0, index = 0;
            for (let len = 1; len < 16; len++) {
                code |= bits(1);
                const count = h.count[len];
                if (code - count < first) return h.symbol[index + (code - first)];
                index += count;
                first += count;
                first <<= 1;
                code <<= 1;
            }
            throw new Error('corrupt zip data (bad code)');
        };
        const ensure = (extra) => {
            if (outPos + extra <= out.length) return;
            if (outPos + extra > maxOut) throw new Error('a file in the zip is too large');
            let n = out.length * 2;
            while (n < outPos + extra) n *= 2;
            const bigger = new Uint8Array(Math.min(n, maxOut));
            bigger.set(out.subarray(0, outPos));
            out = bigger;
        };
        const codes = (lit, dist) => {
            for (;;) {
                let sym = decode(lit);
                if (sym < 256) { ensure(1); out[outPos++] = sym; }
                else if (sym === 256) return;
                else {
                    sym -= 257;
                    if (sym >= 29) throw new Error('corrupt zip data (bad length)');
                    const len = LBASE[sym] + bits(LEXT[sym]);
                    const ds = decode(dist);
                    if (ds >= 30) throw new Error('corrupt zip data (bad distance)');
                    const d = DBASE[ds] + bits(DEXT[ds]);
                    if (d > outPos) throw new Error('corrupt zip data (distance too far)');
                    ensure(len);
                    for (let i = 0; i < len; i++) { out[outPos] = out[outPos - d]; outPos++; }
                }
            }
        };

        let last;
        do {
            last = bits(1);
            const type = bits(2);
            if (type === 0) {
                bitBuf = 0; bitCnt = 0;                 // stored block: skip to a byte boundary
                if (pos + 4 > src.length) throw new Error('corrupt zip data (ended early)');
                const len = src[pos] | (src[pos + 1] << 8);
                const nlen = src[pos + 2] | (src[pos + 3] << 8);
                pos += 4;
                if ((len ^ 0xffff) !== nlen) throw new Error('corrupt zip data (stored block)');
                if (pos + len > src.length) throw new Error('corrupt zip data (ended early)');
                ensure(len);
                out.set(src.subarray(pos, pos + len), outPos);
                outPos += len; pos += len;
            } else if (type === 1) {
                const t = getFixed();
                codes(t.lit, t.dist);
            } else if (type === 2) {
                const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
                if (nlen > 286 || ndist > 30) throw new Error('corrupt zip data (too many codes)');
                const lengths = new Uint8Array(320);
                for (let i = 0; i < ncode; i++) lengths[CLORDER[i]] = bits(3);
                const lencode = huffman(lengths.subarray(0, 19), 19);
                const all = new Uint8Array(320);
                let idx = 0;
                while (idx < nlen + ndist) {
                    let sym = decode(lencode);
                    if (sym < 16) all[idx++] = sym;
                    else {
                        let prev = 0, rep;
                        if (sym === 16) {
                            if (idx === 0) throw new Error('corrupt zip data (bad repeat)');
                            prev = all[idx - 1]; rep = 3 + bits(2);
                        } else if (sym === 17) rep = 3 + bits(3);
                        else rep = 11 + bits(7);
                        if (idx + rep > nlen + ndist) throw new Error('corrupt zip data (bad repeat)');
                        while (rep--) all[idx++] = prev;
                    }
                }
                if (all[256] === 0) throw new Error('corrupt zip data (no end code)');
                codes(huffman(all.subarray(0, nlen), nlen), huffman(all.subarray(nlen, nlen + ndist), ndist));
            } else {
                throw new Error('corrupt zip data (bad block)');
            }
        } while (!last);
        return out.slice(0, outPos);
    }

    async function inflateNative(src, maxOut) {
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([src]).stream().pipeThrough(ds);
        const reader = stream.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > maxOut) { try { await reader.cancel(); } catch (e) { /* ignore */ } throw new Error('a file in the zip is too large'); }
            chunks.push(value);
        }
        const out = new Uint8Array(total);
        let p = 0;
        for (const c of chunks) { out.set(c, p); p += c.length; }
        return out;
    }

    let nativeOk = null;     // null = not tested yet
    async function inflate(src, maxOut) {
        if (nativeOk !== false && typeof DecompressionStream === 'function' && typeof Blob === 'function') {
            try {
                const r = await inflateNative(src, maxOut);
                nativeOk = true;
                return r;
            } catch (e) {
                if (/too large/.test(String(e && e.message))) throw e;
                // The built-in one can be missing 'deflate-raw' or reject odd data: use ours.
                if (nativeOk === null) nativeOk = false;
            }
        }
        return inflateRaw(src, maxOut);
    }

    // ---------------- crc32 ----------------
    let crcTable = null;
    function crc32(bytes) {
        if (!crcTable) {
            crcTable = new Int32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                crcTable[n] = c;
            }
        }
        let crc = -1;
        for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
        return (crc ^ -1) >>> 0;
    }

    // ---------------- zip container ----------------
    const DEFAULTS = { maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxEntries: 400 };

    /**
     * Reads a zip from an ArrayBuffer/Uint8Array.
     * Returns [{ path, data: Uint8Array }] for every file (folders are left out).
     * Throws an Error with a plain-English message if the zip can't be read or is too big.
     */
    async function read(buffer, limits) {
        const lim = Object.assign({}, DEFAULTS, limits || {});
        const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        const u16 = (o) => dv.getUint16(o, true);
        const u32 = (o) => dv.getUint32(o, true);

        // End of central directory record: scan backwards (a comment may follow it).
        let eocd = -1;
        for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
            if (u32(i) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('this does not look like a .zip file');
        const diskNo = u16(eocd + 4), total = u16(eocd + 10);
        let cdSize = u32(eocd + 12), cdOff = u32(eocd + 16);
        if (diskNo !== 0 || total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff)
            throw new Error('this kind of zip (ZIP64 or split) is not supported; re-zip the plugin normally');
        if (total > lim.maxEntries) throw new Error('the zip has too many files');
        if (cdOff + cdSize > u8.length) throw new Error('the zip is damaged');

        const td = new TextDecoder('utf-8');
        const entries = [];
        let p = cdOff, declared = 0;
        for (let n = 0; n < total; n++) {
            if (p + 46 > u8.length || u32(p) !== 0x02014b50) throw new Error('the zip is damaged (directory)');
            const flags = u16(p + 8), method = u16(p + 10), crc = u32(p + 16);
            const csize = u32(p + 20), usize = u32(p + 24);
            const nameLen = u16(p + 28), extraLen = u16(p + 30), commentLen = u16(p + 32);
            const lho = u32(p + 42);
            if (p + 46 + nameLen > u8.length) throw new Error('the zip is damaged (names)');
            let name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
            p += 46 + nameLen + extraLen + commentLen;
            if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff)
                throw new Error('this kind of zip (ZIP64) is not supported; re-zip the plugin normally');
            name = name.replace(/\\/g, '/');
            if (name.endsWith('/')) continue;                       // folder entry
            if (flags & 1) throw new Error('encrypted zips are not supported');
            if (method !== 0 && method !== 8) throw new Error('unsupported zip compression (' + method + ')');
            if (usize > lim.maxFileBytes) throw new Error(name + ' is too large (limit 2 MB per file)');
            declared += usize;
            if (declared > lim.maxTotalBytes) throw new Error('the plugin is too large (limit 8 MB in total)');
            entries.push({ name, method, crc, csize, usize, lho });
        }

        const files = [];
        let produced = 0;
        for (const e of entries) {
            if (e.lho + 30 > u8.length || u32(e.lho) !== 0x04034b50) throw new Error('the zip is damaged (file header)');
            const start = e.lho + 30 + u16(e.lho + 26) + u16(e.lho + 28);
            if (start + e.csize > u8.length) throw new Error('the zip is damaged (file data)');
            const raw = u8.subarray(start, start + e.csize);
            let data;
            if (e.method === 0) {
                if (e.csize !== e.usize) throw new Error('the zip is damaged (' + e.name + ')');
                data = raw.slice();
            } else {
                data = await inflate(raw, Math.min(lim.maxFileBytes, lim.maxTotalBytes - produced));
            }
            if (data.length !== e.usize) throw new Error('the zip is damaged (' + e.name + ')');
            if (crc32(data) !== e.crc) throw new Error('the zip is damaged (checksum of ' + e.name + ')');
            produced += data.length;
            files.push({ path: e.name, data });
        }
        return files;
    }

    return { read, inflateRaw, crc32 };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HesperZip;
