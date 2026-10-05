/** A region id as a title: `canary-wharf` → Canary Wharf; `central` is Central London. */
export function regionTitle(id: string): string {
  if (id === 'central') return 'Central London';
  return id
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
