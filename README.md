# HILAL + dominAI

Two browser games, one repo.

| Folder | Game | Stack | Run |
|---|---|---|---|
| [`hilal/`](hilal) | **HILAL** - 3D historical auto-battler (Ottoman focus, place troops then watch the battle) | single `index.html` + local `three.min.js`, no build step, installable PWA | open `hilal/index.html`, or `node hilal/dev-server.js` -> http://localhost:8765 |
| [`dominai/`](dominai) | **dominAI** - turn-based world-domination strategy on a 3D globe | Vite + TypeScript + Three.js, pure engine in `src/engine`, no backend | `cd dominai && npm install && npm run dev` |

## Working on it with Claude Code

1. Install [Claude Code](https://claude.com/claude-code), [Node.js 20+](https://nodejs.org) and Git.
2. `git clone <this repo>` and open the folder you want to work on (`hilal/` or `dominai/`) in Claude Code.
3. Claude reads that folder's `CLAUDE.md` automatically. It holds the architecture, the rules the original author set, and the checks to run before you push.
4. Work on a branch, push, open a pull request, so two people never overwrite each other. Merge to `main` only after the tests / sim pass.

## Rules both games follow

- Work in small stages and ask before big design changes.
- Do not add features nobody asked for.
- Everything runs offline in the browser. No API keys, no backend. (dominAI can optionally talk to a local Ollama.)
- Never commit secrets: `.env*`, `.vercel/`, tokens. The `.gitignore` files already block these.

## Deploying

Both are static sites and deploy to Vercel / GitHub Pages / Netlify as-is (`hilal/` as the root, `dominai/` after `npm run build` -> `dist/`). Details are in each folder's `CLAUDE.md`.
