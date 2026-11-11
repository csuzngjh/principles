import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The §3.1 type scale is declared as `--text-*` theme tokens, so the generated
 * utilities (`text-body`, `text-caption`, …) are font sizes. tailwind-merge
 * cannot tell a custom token apart from a colour utility (`text-ink`), which
 * makes `cn()` silently drop one of the two. Register the scale explicitly.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["display", "title", "subtitle", "body", "reading", "caption", "eyebrow"] },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
