/**
 * A stored (uncompressed) zip writer, for the `.usdz` packages and the outer
 * download. See *A layer package* in `specs/spec.md`. Written by hand: USDZ
 * needs control over where each entry's data starts, which zip libraries do
 * not give, and stored entries need no deflate.
 *
 * No zip64: every archive this app writes is far below 4 GB. Timestamps are
 * fixed at 1980-01-01, so the same entries always give the same bytes.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date for 1980-01-01; the time is midnight, 0. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
/** An extra-field id for padding, as Apple's USDZ tools use. */
const PAD_ID = 0x1986;
const UTF8 = 1 << 11;

/**
 * The archive. With `align`, each entry's data starts at a multiple of it,
 * by padding the local header's extra field.
 */
export function zip(entries: readonly ZipEntry[], align = 1): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const names = new Set<string>();

  for (const e of entries) {
    if (names.has(e.name)) throw new Error(`duplicate zip entry: ${e.name}`);
    names.add(e.name);
    const name = enc.encode(e.name);
    const flags = /[^\x20-\x7e]/.test(e.name) ? UTF8 : 0;
    const crc = crc32(e.data);

    let pad = 0;
    if (align > 1) {
      const unpadded = offset + 30 + name.length;
      pad = (align - (unpadded % align)) % align;
      // An extra field needs 4 bytes of header; a smaller gap takes a whole stride.
      if (pad > 0 && pad < 4) pad += align;
    }

    const local = new Uint8Array(30 + name.length + pad);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 10, true); // version needed: 1.0, stored
    lv.setUint16(6, flags, true);
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, 0, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, pad, true);
    local.set(name, 30);
    if (pad) {
      lv.setUint16(30 + name.length, PAD_ID, true);
      lv.setUint16(32 + name.length, pad - 4, true);
    }

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // made by
    cv.setUint16(6, 10, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, e.data);
    centrals.push(central);
    offset += local.length + e.data.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
