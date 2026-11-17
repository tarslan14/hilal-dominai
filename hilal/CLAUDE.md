# HILAL - guide for Claude

3D place-troops-then-auto-battle game with Turkish/Ottoman focus. One `index.html` (game + UI + data) plus a local `three.min.js` (r160). No build step, works from `file://`, installable PWA (`manifest.webmanifest`, `sw.js`).

## Run
- Double-click `index.html`, or `node dev-server.js` -> http://localhost:8765
- Headless balance check in the browser console: `window.HILAL.sim(levelIndex)` runs a battle with the auto-deployed army. Re-run it on EVERY level after any balance change.

## Direction (from the original author)
- Educational strategic war game: battles in chronological order, new weapons unlock as history advances (gate units by year with `from` on the unit type), more maps and wars over time, rich history text with "Did you know" facts.
- Slow, readable battle pace.
- Visual target: low-poly, dark warm torch-lit mood, long shadows.
- Must play well on phones: two on-screen thumb sticks (left = move, right = look) plus tap-to-place. Check layout at 844x390.
- Terrain rules per map (hills, forest, marsh, stakes, wagons, cliffs) and pre-battle orders (Charge, Hold, Flank, Guard).

## Rules
- Add battles in date order with story text. Keep everything offline and in the single-file structure unless the human agrees to split it.
- Work in small steps and ask before big redesigns; do not add unrequested features.

## Deploy
Static folder, `vercel.json` already sets headers. When you ship a change, bump `CACHE` in `sw.js` so installed phones refresh. The original author deploys with `npx vercel deploy --prod --yes`; your friend should link their own Vercel project (or use GitHub Pages) - never commit `.vercel/` or `.env*`.

Note: the folder/icon filenames still say "sancak" (the game's old name).
