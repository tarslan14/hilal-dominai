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

The file layout is unchanged: still one `index.html`, now with `fonts/` beside it. Sections, in order:

| Section | What it holds |
|---|---|
| `DATA` | `TYPES` plus `REG` (regiment stats: `atk, def, arm, chg, mhp, size, rdmg, vcd, vsCav, cav, gen`), `LEVELS`, `EXTRA`, terrain helpers. |
| `HELPERS / STATE`, `RENDERER / SCENE` | As before. `geo()` has a lite mode for phones. The skeleton builders remain for thumbnails and siege engines. |
| `MAPS`, `SOUND` | Unchanged; `buildMap` calls `applyTOD()` for sky, fog and light. |
| `SETTINGS` | `SET` (the ten parameters), `S`, `setValid()` (clamps and whitelists whatever is in storage), `applySetting()`, `TOD`. |
| `SOLDIER BATCHES` | `mkBatch/growBatch/put` (one `InstancedMesh` per body part), `soldierKind()`, effect batches, banner textures. |
| `UNITS / SIMULATION` | `spawn`, `shape`, `mind` (morale), `melee`, `volley`/`land`, `hurtUnit`, `step`. |
| visuals | `drawSoldiers()` writes every soldier and corpse into the batches; `visuals()` does banners, rings, dust, arrows. |
| `DEPLOYMENT` | `canPlace`, `place`, `autoDeploy`, drag to move. |
| `CAMPAIGN MAP` | `GEO` (coastlines, rivers, node positions in lon/lat), `drawCampaign()`, `mapSelect()`. |
| `HUD` | `adv()` advisor, unit cards, stat panel, `orderSelected()`, `drawMini()`, `refreshHUD()`. |
| `FLOW / UI`, input, main loop | States `map | menu | story | deploy | battle | end`; `battleTap()` turns clicks and taps into selection and orders; `govern()` is the quality governor. |

### The regiment model
- `units[]` entries are regiments: `men/max` (drawn soldiers), `hp/hp0` (strength), `mor`, `fat`, `rout`, `charged`,
  `ord` (player order: `{k:'move',x,z}` or `{k:'atk',tgt}`), stance (`st`, `hold`, `firm`), footprint `W × D`, radius `r`.
- The sim counts in **nominal men** (`NOM = 60` for a full infantry block), so the "soldiers per unit" setting changes
  only what is drawn, never the odds.
- Enemy `army` rows become `max(1, round(n/3))` regiments.
- Morale changes in two places: `hurtUnit()` (casualties) and `mind()` (every ~0.5 s: outnumbered, army collapsing,
  breathing space, general's aura, rout, cascade, rally). `melee()` adds the flank/rear drain and the charge shock.
- A battle ends when one side has no regiment that is alive and not routing, or after 480 s on remaining strength.

### Rendering
- Soldiers: per troop kind a `body` and a weapon-`arm` batch; legs per colour; one tinted horse-body and one horse-leg
  batch for all cavalry. `put()` writes a yaw + pitch-about-a-pivot matrix straight into the instance buffer.
- Per-soldier state is three `Float32Array`s (`px, pz, py`) and a yaw array; soldiers ease toward their formation slot.
- Banners are sprites (banner, strip background, strip fill). Arrows, shot, debris and dust are instanced too.
- `HILAL.stats` reports draw calls, triangles and soldier count; `HILAL.bench()` times sim plus instance writes.

### Persistence
- `hilal_progress` — unchanged format `{unlocked, stars[]}`.
- `hilal_settings` — the ten settings; validated on load.

### Checks before shipping
1. `node dev-server.js`, open the game, no console errors.
2. `HILAL.sim(i)` for `i = 0..9` after any balance change.
3. Layout at 1280×720 and 844×390.
4. Bump `CACHE` in `sw.js`.

## 4. Follow-ups
- **Measure on real phones.** Frame rate could not be measured on a GPU. Legs are already skipped when zoomed out; if it still falls
  short, the next steps are dropping arms at distance and merging the three banner sprites per regiment into one batch.
- **Balance pass by a human.** Auto-deploy results match the old game per battle, but the feel of morale, charge and
  fatigue numbers needs play-testing. Nicopolis is a little harder than before.
- **Enemy tactics.** Enemy aggression delays the rear lines and, from 0.7, sends cavalry round the flanks. Reserves and
  protecting the enemy general are not done.
- **Formations and facing.** Regiments cannot change width, and a move order has no drag-to-set facing.
- **Drag-box selection and control groups** on desktop; a halt button.
- **Touch deployment drag.** Dragging a placed regiment works with the mouse only; touch uses tap, Remove and re-place.
- **Campaign map.** Coastlines are hand-drawn and coarse; nodes are not reachable by keyboard (the battle list is).
- **Portrait phones.** Usable, but the layout is tuned for landscape.
- **Siege battles.** Walls and breaches work as before; there are no ladders, towers or gate fights.
- **Old names.** Icon files still say "sancak".
