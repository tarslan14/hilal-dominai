import type { SeedInput } from '../engine/state';
import type { World } from './world';

/** Flattens the geo world into the plain seed rows the (render-free) engine consumes. */
export function worldSeeds(world: World): SeedInput[] {
  return world.countries.map((c) => ({
    id: c.id, name: c.name, neighbors: c.neighbors, seaLinks: c.seaLinks, terrain: c.terrain,
    lon: c.centroid[0], lat: c.centroid[1], area: c.area,
    gdp: c.seed.gdp, pop: c.seed.pop, troops: c.seed.troops, tech: c.seed.tech, stability: c.seed.stability, gov: c.seed.gov, oil: c.seed.oil,
  }));
}
