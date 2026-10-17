/**
 * CSV text for spreadsheet tools. Text cells that start (after any whitespace) with =, +, -, @ or their
 * full-width forms are prefixed with an apostrophe so a spreadsheet does not run them as formulas
 * (CSV injection). Numbers are written as numbers.
 */
export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return rows
    .map((row) =>
      row
        .map((value) => {
          if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
          let text = value === null || value === undefined ? "" : value;
          if (/^[\s]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u.test(text)) text = `'${text}`;
          return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
        })
        .join(","),
    )
    .join("\r\n");
}

/** Starts a browser download of `text` as a UTF-8 CSV file. */
export function downloadCsv(filename: string, text: string): void {
  const blob = new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
