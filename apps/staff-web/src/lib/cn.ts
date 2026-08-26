/** Join class names, dropping falsy entries.
 *
 * Deliberately not `tailwind-merge`: nothing here builds conflicting utility strings
 * dynamically, so the extra dependency and its bundle cost would buy nothing. If a
 * component starts accepting overrides that must beat its own defaults, revisit. */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
