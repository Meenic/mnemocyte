import { crc32, deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface PngInput {
  width: number;
  height: number;
  /** Row-major RGBA bytes, four per pixel. */
  rgba: Uint8Array | Uint8ClampedArray;
  /** Whole-number upscale; each pixel becomes a scale × scale block. */
  scale?: number;
}

/**
 * Encodes RGBA pixels as a PNG. The upscale happens here rather than in the
 * consumer, so pixel art stays sharp wherever it is drawn.
 */
export function encodePng({
  width,
  height,
  rgba,
  scale = 1,
}: PngInput): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(`Expected ${width * height * 4} bytes, got ${rgba.length}`);
  }
  const outWidth = width * scale;
  const outHeight = height * scale;
  const stride = outWidth * 4 + 1; // each row starts with a filter byte (0: none)
  const raw = Buffer.alloc(stride * outHeight);

  for (let y = 0; y < outHeight; y++) {
    const source = Math.floor(y / scale) * width;
    for (let x = 0; x < outWidth; x++) {
      const from = (source + Math.floor(x / scale)) * 4;
      raw.set(rgba.subarray(from, from + 4), y * stride + 1 + x * 4);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(outWidth, 0);
  header.writeUInt32BE(outHeight, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
