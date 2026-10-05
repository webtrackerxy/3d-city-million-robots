/** Processed areas. The Canary Wharf box is the plan's first area (§10 stage 1). */
export interface RegionDefinition {
  name: string;
  bboxWgs84: [west: number, south: number, east: number, north: number];
  /**
   * Land masses with no walking link between them inside the box (rivers, docks without bridges).
   * Connectivity metrics count the largest `landMasses` components as connected.
   */
  landMasses: number;
  /** Stage 10 QA gates: the build fails when a metric falls outside its bound. */
  gates: Partial<Record<string, { min?: number; max?: number }>>;
}

export const REGIONS: Partial<Record<string, RegionDefinition>> = {
  'canary-wharf': {
    name: 'Canary Wharf',
    bboxWgs84: [-0.0379, 51.4964, -0.0091, 51.5144],
    // The box takes in a strip of Rotherhithe across the Thames (ferry only).
    landMasses: 2,
    gates: {
      'graph.connectedShare': { min: 0.95 },
      'entrances.connectedShare': { min: 0.9 },
      'entrances.buildingsReachableShare': { min: 0.85 },
      'graph.danglingShare': { max: 0.15 },
    },
  },
  /**
   * Milestone M7's widened region (§26): Limehouse to Leamouth, Poplar to the Isle of Dogs' tip,
   * and the south bank from Rotherhithe to North Greenwich — about 4.2 × 4.3 km. The Greenwich foot
   * tunnel joins the Isle of Dogs to the south bank; Rotherhithe's riverside is a separate walk.
   */
  docklands: {
    name: 'Docklands',
    bboxWgs84: [-0.05, 51.486, 0.01, 51.525],
    landMasses: 2,
    gates: {
      'graph.connectedShare': { min: 0.95 },
      'entrances.connectedShare': { min: 0.9 },
      'entrances.buildingsReachableShare': { min: 0.85 },
      'graph.danglingShare': { max: 0.15 },
    },
  },
  /**
   * The public demo's region: the river corridor from Buckingham Palace and Trafalgar Square
   * through the City and Wapping to the Isle of Dogs and Island Gardens — about 9.8 × 3.6 km, a
   * tenth of London's data, with all four places.
   */
  central: {
    name: 'Central London',
    bboxWgs84: [-0.146, 51.484, -0.004, 51.516],
    landMasses: 2,
    gates: {
      'graph.connectedShare': { min: 0.95 },
      'entrances.connectedShare': { min: 0.9 },
      'entrances.buildingsReachableShare': { min: 0.85 },
      'graph.danglingShare': { max: 0.15 },
    },
  },
  /**
   * The 3d-city-million-cars project's London: 20 × 20 km around Trafalgar Square (−0.1281,
   * 51.508), Hammersmith to the Royal Docks, Hampstead to Streatham — room for a million robots at
   * about one per 15 m of footway.
   */
  london: {
    name: 'London',
    bboxWgs84: [-0.2724, 51.4182, 0.0162, 51.5978],
    landMasses: 1,
    gates: {
      'graph.connectedShare': { min: 0.95 },
      'entrances.connectedShare': { min: 0.9 },
      'entrances.buildingsReachableShare': { min: 0.85 },
      'graph.danglingShare': { max: 0.15 },
    },
  },
};
