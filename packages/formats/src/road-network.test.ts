import { describe, expect, it } from 'vitest';
import { readRoadNetwork, writeRoadNetwork } from './road-network.ts';

describe('road network file', () => {
  it('round-trips nodes, directed edges, speeds and classes', () => {
    const roads = {
      nodeX: Float32Array.from([0, 10.5, -3]),
      nodeY: Float32Array.from([0, 2, 7.25]),
      edgeFrom: Uint32Array.from([0, 1, 1, 2, 0]),
      edgeTo: Uint32Array.from([1, 0, 2, 1, 2]),
      speedMps: Float32Array.from([13.9, 13.9, 8.3, 8.3, 4.2]),
      classIndex: Uint8Array.from([0, 0, 1, 1, 2]),
      classes: ['primary', 'residential', 'living_street'],
    };
    const read = readRoadNetwork(writeRoadNetwork(roads));
    expect(read).toEqual(roads);
    expect(read.nodeHeight).toBeUndefined();
  });

  it('round-trips node heights (RDS2), and an RDS1 file reads as flat', () => {
    const roads = {
      nodeX: Float32Array.from([0, 10.5, -3]),
      nodeY: Float32Array.from([0, 2, 7.25]),
      nodeHeight: Float32Array.from([0, -2.5, 4.75]),
      edgeFrom: Uint32Array.from([0, 1]),
      edgeTo: Uint32Array.from([1, 2]),
      speedMps: Float32Array.from([13.9, 8.3]),
      classIndex: Uint8Array.from([0, 1]),
      classes: ['primary', 'residential'],
    };
    const buffer = writeRoadNetwork(roads);
    expect(String.fromCharCode(...new Uint8Array(buffer, 0, 4))).toBe('RDS2');
    expect(readRoadNetwork(buffer)).toEqual(roads);
    const flat = writeRoadNetwork({ ...roads, nodeHeight: undefined });
    expect(String.fromCharCode(...new Uint8Array(flat, 0, 4))).toBe('RDS1');
    expect(readRoadNetwork(flat).nodeX).toEqual(roads.nodeX);
  });
});
