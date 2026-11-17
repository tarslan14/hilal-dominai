# HILAL architecture

This file maps the code as it stood before the Total War rework (commit `d5512b1`) and then records what the
rework changed. Line numbers refer to `index.html` at `d5512b1`.

## 1. Shape of the project

| File | Role |
|---|---|
| `index.html` | The whole game: CSS, HUD markup, data, renderer, simulation, input, UI flow. One `<script type="module">`. |
| `three.min.js` | three.js r160, loaded as a classic script (global `THREE`). |
| `sw.js` | Offline cache (stale-while-revalidate). `CACHE` must be bumped on every release. |
| `manifest.webmanifest`, `icon-*.png` | PWA install (fullscreen, landscape). |
| `vercel.json` | Headers for `sw.js` and the manifest. `hilal/` is the deploy root. |
| `dev-server.js` | Optional local static server on port 8765. |

No build step, no dependencies, no network calls. Must keep working from `file://`.

## 2. Before the rework

### Data (lines 246–556)
- `TYPES` – ten troop types (`sword, spear, archer, harcher, cavalry, shield, crossbow, musket, siege, hero`) with cost,
  hp, damage, range, cooldown, speed, radius. `from` gates a type by year, `limit` caps the commander at one.
- `LEVELS` – ten battles in date order (Manzikert 1071 … Vienna 1683). Each has names, colours, gold, map key, seed,
  theme, story/facts/tips text and the enemy `army` as rows `{t,n,x,z,cols,hold}`.
- `EXTRA` – per-battle intro, suggested troops, tips, `terrain` shapes and optional `wall` (walls or cliffs with gaps).
  Merged into `LEVELS` at load.
- Terrain helpers: `HT(x,z)` full ground height, `HH` battle hills only, `terr(u)` sets a troop's terrain flags
  (slow, no-charge, cover, stakes, height).

### State (lines 566–573)
Module-level variables: `state` (`menu | story | deploy | battle | end`), `cur`, `LV`, `units`, `corpses`, `projs`,
`parts`, `gold`, `selType`, `squad`, `layout`, `speed`, `paused`, `simT`, `winner`, `headless`.
Progress is `prog = {unlocked, stars[]}` in `localStorage['hilal_progress']` (falls back to `sancak_progress`).

### Renderer (lines 578–781)
- One `WebGLRenderer`, ACES tone mapping, PCF soft shadows, one directional sun, one hemisphere light, camp fires.
- Orbit camera `cam = {tx,tz,yaw,pitch,dist}` applied in `camApply()`.
- Scene groups: `world` (map, rebuilt per level), `unitsG`, `fxG`, `zoneG` (deploy zone), ghost rings.
- Soldiers: `geo(parts)` merges a part list into one vertex-coloured geometry; `soldier()` and `horse()` hang those
  on a small skeleton of `Group`s; `animate(u)` poses the skeleton. **Every troop was its own tree of about eight
  meshes**, so draw calls grew with army size.
- `makeThumbs()` renders one PNG per troop type for the cards.

### Maps (lines 786–1049)
`buildMap(L)` clears `world`, then `buildGround` (two vertex-coloured height meshes), `camp`, `MAPS[L.map]`
(set dressing through the instanced `scatter` helper), `buildTerrain`, `extras`, `dressField`, `settle`.

### Simulation (lines 1090–1302)
- A "unit" was **one soldier**: `spawn()` made `{type,T,team,x,z,hp,mor,rout,st,hold,…}`.
- `step(dt)` at a fixed 60 Hz: retarget (`pickTarget`), morale (`mind`), rout flight, flank waypoints, attack or
  move (`goal`/`wallFix` route round walls), kiting, pairwise separation, projectiles (`fire`, splash for stones),
  end check (`finish`).
- `mult()` holds the rock-paper-scissors bonuses; `hurt()` applies damage, knockback, a rear-hit bonus and morale loss.
- `window.HILAL.sim(i)` runs a level headless with `autoDeploy()` for balance checks.

### Deploy UI and flow (lines 1334–1493)
- Deploy: pick a troop card, tap inside `ZONE` to buy and place (`place`, `canPlace`), squad multiplier, stance
  (`charge | hold | flank | guard`), remove tool, `autoDeploy`.
- Flow: `showMenu → openStory → beginDeploy → startBattle → finish → retry/next`. `setUI()` toggles panels by `state`.
- Once the battle started the player could only watch.

### Input and loop (lines 1495–1604)
Pointer events on the canvas (place, rotate, pinch zoom), two thumb sticks, zoom buttons, WASD/QE keys.
`frame()` runs `camUpdate`, the fixed-step sim, `visuals`, `updateGhosts`, then renders.

## 3. After the rework

The file layout is unchanged: still one `index.html`. Sections, in order:

| Section | What it holds |
|---|---|
| `DATA` | `TYPES` (now regiment stats: `atk, def, arm, chg, mhp, rdmg, vsCav`), `LEVELS`, `EXTRA`, `MAPGEO` (campaign map coastlines and node positions). |
| `SETTINGS` | `S`, `SET_DEF`, load/validate/save in `localStorage['hilal_settings']`, `applySetting()`. |
| `RENDERER / SCENE` | As before, plus `applyTimeOfDay()` and the auto-quality governor. |
| `SOLDIER BATCHES` | `Batch` (one `InstancedMesh` per body part and troop kind), `soldierKind()`, `drawSoldiers()`. |
| `MAPS` | Unchanged apart from tent/sky hooks for time of day. |
| `UNITS / SIMULATION` | Regiment-level sim: `spawn`, `mind` (morale), `melee`, `volley`, `hurtUnit`, `step`. |
| `BANNERS / FX` | Banner sprites, instanced arrows, particles and dust. |
| `CAMPAIGN MAP` | 2D canvas map, nodes, province panel. |
| `HUD` | Advisor, balance bar and clock, unit cards, stat panel, minimap, settings panel. |
| `DEPLOYMENT`, `FLOW / UI`, input, main loop | As before, extended with selection and orders. |

### Key changes
- **A unit is now a regiment.** `units[]` entries carry `men`, `max`, `hp`, `mor`, `fat`, `charged`, an optional
  player order `ord`, and per-soldier position arrays used only for drawing. Enemy `army` rows are grouped into
  regiments (`round(n/3)`, at least one).
- **Soldiers are instanced.** `drawSoldiers()` writes every soldier and corpse into a few `InstancedMesh` batches
  (body and weapon arm per troop kind, legs per team, one horse body and one horse-leg batch). Draw calls no longer
  grow with the number of soldiers.
- **States:** `map | menu | story | deploy | battle | end`. The campaign map is the home screen; the old battle list
  is still reachable from it.
- **Persistence keys:** `hilal_progress` (unchanged format) and `hilal_settings` (new).
- **Headless sim** `HILAL.sim(i)` still works and is still the balance check.
