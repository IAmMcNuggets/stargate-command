'use strict';
/*
 * Minimal PNG decoder — enough to read a glyph sheet, nothing more.
 * Uses only Node's built-in zlib, so the project stays dependency-free.
 *
 * Supports color types 0/2/3/4/6 at bit depth 8, plus sub-byte depths for
 * grayscale and palette. Adam7 interlacing is rejected rather than guessed at.
 */

const fs = require('fs');
const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(raw, width, height, bpp, bytesPerRow) {
  const out = Buffer.alloc(height * bytesPerRow);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + bytesPerRow);
    pos += bytesPerRow;
    const cur = out.subarray(y * bytesPerRow, (y + 1) * bytesPerRow);
    const prev = y > 0 ? out.subarray((y - 1) * bytesPerRow, y * bytesPerRow) : null;

    for (let x = 0; x < bytesPerRow; x++) {
      const rawByte = line[x];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = rawByte; break;
        case 1: v = rawByte + a; break;
        case 2: v = rawByte + b; break;
        case 3: v = rawByte + ((a + b) >> 1); break;
        case 4: v = rawByte + paeth(a, b, c); break;
        default: throw new Error('bad PNG filter type ' + filter + ' on row ' + y);
      }
      cur[x] = v & 0xff;
    }
  }
  return out;
}

/** Expand sub-byte samples (bit depth 1/2/4) into one byte per sample. */
function expandBits(row, width, channels, depth) {
  const out = new Uint8Array(width * channels);
  const max = (1 << depth) - 1;
  let bit = 0;
  for (let i = 0; i < width * channels; i++) {
    const byte = row[bit >> 3];
    const shift = 8 - depth - (bit & 7);
    out[i] = (byte >> shift) & max;
    bit += depth;
  }
  return out;
}

/**
 * @returns {{width:number, height:number, data:Uint8Array}} data is RGBA8.
 */
function decodePNG(filePath) {
  const buf = fs.readFileSync(filePath);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error(filePath + ' is not a PNG (bad signature). Re-save it as PNG.');
  }

  let pos = 8;
  let ihdr = null;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len; // length + type + data + crc

    if (type === 'IHDR') {
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      transparency = body;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!ihdr) throw new Error('PNG has no IHDR chunk');
  if (ihdr.interlace) {
    throw new Error('interlaced (Adam7) PNGs are not supported — re-save without interlacing');
  }

  const { width, height, depth, colorType } = ihdr;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported PNG color type ' + colorType);
  if (depth === 16) throw new Error('16-bit PNGs are not supported — re-save as 8-bit');
  if (depth !== 8 && colorType !== 0 && colorType !== 3) {
    throw new Error('bit depth ' + depth + ' only supported for grayscale/palette');
  }

  const bitsPerPixel = channels * depth;
  const bytesPerRow = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const expected = height * (bytesPerRow + 1);
  if (raw.length < expected) {
    throw new Error(`PNG data truncated: got ${raw.length} bytes, expected ${expected}`);
  }

  const px = unfilter(raw, width, height, bpp, bytesPerRow);
  const out = new Uint8Array(width * height * 4);
  const maxVal = (1 << depth) - 1;

  for (let y = 0; y < height; y++) {
    const rowBuf = px.subarray(y * bytesPerRow, (y + 1) * bytesPerRow);
    const row = depth === 8 ? rowBuf : expandBits(rowBuf, width, channels, depth);

    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r, g, b, a = 255;

      if (colorType === 0) {
        r = g = b = Math.round((row[x] / maxVal) * 255);
      } else if (colorType === 4) {
        r = g = b = row[x * 2];
        a = row[x * 2 + 1];
      } else if (colorType === 2) {
        r = row[x * 3]; g = row[x * 3 + 1]; b = row[x * 3 + 2];
      } else if (colorType === 6) {
        r = row[x * 4]; g = row[x * 4 + 1]; b = row[x * 4 + 2]; a = row[x * 4 + 3];
      } else {
        const idx = row[x];
        if (!palette) throw new Error('palette PNG without PLTE chunk');
        r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
        if (transparency && idx < transparency.length) a = transparency[idx];
      }

      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }

  return { width, height, data: out };
}

module.exports = { decodePNG };
