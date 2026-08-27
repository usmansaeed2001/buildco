/**
 * CSV building and download.
 *
 * Ported from `exportCSV` in the legacy `app.html`, with the quoting fixed. That
 * version wrapped values as `` `"${v||""}"` `` — so a client name containing a double
 * quote, a comma inside a note, or a multi-line note all produced a file that opened
 * misaligned in Excel and silently lost columns. It also quoted only *some* columns,
 * which meant a category with a comma shifted every following cell.
 *
 * Here every value is escaped the same way, per RFC 4180: wrap in quotes when the value
 * contains a quote, comma, CR or LF, and double any embedded quote.
 */

/** Anything a cell may hold. `null`/`undefined` become an empty cell, not "null". */
export type CsvValue = string | number | null | undefined;

export function escapeCsvValue(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /["\n\r,]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Join rows into a CSV document.
 *
 * CRLF line endings, again per RFC 4180. Excel accepts LF, but Windows Notepad and a
 * few older importers render the whole file as one line without the CR.
 */
export function toCsv(rows: readonly (readonly CsvValue[])[]): string {
  return rows.map((row) => row.map(escapeCsvValue).join(",")).join("\r\n");
}

/**
 * Hand the browser a CSV file to save.
 *
 * The object URL is revoked on the next tick rather than immediately: revoking in the
 * same task can cancel the download in Safari, which has not started reading the blob
 * when the synchronous click handler returns.
 */
export function downloadCsv(filename: string, rows: readonly (readonly CsvValue[])[]): void {
  // The BOM is what makes Excel read the file as UTF-8. Without it, an accented client
  // name or a "ñ" in a Spanish-dictated note renders as mojibake on a default install.
  const blob = new Blob(["\uFEFF", toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 0);
}
