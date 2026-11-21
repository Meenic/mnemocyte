import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheLife } from "next/cache";

/**
 * The hex color tokens in a stylesheet, by name without `--`. The first
 * definition of a name wins, so later overrides in media queries don't
 * replace the base value.
 */
export function parseColorTokens(css: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(
    /--([\w-]+)\s*:\s*(#[0-9a-f]{3,8})\s*;/gi,
  )) {
    tokens[name] ??= value;
  }
  return tokens;
}

/**
 * The color tokens from globals.css, for code that can't read CSS
 * variables, such as the Open Graph image.
 */
export async function readColorTokens(): Promise<Record<string, string>> {
  "use cache";
  cacheLife("max");
  const css = await readFile(
    join(process.cwd(), "src", "app", "globals.css"),
    "utf8",
  );
  return parseColorTokens(css);
}
