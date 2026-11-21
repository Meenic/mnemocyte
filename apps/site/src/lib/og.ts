import { cacheLife } from "next/cache";
import { toAbgr } from "./colony/pixel";
import { renderStill } from "./colony/still";
import { encodePng } from "./png";
import { readColorTokens } from "./tokens";

/** The Open Graph image size, the one most sites crop to. */
export const OG_SIZE = { width: 1200, height: 630 };

/** CSS pixels per colony pixel, as on the home page's hero. */
const SCALE = 5;

export interface OgArt {
  colors: { bg: string; ink: string; primary: string };
  /** A still colony frame as a PNG data URL. */
  colony: { src: string; width: number; height: number };
}

/**
 * The colors and the colony frame for the Open Graph image, made once at
 * build time from the design tokens.
 */
export async function getOgArt({
  width,
  height,
}: {
  width: number;
  height: number;
}): Promise<OgArt> {
  "use cache";
  cacheLife("max");
  const tokens = await readColorTokens();
  const still = renderStill({
    width,
    height,
    scale: SCALE,
    density: 380,
    // Fade in from the left, where the tagline sits; bleed off the right.
    fade: [22, 8, 0, 8],
    palette: {
      ink: toAbgr(tokens.ink),
      grain: toAbgr(tokens["cell-grain"]),
      link: toAbgr(tokens["cell-link"]),
      hot: toAbgr(tokens.primary),
    },
  });
  const png = encodePng({ ...still, scale: SCALE });

  return {
    colors: { bg: tokens.bg, ink: tokens.ink, primary: tokens.primary },
    colony: {
      src: `data:image/png;base64,${png.toString("base64")}`,
      width: still.width * SCALE,
      height: still.height * SCALE,
    },
  };
}
