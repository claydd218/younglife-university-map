// Minimal, dependency-free ZIP writer — STORED (uncompressed) entries
// only, streamed so building a photos-export archive never has to hold
// more than one photo's bytes in memory at once, regardless of how many
// photos or how large the whole export gets. No real compression
// library was pulled in deliberately: R2 already stores these as
// already-compressed JPEG/WebP/PNG, so DEFLATing them again would barely
// shrink the output while adding real complexity, and this project
// already avoids external/CDN JS dependencies elsewhere (see vendor/).

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ZIP stores timestamps in MS-DOS date/time format (16 bits each) — not
// preserving each photo's real upload time here, just using "now" for
// every entry, which is fine for a backup archive where the content is
// what matters.
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

function u16(n) { return new Uint8Array([n & 0xff, (n >> 8) & 0xff]); }
function u32(n) { return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]); }

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// UTF-8 filenames flag (bit 11) — harmless for the plain-ASCII slugified
// filenames this project actually produces, but correct regardless.
const GENERAL_PURPOSE_FLAG = 0x0800;
const VERSION = 20; // 2.0 — the baseline needed for plain STORED entries, no encryption/splitting

// `entries`: an async iterable of { name, bytes: Uint8Array }. Returns a
// ReadableStream<Uint8Array> suitable for a Response body.
export function createZipStream(entries) {
  const encoder = new TextEncoder();
  const central = []; // one fully-built central-directory record per entry
  let offset = 0;

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const { name, bytes } of entries) {
          const nameBytes = encoder.encode(name);
          const { time, day } = dosDateTime(new Date());
          const crc = crc32(bytes);
          const size = bytes.length;

          const localHeader = concat(
            u32(0x04034b50), u16(VERSION), u16(GENERAL_PURPOSE_FLAG), u16(0), u16(time), u16(day),
            u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), nameBytes,
          );
          controller.enqueue(localHeader);
          controller.enqueue(bytes);

          central.push(concat(
            u32(0x02014b50), u16(VERSION), u16(VERSION), u16(GENERAL_PURPOSE_FLAG), u16(0), u16(time), u16(day),
            u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
            u32(0), u32(offset), nameBytes,
          ));
          offset += localHeader.length + bytes.length;
        }

        const centralStart = offset;
        let centralSize = 0;
        for (const record of central) {
          controller.enqueue(record);
          centralSize += record.length;
        }

        controller.enqueue(concat(
          u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
          u32(centralSize), u32(centralStart), u16(0),
        ));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
