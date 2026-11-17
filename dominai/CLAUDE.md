# dominAI - guide for Claude

Browser turn-based world-domination game on a 3D globe. Vite + TypeScript + Three.js, DOM/CSS UI, no backend, no API keys. ~190 countries from Natural Earth (`world-atlas`).

## Commands
- `npm install` then `npm run dev` (Vite, http://localhost:5183)
- `npm test` (vitest, 29 tests - must stay green)
- `npm run build` (typechecks, then bundles to `dist/`)
- `npm run simulate -- <games> <years>` - headless bot-vs-bot balance sim. Run after any balance/AI change. Healthy baseline: ~20 wars, ~14 nations fallen in 10 years, top power ~19%, nobody reaches the 60% victory share.

## Architecture
- `src/engine/` - PURE game logic, no DOM. Seeded RNG (mulberry32) lives in state so games are deterministic. `config.ts` holds ALL tunable numbers - change balance there, not in logic. `actions.ts` is the single action layer shared by player, bots and the AI command board (`doAction`), so rules always apply.
- `src/ai/` - `bot.ts` utility-AI leaders, `advisor.ts` rule-based advisors/threat radar, `command.ts` offline keyword parser for the command board, `ollama.ts` optional local-LLM aide (falls back to the parser when Ollama is absent).
- `src/render/` - `globe.ts`/`painter.ts`/`colors.ts` the 3D earth (user wants it left as is), `terrain.ts` the procedural relief "theatre map".
- `src/ui/` - `app.ts` (HUD, tabs, dialogs), `save.ts` (localStorage `dominai.save.v2`; bump the version if the state shape changes), `sound.ts`.
- `launcher/` - Windows desktop-icon launcher (Node + VBS, serves `dist/` on port 5184, starts Ollama if found). Set `DOMINAI_OLLAMA` to your ollama.exe if it is not on PATH.
- `README.md` documents the formulas (power, dice, chaos, influence) - keep it in sync with `config.ts`.

## Style / rules
- Palette: gold/brown RPG menu (`--accent #dba94a`, serif headings). Keep it.
- Work in stages, ask before large design changes, do not add unrequested features.
- Orders given through the command board or advisors must go through `doAction`, never mutate state directly.
- Add a test in `tests/engine.test.ts` for new engine rules.

## Deploy
Static site. `npm run build`, then deploy `dist/` (add `{"cleanUrls":true}` `vercel.json` on Vercel). The hosted version has no Ollama, so the aide falls back to the offline parser.

## Known gaps
60fps not measured on low-end machines; end screen / replay, tutorial and save-load buttons only lightly tested; the 100-game simulation was only run at 20 games.
