import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePng } from "./png";

/** The chunks of a PNG, by type. */
function chunks(png: Buffer): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    found.set(type, png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return found;
}

describe("encodePng", () => {
  const red = [255, 0, 0, 255];
  const clear = [0, 0, 0, 0];

  it("writes a PNG of the upscaled size", () => {
    const png = encodePng({
      width: 2,
      height: 1,
      rgba: new Uint8Array([...red, ...clear]),
      scale: 3,
    });
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const header = chunks(png).get("IHDR");
    expect(header?.readUInt32BE(0)).toBe(6);
    expect(header?.readUInt32BE(4)).toBe(3);
  });

  it("repeats each pixel into a scale × scale block", () => {
    const png = encodePng({
      width: 2,
      height: 1,
      rgba: new Uint8Array([...red, ...clear]),
      scale: 2,
    });
    const raw = inflateSync(chunks(png).get("IDAT") ?? Buffer.alloc(0));
    const row = [0, ...red, ...red, ...clear, ...clear];
    expect([...raw]).toEqual([...row, ...row]);
  });

  it("rejects a buffer of the wrong length", () => {
    expect(() =>
      encodePng({ width: 2, height: 2, rgba: new Uint8Array(4) }),
    ).toThrow("Expected 16 bytes, got 4");
  });
});
