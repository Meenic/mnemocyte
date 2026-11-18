import type { Root } from "hast";
import { cacheLife } from "next/cache";
import {
  type BundledLanguage,
  codeToHast,
  createCssVariablesTheme,
} from "shiki";

/*
 * A Shiki theme that colors tokens with the site's --code-* tokens, so code
 * on the ink slab follows globals.css. Everything without its own color
 * (names, punctuation, properties) stays --on-ink.
 */
const theme = createCssVariablesTheme({
  name: "mnemocyte",
  variableDefaults: {
    foreground: "var(--on-ink)",
    background: "transparent",
    "token-keyword": "var(--code-keyword)",
    "token-string": "var(--code-string)",
    "token-string-expression": "var(--code-string)",
    "token-constant": "var(--code-string)",
    "token-comment": "var(--code-comment)",
    "token-function": "var(--on-ink)",
    "token-parameter": "var(--on-ink)",
    "token-punctuation": "var(--on-ink)",
    "token-link": "var(--on-ink)",
  },
  fontStyle: false,
});

/**
 * Highlights code and returns it as a hast tree. Cached, so the page that
 * shows it is prerendered at build time: the output only depends on the
 * code, which changes on deploy.
 */
export async function highlight({
  code,
  lang,
}: {
  code: string;
  lang: BundledLanguage;
}): Promise<Root> {
  "use cache";
  cacheLife("max");
  return codeToHast(code, { lang, theme });
}
