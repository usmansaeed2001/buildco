/**
 * Email addresses typed by hand.
 *
 * Deliberately loose. The API is the authority on what counts as an address and it
 * rejects far more than this does (reserved domains, bad punctuation); this exists only
 * so an obvious slip — a missing `@`, a space, a trailing comma — is caught at the
 * field instead of coming back as a 422 for the whole form.
 */
const SHAPE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;

/** Trimmed and lower-cased — how the API stores and compares them. */
export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isEmail(value: string): boolean {
  return SHAPE.test(value.trim());
}
