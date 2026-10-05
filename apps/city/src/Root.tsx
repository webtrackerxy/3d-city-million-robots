import { lazy, Suspense } from 'react';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router';
import { GITHUB_URL } from './credits/CreditsPage.tsx';
import { MapPage } from './MapPage.tsx';
import { DesktopOnly } from './ui/DesktopOnly.tsx';

// The benchmark, the LOD viewer and the WebGL test load their own code only when opened.
const LodPage = lazy(() => import('./lod/LodPage.tsx').then((m) => ({ default: m.LodPage })));
const BenchPage = lazy(() =>
  import('./bench/BenchPage.tsx').then((m) => ({ default: m.BenchPage })),
);
const CreditsPage = lazy(() =>
  import('./credits/CreditsPage.tsx').then((m) => ({ default: m.CreditsPage })),
);
const WebglPage = lazy(() =>
  import('./webgl/WebglPage.tsx').then((m) => ({ default: m.WebglPage })),
);
// Internal: the XR A/B test, reached by its URL only (not in the navigation).
const XrPage = lazy(() => import('./xr/XrPage.tsx').then((m) => ({ default: m.XrPage })));
// Internal: the 3D Tiles spike, reached by its URL only.
const TilesPage = lazy(() =>
  import('./tiles/TilesPage.tsx').then((m) => ({ default: m.TilesPage })),
);

/** The public demo build hides the developer benchmark from the top bar (`VITE_PUBLIC_DEMO`). */
const PUBLIC_DEMO = import.meta.env.VITE_PUBLIC_DEMO === '1';

/** The three sections, as in the cars project: the map, the character LODs, the benchmarks. */
export function Root() {
  return (
    <BrowserRouter>
      <nav className="topbar">
        <span className="topbar-title">Million Robots</span>
        {/* Map and Map XR load as full pages: each reads its own start settings. */}
        <NavLink to="/" end reloadDocument>
          Map
        </NavLink>
        <NavLink to="/lod">LOD test</NavLink>
        {!PUBLIC_DEMO && <NavLink to="/bench">Benchmarks</NavLink>}
        <NavLink to="/webgl">WebGL test</NavLink>
        <NavLink to="/credits">Credits</NavLink>
        <NavLink to="/map-xr" reloadDocument>
          Map XR
        </NavLink>
        <a className="topbar-github" href={GITHUB_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </nav>
      <main className="page">
        <Suspense fallback={<div className="page-loading">Loading…</div>}>
          <Routes>
            {/* The WebGPU pages; on a phone, tablet or headset they say so instead of loading. */}
            <Route
              path="/"
              element={
                <DesktopOnly>
                  <MapPage />
                </DesktopOnly>
              }
            />
            <Route
              path="/lod"
              element={
                <DesktopOnly>
                  <LodPage />
                </DesktopOnly>
              }
            />
            <Route
              path="/bench"
              element={
                <DesktopOnly>
                  <BenchPage />
                </DesktopOnly>
              }
            />
            <Route path="/webgl" element={<WebglPage />} />
            <Route path="/credits" element={<CreditsPage />} />
            {/* Not desktop-only: headsets open it. */}
            <Route path="/map-xr" element={<MapPage />} />
            <Route path="/xr" element={<XrPage />} />
            <Route path="/tiles" element={<TilesPage />} />
          </Routes>
        </Suspense>
      </main>
    </BrowserRouter>
  );
}
