'use strict';
/*
 * Reading Info.plist — binary and XML.
 *
 * Every macOS .app bundle describes itself in Contents/Info.plist, and Xcode
 * has written that file as a *binary* plist for many years now, so a scanner
 * that only understands the XML form gets almost nothing. Apple ships plutil
 * to convert one, but a catalog scan touches several hundred bundles and
 * spawning plutil that many times is both slow and a bet on a tool being
 * where we expect it.
 *
 * So both formats are read here in pure Node, which keeps catalog-mac.js the
 * same shape as catalog-linux.js: filesystem work and nothing else.
 *
 * Only the subset a plist actually uses is implemented. Dates and UIDs are
 * decoded just well enough to be stepped over rather than desynchronising the
 * object table around them.
 */

const fs = require('fs');

const BINARY_MAGIC = 'bplist00';

/* --------------------------------------------------------------- binary */

/** Big-endian unsigned read of up to 6 bytes, which stays inside 2^53. */
function readUInt(buf, off, size) {
  if (off < 0 || off + size > buf.length) throw new Error('plist: read past end');
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[off + i];
  return v;
}

function parseBinary(buf) {
  if (buf.length < 40) throw new Error('plist: too short to be a binary plist');

  const trailer = buf.length - 32;
  const offsetSize = buf[trailer + 6];
  const refSize = buf[trailer + 7];
  const numObjects = readUInt(buf, trailer + 8, 8);
  const topObject = readUInt(buf, trailer + 16, 8);
  const offsetTableOffset = readUInt(buf, trailer + 24, 8);

  if (!offsetSize || offsetSize > 8 || !refSize || refSize > 8) {
    throw new Error('plist: implausible trailer');
  }
  if (offsetTableOffset + numObjects * offsetSize > buf.length) {
    throw new Error('plist: offset table runs past the end');
  }

  const offsets = new Array(numObjects);
  for (let i = 0; i < numObjects; i++) {
    offsets[i] = readUInt(buf, offsetTableOffset + i * offsetSize, offsetSize);
  }

  /*
   * A plist may legally share one object between several parents, so a plain
   * "already visited" test would wrongly reject valid files. Only the chain
   * currently being expanded is tracked, which catches the cycles a corrupt
   * file can produce without touching honest sharing.
   */
  const active = new Set();

  /** Read the count for a variable-length object, and where its body starts. */
  function lengthAt(off) {
    const info = buf[off] & 0x0f;
    if (info !== 0x0f) return { length: info, next: off + 1 };
    const marker = buf[off + 1];
    if (marker >> 4 !== 0x1) throw new Error('plist: bad extended length');
    const size = 1 << (marker & 0x0f);
    if (size > 6) throw new Error('plist: length too large');
    return { length: readUInt(buf, off + 2, size), next: off + 2 + size };
  }

  function objectAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= numObjects) {
      throw new Error('plist: object reference out of range');
    }
    if (active.has(index)) throw new Error('plist: cyclic object graph');

    const off = offsets[index];
    if (off >= buf.length) throw new Error('plist: object offset past the end');
    const marker = buf[off];
    const type = marker >> 4;
    const info = marker & 0x0f;

    switch (type) {
      case 0x0:
        if (info === 0x00) return null;
        if (info === 0x08) return false;
        if (info === 0x09) return true;
        return null; // padding / fill

      case 0x1: {
        const size = 1 << info;
        // Only the 8-byte width is written signed, as two's complement.
        if (size === 8) return Number(buf.readBigInt64BE(off + 1));
        if (size > 8) throw new Error('plist: integer too wide');
        return readUInt(buf, off + 1, size);
      }

      case 0x2: {
        const size = 1 << info;
        if (size === 4) return buf.readFloatBE(off + 1);
        if (size === 8) return buf.readDoubleBE(off + 1);
        throw new Error('plist: unsupported real width');
      }

      case 0x3:
        // Seconds from 2001-01-01, the Core Foundation epoch.
        return new Date((buf.readDoubleBE(off + 1) + 978307200) * 1000);

      case 0x4: {
        const { length, next } = lengthAt(off);
        return Buffer.from(buf.subarray(next, next + length));
      }

      case 0x5: {
        const { length, next } = lengthAt(off);
        return buf.toString('latin1', next, next + length);
      }

      case 0x6: {
        // UTF-16 big-endian, counted in code units. Node has no big-endian
        // UTF-16 decoder, so the bytes are swapped into the one it does have.
        const { length, next } = lengthAt(off);
        const bytes = Buffer.from(buf.subarray(next, next + length * 2));
        bytes.swap16();
        return bytes.toString('utf16le');
      }

      case 0x8:
        return { uid: readUInt(buf, off + 1, info + 1) };

      case 0xa:
      case 0xc: {
        const { length, next } = lengthAt(off);
        active.add(index);
        try {
          const out = new Array(length);
          for (let i = 0; i < length; i++) {
            out[i] = objectAt(readUInt(buf, next + i * refSize, refSize));
          }
          return out;
        } finally {
          active.delete(index);
        }
      }

      case 0xd: {
        const { length, next } = lengthAt(off);
        active.add(index);
        try {
          const out = {};
          const valuesAt = next + length * refSize;
          for (let i = 0; i < length; i++) {
            const key = objectAt(readUInt(buf, next + i * refSize, refSize));
            const value = objectAt(readUInt(buf, valuesAt + i * refSize, refSize));
            if (typeof key === 'string') out[key] = value;
          }
          return out;
        } finally {
          active.delete(index);
        }
      }

      default:
        throw new Error('plist: unknown object type 0x' + type.toString(16));
    }
  }

  return objectAt(topObject);
}

/* ------------------------------------------------------------------ XML */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/*
 * Flatten the document into open/close/empty tags and the text between them.
 * A plist has no attributes worth reading and no mixed content, so this is
 * all the XML that needs to be understood.
 */
function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) {
      const text = src.slice(i, lt);
      if (text.trim()) tokens.push({ t: 'text', v: text });
    }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    const gt = src.indexOf('>', lt);
    if (gt < 0) break;

    let inner = src.slice(lt + 1, gt).trim();
    let kind = 'open';
    if (inner.startsWith('/')) {
      kind = 'close';
      inner = inner.slice(1).trim();
    } else if (inner.endsWith('/')) {
      kind = 'empty';
      inner = inner.slice(0, -1).trim();
    }
    const name = inner.split(/[\s/]/)[0].toLowerCase();
    if (name) tokens.push({ t: kind, v: name });
    i = gt + 1;
  }
  return tokens;
}

function parseXml(text) {
  const tokens = tokenize(text);
  let p = 0;

  function scalar(name) {
    let text = '';
    if (tokens[p] && tokens[p].t === 'text') {
      text = tokens[p].v;
      p++;
    }
    if (tokens[p] && tokens[p].t === 'close' && tokens[p].v === name) p++;
    switch (name) {
      case 'string':
        return decodeEntities(text);
      case 'integer': {
        const n = parseInt(text.trim(), 10);
        return Number.isFinite(n) ? n : 0;
      }
      case 'real': {
        const n = parseFloat(text.trim());
        return Number.isFinite(n) ? n : 0;
      }
      case 'data':
        return Buffer.from(text.replace(/\s+/g, ''), 'base64');
      case 'date':
        return new Date(text.trim());
      default:
        return decodeEntities(text);
    }
  }

  function value() {
    const tok = tokens[p];
    if (!tok) return undefined;

    if (tok.t === 'empty') {
      p++;
      switch (tok.v) {
        case 'true':
          return true;
        case 'false':
          return false;
        case 'dict':
          return {};
        case 'array':
          return [];
        default:
          return '';
      }
    }

    if (tok.t !== 'open') {
      p++;
      return undefined;
    }

    const name = tok.v;
    p++;

    if (name === 'true' || name === 'false') {
      if (tokens[p] && tokens[p].t === 'close' && tokens[p].v === name) p++;
      return name === 'true';
    }

    if (name === 'dict') {
      const out = {};
      while (p < tokens.length && !(tokens[p].t === 'close' && tokens[p].v === 'dict')) {
        if (tokens[p].t === 'open' && tokens[p].v === 'key') {
          p++;
          let key = '';
          if (tokens[p] && tokens[p].t === 'text') {
            key = decodeEntities(tokens[p].v).trim();
            p++;
          }
          if (tokens[p] && tokens[p].t === 'close' && tokens[p].v === 'key') p++;
          out[key] = value();
        } else if (tokens[p].t === 'empty' && tokens[p].v === 'key') {
          p++;
          out[''] = value();
        } else {
          p++;
        }
      }
      p++; // </dict>
      return out;
    }

    if (name === 'array') {
      const out = [];
      while (p < tokens.length && !(tokens[p].t === 'close' && tokens[p].v === 'array')) {
        const before = p;
        const v = value();
        if (p === before) p++; // never stall on something unexpected
        else out.push(v);
      }
      p++; // </array>
      return out;
    }

    return scalar(name);
  }

  // Skip past <plist> to the single value it wraps.
  while (p < tokens.length && !(tokens[p].t === 'open' && tokens[p].v === 'plist')) p++;
  if (p >= tokens.length) throw new Error('plist: no <plist> element');
  p++;
  return value();
}

/* --------------------------------------------------------------- public */

/** Parse a plist held in a Buffer, sniffing binary vs XML from the magic. */
function parse(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (data.length >= 8 && data.toString('latin1', 0, 8) === BINARY_MAGIC) {
    return parseBinary(data);
  }
  return parseXml(data.toString('utf8'));
}

/**
 * Read and parse a plist from disk.
 * @returns {object|null} the parsed root, or null if it is unreadable or not
 *          a dictionary — callers treat a plist as best-effort enrichment.
 */
function readPlist(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (_) {
    return null;
  }
  try {
    const root = parse(buf);
    return root && typeof root === 'object' && !Array.isArray(root) ? root : null;
  } catch (_) {
    return null;
  }
}

module.exports = { parse, readPlist, _internals: { parseBinary, parseXml, decodeEntities } };
