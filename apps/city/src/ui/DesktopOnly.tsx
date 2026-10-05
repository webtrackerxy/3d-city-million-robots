import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { MOBILE_DEVICE } from '../device.ts';

/** Remembered for the tab, so "Try anyway" is asked once per visit. */
const TRY_ANYWAY_KEY = 'city.tryOnMobile';

function readTryAnyway(): boolean {
  try {
    return sessionStorage.getItem(TRY_ANYWAY_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The WebGPU pages on a phone, tablet or headset: a "not supported" notice instead of loading a
 * city that would not fit the browser, pointing to a desktop browser and the WebGL test. "Try
 * anyway" loads the page with the phone settings.
 */
export function DesktopOnly({ children }: { children: ReactNode }) {
  const [allowed, setAllowed] = useState(() => !MOBILE_DEVICE || readTryAnyway());
  if (allowed) return children;
  return (
    <div
      className="unsupported"
      role="dialog"
      aria-modal="true"
      aria-labelledby="unsupported-title"
    >
      <div className="unsupported-card">
        <h2 id="unsupported-title">Not supported on mobile</h2>
        <p>
          The city simulation needs a desktop or laptop: it runs up to millions of people, robots
          and cars with WebGPU, more than a phone, tablet or headset browser can hold.
        </p>
        <p>
          Open <b>{location.host}</b> in Chrome, Edge or Safari on a computer.
        </p>
        <div className="unsupported-actions">
          <Link to="/webgl" className="unsupported-primary">
            Open the WebGL test
          </Link>
          <button
            type="button"
            onClick={() => {
              try {
                sessionStorage.setItem(TRY_ANYWAY_KEY, '1');
              } catch {
                // Storage blocked: allow this page only.
              }
              setAllowed(true);
            }}
          >
            Try anyway
          </button>
        </div>
        <p className="unsupported-note">The WebGL test works on phones and the Meta Quest.</p>
      </div>
    </div>
  );
}
