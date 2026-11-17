# Changelog

## Unreleased — Total War rework

HILAL moves from "place single troops and watch" toward a Total War style battle. The 3D renderer, the ten battles,
unlock progress, PWA install and the thumb-stick controls are kept. Saved progress (`hilal_progress`) carries over.

### Added
- **Campaign map** as the home screen: a stylised map of Rumelia, Anatolia and Egypt with the ten battles as nodes on a
  road. Nodes show the enemy's colours, a lock, or a check once won. Pan, zoom and pinch work. A province panel shows
  name, year, date and place, both sides and commanders, a description, stars and **Deploy army**. The old battle list is
  still there (**Battle list**).
- **Battle HUD** in the Rome II layout: advisor with the general's portrait (top-left), strength-balance bar and battle
  clock (top-centre), unit cards with men, health, morale and routed state (bottom-centre), stat panel for the selected
  regiment with seven bars (bottom-left), minimap with terrain and the camera view (bottom-right). Bronze and stone
  panels with gold trim; Cinzel headings and EB Garamond text, vendored so the game stays offline.
- **Orders during the battle.** Click or tap a regiment or its card, then right-click (tap on touch) the ground to move
  or an enemy to attack. Shift/Ctrl-click adds to the selection, Ctrl+A selects all, Esc clears. Orders work while paused.
- **Deployment:** placed regiments can be dragged with the mouse. At most 20 regiments.
- **Settings panel** with ten live parameters, saved in `localStorage['hilal_settings']`: battle speed, soldiers per
  unit, morale toughness, flank and rear bonus, enemy aggression, camera tilt, interface scale, banner size, interface
  theme (Rome bronze, Ottoman crimson, Night campaign) and time of day (golden dusk, noon, misty dawn, night watch).
- **Heraldic banners** above every regiment with a health strip; the general's banner has a gold border.
- **Dust** behind moving cavalry and at the point of a charge; gun smoke for janissaries and bombards.

### Changed
- **A unit is now a regiment** of individual soldiers in formation, not one soldier. Enemy armies are the same
  historical line-ups, grouped three troops to one regiment. Troop prices are tripled to match (commander and siege
  engine keep their price), so the war chests buy a similar army.
- **Morale** is per regiment: it falls with casualties, flank and rear attacks, being outnumbered and the army
  collapsing; it recovers in the open and near the general. A routing regiment runs for its camp under a flashing white
  banner, spreads panic to friends nearby, and may rally.
- **Flank and rear attacks** multiply damage and drain morale. **Charges** give a bonus on first contact, stronger for
  cavalry, and are cancelled by braced spears, rough ground and attacking uphill. **Fatigue** builds while marching and
  fighting and slows and weakens a regiment.
- **Ranged regiments fire arcing volleys** at where the target stood, so a fast target can ride out from under one.
  Horse archers still skirmish away from infantry.
- **The commander is a mounted general with a bodyguard.** Losing him costs the whole army morale and removes his aura.
- **Soldiers are drawn with instancing.** Vienna, the largest battle, draws about 1,300 soldiers in about 175 draw calls
  on desktop; on phones soldiers use a lighter mesh and default to 40 per unit. A governor lowers resolution, then
  shadows, if frames stay slow.
- **Enemy aggression** delays the enemy's rear lines when low; at 0.7 and above the enemy cavalry rides wide to hit
  your flanks. The default (0.6) keeps the old straight advance.
- When the camera is zoomed far out, soldiers are drawn without legs to save work.
- The camp-fire dusk look is now the "Golden dusk" time of day and stays the default.
- Stars need 60% (three) or 35% (two) of the army's value left, since routed enemies now leave more survivors.
- Service worker cache bumped to `hilal-v10`; fonts are precached.

### Removed
- The per-soldier skeleton animation (replaced by instanced poses) and the floating toast (messages go to the advisor).
- Squad sizes ×5 and ×10 in deployment (now ×1, ×2, ×3 regiments).

### Verification
- `HILAL.sim(i)` on all ten battles with auto-deploy, five runs each: battles 1–9 are won most of the time (Nicopolis
  3 of 5), Vienna is lost, as before the rework.
- Headless Chromium playthroughs at 1280×720 and 844×390 (touch): map, province panel, settings and persistence,
  deployment, move and attack orders, routing, charge, flank hits, fatigue, end screen. No console errors, no network
  requests off the origin. Layout also checked at 390×844.
- Not verified: frame rate on real phones. The test machine has no GPU, so only per-frame game logic (about 1 ms) and
  scene size could be measured.

### Follow-ups
See the list at the end of `ARCHITECTURE.md`.
