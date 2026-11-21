import { createCn } from "cn/config";

/**
 * Joins class names and resolves Tailwind conflicts, so the last class of
 * each kind wins: `cn("text-ink", isActive && "text-primary")`.
 *
 * The site's own font sizes must be registered here. Unregistered
 * `text-*` names are read as colors, so `cn("text-ui text-ink-soft",
 * "text-ink")` would silently drop `text-ui`. Keep this list in step with
 * the `--text-*` entries in `app/globals.css` that Tailwind's defaults do
 * not already have (sm, base, lg, xl and 2xl are known).
 */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["md", "ui", "menu", "logo", "code"] }],
    },
  },
});
