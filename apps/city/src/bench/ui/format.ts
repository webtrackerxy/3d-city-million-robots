const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB'] as const;

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${BYTE_UNITS[unit] ?? 'B'}`;
}

export function formatMs(ms: number | undefined): string {
  return ms === undefined ? '–' : `${ms.toFixed(2)} ms`;
}

export function formatInteger(value: number | undefined): string {
  return value === undefined ? '–' : Math.round(value).toLocaleString('en-GB');
}
