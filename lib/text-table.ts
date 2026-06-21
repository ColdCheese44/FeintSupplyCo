/**
 * Renders a simple fixed-width text table for terminal output and Discord code blocks.
 */
export function renderTextTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, columnIndex) =>
    Math.max(
      header.length,
      ...rows.map((row) => (row[columnIndex] ?? "").length),
    ),
  );

  const formatRow = (row: string[]): string =>
    `| ${row.map((cell, columnIndex) => (cell ?? "").padEnd(widths[columnIndex], " ")).join(" | ")} |`;

  const separator = `|-${widths.map((width) => "-".repeat(width)).join("-|-")}-|`;
  return [formatRow(headers), separator, ...rows.map((row) => formatRow(row))].join("\n");
}
