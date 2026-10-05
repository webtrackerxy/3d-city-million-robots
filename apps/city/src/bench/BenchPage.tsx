import { MetricsBus } from '@city/metrics';
import { useEffect, useRef, useState } from 'react';
import { type EngineHandle, type EngineStatus, startEngine } from './gpu/benchmark-engine.ts';
import type { BenchmarkResult } from './harness/benchmark-result.ts';
import { parseScenario } from './harness/scenario.ts';
import type { LodControls } from './paths/render-path.ts';
import { DebugPanel } from './ui/DebugPanel.tsx';
import './bench.css';

/**
 * Benchmarks (/bench): the Stage 0 character benchmark — GPU crowd paths, LOD sweeps and the
 * scripted runs of tools/bench-runner. The scenario comes from the query string.
 */
export function BenchPage() {
  // Engine state lives outside React; components only poll this bus.
  const [bus] = useState(() => new MetricsBus());
  const [scenario] = useState(() => parseScenario(window.location.search));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EngineHandle | null>(null);
  const [status, setStatus] = useState<EngineStatus>({ state: 'starting', message: '' });
  const [results, setResults] = useState<BenchmarkResult[]>([]);
  const [lodControls, setLodControls] = useState<LodControls>({
    forced: scenario.lod,
    impostors: scenario.impostors,
    preset: scenario.lodPreset,
    debugColours: scenario.lodColours,
    fade: scenario.fade,
    fadeMs: scenario.fadeMs,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const engine = startEngine(canvas, bus, scenario, {
      onStatus: setStatus,
      onResult: (result) => {
        setResults((previous) => [...previous, result]);
      },
    });
    engineRef.current = engine;
    return () => {
      engineRef.current = null;
      engine.dispose();
    };
  }, [bus, scenario]);

  return (
    <div className="bench-page">
      <canvas ref={canvasRef} className="viewport" />
      {status.state === 'failed' ? (
        <div className="fatal">
          <h1>The benchmark could not start</h1>
          <p>{status.reason}</p>
          <p>WebGPU needs a current desktop Chrome, Edge or Safari with hardware acceleration.</p>
        </div>
      ) : (
        <DebugPanel
          bus={bus}
          status={status}
          scenario={scenario}
          results={results}
          onSetAgents={(count) => engineRef.current?.setAgentCount(count)}
          onRunSweep={() => engineRef.current?.runSweep()}
          lodControls={lodControls}
          onLodControls={(controls) => {
            setLodControls(controls);
            engineRef.current?.setLodControls(controls);
          }}
        />
      )}
    </div>
  );
}
