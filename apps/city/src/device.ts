/**
 * Phones and small tablets. Safari on iOS ends a tab that uses more than about 1–1.5 GB, so these
 * start with a lighter scene: a smaller crowd and fewer cars, one simulation worker, smaller
 * route-table caches and a 1× drawing buffer. URL parameters and the panel still override it.
 */
export const PHONE = window.matchMedia(
  '(max-width: 640px), (pointer: coarse) and (max-width: 1024px)',
).matches;

/** Shown when the browser has no WebGPU, or no adapter for it. */
export const NEEDS_WEBGPU =
  'This demo needs WebGPU: Safari on iOS 26 or later, or a recent desktop Chrome, Edge or Safari.';

/**
 * Phones, tablets and headsets (the Quest Browser): the WebGPU pages are not offered there, since
 * the city does not fit a mobile browser's memory. The browser's own hint where it gives one, else
 * the user agent; iPadOS reports a Mac user agent, but a Mac has no touch screen. `?mobile=1` or `0`
 * forces it.
 */
export const MOBILE_DEVICE = (() => {
  // `?mobile=1` / `?mobile=0` overrides the detection (for testing on a desktop).
  const forced = new URLSearchParams(location.search).get('mobile');
  if (forced === '1' || forced === '0') return forced === '1';
  const hints = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (hints?.mobile === true) return true;
  const agent = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile|OculusBrowser|Quest/i.test(agent)) return true;
  return agent.includes('Macintosh') && navigator.maxTouchPoints > 1;
})();
