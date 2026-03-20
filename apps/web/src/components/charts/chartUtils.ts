/**
 * Parse a date string to timestamp for Highcharts datetime axis.
 * Handles ISO dates ("YYYY-MM-DD") and PostgreSQL timestamps ("YYYY-MM-DD HH:mm:ss+TZ").
 */
export function parseChartDate(dateStr: string): number {
  if (dateStr.includes(' ')) {
    // PostgreSQL timestamp: "2026-01-28 05:00:00+00" → "2026-01-28T05:00:00+00:00"
    const normalized = dateStr.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
    return new Date(normalized).getTime();
  }
  // Date-only: "2026-01-28" → local midnight
  return new Date(dateStr + 'T00:00:00').getTime();
}
