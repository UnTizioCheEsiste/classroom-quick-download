// Minimal ZIP writer ("store" method, no compression: PDFs, Office files and
// images are already compressed, so compressing them again is pointless).
// makeZip([{ path, data: Uint8Array }]) → Blob

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function makeZip(entries, now = new Date()) {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const UTF8_FLAG = 0x0800; // file names in UTF-8 (accents etc.)
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const size = entry.data.length;
    const crc = crc32(entry.data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed to extract
    local.setUint16(6, UTF8_FLAG, true);
    local.setUint16(8, 0, true); // store
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local, name, entry.data);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, UTF8_FLAG, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, size, true);
    dir.setUint32(24, size, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(dir, name);

    offset += 30 + name.length + size;
    if (offset > 0xffffffff) throw new Error(typeof t === "function" ? t("zipTooLarge") : "ZIP too large (over 4 GB)");
  }

  const centralSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
