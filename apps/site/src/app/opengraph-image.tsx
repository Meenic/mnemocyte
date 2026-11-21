import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { MARK_PATH, PIP_PATH } from "@/components/brand/logo";
import { getOgArt, OG_SIZE } from "@/lib/og";
import { TAGLINE } from "@/lib/site";

export const alt = `Mnemocyte: ${TAGLINE}`;
export const size = OG_SIZE;
export const contentType = "image/png";

/* ImageResponse reads TTF, OTF and WOFF, not WOFF2, so it takes the TTF
   that the geist package ships next to the fonts next/font uses. */
const geist = await readFile(
  join(
    process.cwd(),
    "node_modules/geist/dist/fonts/geist-sans/Geist-Regular.ttf",
  ),
);

/** The tagline on the left; a still colony bleeds off the right edge. */
export default async function OpengraphImage() {
  const { colors, colony } = await getOgArt({ width: 600, height: 630 });

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        background: colors.bg,
        color: colors.ink,
        fontFamily: "Geist",
        letterSpacing: "-0.03em",
      }}
    >
      {/* biome-ignore lint/performance/noImgElement: ImageResponse renders plain <img>; next/image does not exist there. */}
      {/* biome-ignore lint/a11y/useAltText: decorative; the image's alt text is the `alt` export. */}
      <img
        src={colony.src}
        width={colony.width}
        height={colony.height}
        style={{ position: "absolute", top: 0, right: 0 }}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 80,
          width: 680,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <svg
            aria-hidden="true"
            viewBox="0 0 12 12"
            width={48}
            height={48}
            shapeRendering="crispEdges"
          >
            <path fill={colors.ink} d={MARK_PATH} />
            <path fill={colors.primary} d={PIP_PATH} />
          </svg>
          <span style={{ fontSize: 44 }}>mnemocyte</span>
        </div>
        <div style={{ fontSize: 88, lineHeight: 1.05 }}>{TAGLINE}</div>
      </div>
    </div>,
    {
      ...size,
      fonts: [{ name: "Geist", data: geist, style: "normal", weight: 400 }],
    },
  );
}
