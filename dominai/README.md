# dominAI

A browser-based, turn-based world-domination strategy game on a 3D globe. Pick one country and grow it into a world empire through diplomacy, covert operations, engineered chaos and dice-driven war, while every other country is run by an autonomous AI leader with its own personality, memory and agenda.

Everything runs offline in the browser. No backend, no API keys.

## Setup

```bash
npm install
npm run dev        # http://localhost:5183
```

### Desktop icon (Windows)

Double-click **dominAI** on the desktop. The shortcut runs `launcher/launch.vbs` (no console window), which:

1. serves the built game from `dist/` at `http://localhost:5184` and opens it in its own app window (Edge or Chrome, with a separate profile so saves stay with the game);
2. starts the local Ollama server if it is not already running, so the AI aide works (it looks on the PATH, in the standard install folders and in `DOMINAI_OLLAMA`);
3. when you close the window, stops the game server, and stops Ollama again only if the launcher was the one that started it.

After changing the code run `npm run build` so the desktop version picks it up. `node launcher/make-icon.cjs` redraws the icon. Problems are written to `launcher/launcher.log`. Saves made in the desktop window are separate from saves made in the dev server (`npm run dev`).

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the game (Vite dev server) |
| `npm run build` | Type-check and build to `dist/` |
| `npm test` | Unit tests (combat, economy, AI scoring, determinism) |
| `npm run simulate` | Headless balance check: 100 AI-vs-AI games of 10 years. `npm run simulate -- 20 5 myseed` = 20 games, 5 years, seed prefix |
| `npx tsx scripts/odds.ts` | Print the combat odds table |

## Controls

| Input | Action |
| --- | --- |
| Drag | Rotate the globe |
| Scroll | Zoom |
| Click a country | Select it (camera flies there, left panel opens) |
| `1` to `6` | Map modes: Political, Economy, Military, Stability, Influence, Relations |
| `T` | Terrain view of the selected country |
| `Space` / `Enter` | End turn |
| `Esc` | Close a dialog |

**How to play.** One turn is one month. You spend **Action Points** (AP) and money, then press **END TURN**: all AI leaders act, chaos spreads, the economy updates, events fire and you get a turn report.

- **Left panel (selected country):** *Overview* (leader, stats, development levels), *Develop* (your own lands: buildings, laws, decrees) and *Actions* (political, covert, chaos, military).
- **Right panel:** *Command* (the command board), *Advisors* (ranked recommendations with odds, cost and risk; "Do it" executes one), *Threats* (threat radar) and *Log*.
- **Bottom:** map-mode tabs and the news ticker.

### Terrain view

A flat relief map of the region around a country, in the style of an atlas sheet. It opens in two ways:

- the **Terrain** tab at the bottom (or key `T`) shows the selected country, its borders and garrisons;
- clicking **Attack** or **Deploy troops here** opens it first as a briefing (objective, terrain, barracks, your launch points or the hostile neighbours), and **Proceed to deployment** leads on to the troop dialog. Orders given through the Command board or an advisor's "Do it" skip the briefing.

Borders, names, troop numbers and the rough/open terrain rating are live game data. The relief itself is procedural (`src/render/terrain.ts`): the game ships no elevation data, so individual peaks and valleys are illustrative, drawn stronger in countries rated as rough terrain.

### Command board

Type an order in plain words and it is carried out through the normal game rules (same AP, cost and odds as clicking):

| You type | What happens |
| --- | --- |
| `Deploy 50k troops to the border with Syria` | Moves troops to your land that touches Syria |
| `Attack Kuwait with 100k` / `Invade Kuwait` | Attacks (or declares war first if you are at peace) |
| `Recruit 40k troops` | Recruits in the selected land or your homeland |
| `Run a propaganda campaign in Iran`, `incite protests in ...`, `bribe`, `coup`, `cyberattack`, `spy` ... | The matching political, covert or chaos action |
| `Raise taxes`, `lower taxes`, `introduce conscription`, `declare martial law`, `censor the press` | Changes a law |
| `Build farms`, `build barracks`, `grow the economy` | Builds the matching building |
| `Propose a trade deal with Turkey`, `alliance`, `treaty`, `sanction`, `peace` | Diplomacy |
| `End turn` | Ends the month |

Orders without a country apply to the selected one.

**Two aides.** The board works in one of two modes, shown at the top of the Command tab ("AI settings" switches):

- **Ollama model (chat):** if an [Ollama](https://ollama.com) server is running on this computer (default `http://localhost:11434`), the aide is a local language model. You can chat with it ("what is our biggest danger?"), and give orders in your own words, several at once ("develop agriculture, raise taxes and start propaganda in Tajikistan"). It gets a briefing of the current situation with every message and answers with a short reply plus up to 3 actions, which are executed through the normal rules (AP, cost, odds). Nothing leaves your machine and there is no API key. Start Ollama with `ollama serve` (or the Ollama app) and install a model, e.g. `ollama pull qwen3:14b`. The game switches the aide on by itself the first time it finds a model. Code: `src/ai/ollama.ts`.
- **Offline parser:** a keyword parser (`src/ai/command.ts`) that needs nothing installed. It only understands orders like the ones in the table, one at a time, and cannot chat. The game falls back to it automatically whenever Ollama does not answer.

The model can misread an order or pick a weaker action than you meant; the result lines under each answer show exactly what was done.

- **Win:** your bloc (your lands + your puppets) holds 60% of world GDP + military, or no independent nation is left.
- **Lose:** your homeland is captured, your home stability falls to 5 (coup), or you stay bankrupt for 4 months (the army deposes you).

The game autosaves to `localStorage` at the end of every turn. Save / Load / New game / difficulty / sound / tutorial are in the **Menu**.

## Project layout

```
src/engine/   pure TypeScript game logic (no DOM, no Three.js) - unit-testable
  config.ts     ALL tunable balance numbers
  state.ts      game creation, queries, power formula
  actions.ts    every action (shared by player and bots), buildings, laws, diplomacy acceptance
  combat.ts     Risk-style dice battles + Monte-Carlo odds
  economy.ts    budgets, growth, manpower
  tick.ts       chaos transmission, stability, rebellions, coups, relations, coalitions
  events.ts     random/conditional events and player choices
  nation.ts     wars, conquest, puppets, nation death/restoration
  turn.ts       end-of-turn pipeline, victory check
  rng.ts        seeded RNG (state lives in the save)
src/ai/       bot.ts (utility AI), advisor.ts (advisor personas + threat radar), command.ts (command board interpreter)
src/render/   Three.js globe, canvas map painter, map-mode colours
src/ui/       DOM HUD, dialogs, save/load, sound, leader portraits
src/data/     countries.json (seed stats) + world.ts (borders from world-atlas)
scripts/      simulate.ts, odds.ts
tests/        vitest suite
```

## Data

- Borders: Natural Earth 1:50m via `world-atlas` / `topojson-client`. Land neighbours come from shared border arcs; sea links are a hand-written list of major sea lanes plus automatic nearest-coast links for islands.
- `src/data/countries.json`: **approximate** circa-2023 values for GDP (US$ billions), population (millions), active troops (thousands), a 1-10 tech level, stability, government type and an oil rating for 189 countries. They are rough, for gameplay only. Dependencies (Greenland, Puerto Rico, ...) are merged into their parent; a few micro-territories without data are neutral grey land.
- Each country is one territory. A nation exists while it holds its own home territory.

## Design doc: the formulas

All constants are in `src/engine/config.ts`; names below refer to it.

### Power and victory

```
military(nation) = sum(troops) * (tech / 5) ^ 1.5
power            = (0.55 * GDP/maxGDP + 0.45 * military/maxMilitary) * (0.8 + 0.2 * stability/100)
empire share     = (bloc GDP / world GDP + bloc military / world military) / 2      // bloc = you + puppets
```

Power drives the leaderboard. Empire share is the victory metric (win at `win.share` = 60%). Occupied land counts at half its GDP. The spec's example added stability as a flat term; here it is a multiplier so that tiny stable states do not outrank large ones.

### Economy (monthly, money in US$ billions)

```
territory yield = statusFactor * (1 - unrest/160) * (0.6 + 0.4*stability/100) * (1 + 0.02*oil)
   statusFactor = 1 (home) | 0.3 (occupied) | 0.5..1 by integration (annexed)
gross income    = sum(GDP * 0.015 * yield) * (1 + 0.03 * tradeDeals) * (1 - sanctions) * difficulty
sanctions       = min(0.4, sum over sanctioning powers of 0.04 * clamp(theirGDP / yourGDP, 0.2, 3))
net             = gross + tribute (25% of each puppet's income) + loan interest (3%) - troops * unitCost
GDP growth      = +0.25%/month * stability/100 * (1 - unrest/100), minus war and high-unrest drag
manpower cap    = 5% of controlled population (annexed land counts 60%, occupied 20%)
```

`unitCost` is set per nation at game start so that its real-world army costs 35% of its starting income (rich countries pay more per soldier). Recruiting 1k troops costs 8 months of upkeep. Economy feeds the army (upkeep, recruitment, research); war damages GDP (6% per battle fought over a land); chaos cuts income and growth.

### Development: buildings and laws

Three building types per land, levels 0-5, cost `land GDP * 1% * (level + 1)`, 1 AP each:

| Building | Branch | Per level |
| --- | --- | --- |
| Farms | Agriculture | food +1 (famine protection), stability target +1.5, manpower +4% |
| Barracks | Military | recruiting 8% cheaper in that land, +0.1 on its defence dice |
| Industry | Economy | income +5%, GDP +2% when built, faster growth |

Laws are nation-wide switches (1 AP to change):

| Law | Effect |
| --- | --- |
| Taxes low / normal / high | income 85% / 100% / 120%, stability +4 / 0 / -6 |
| Conscription | manpower x1.5, recruiting 25% cheaper, stability -4 |
| Martial law | unrest -3 per month in every land, stability -5, slower growth |
| Press censorship | half as much foreign chaos gets in, foreign ops easier to catch, stability -2 |

Bots build and legislate too (industry when greedy, barracks when threatened, conscription at war, high taxes when broke).

### Stability and unrest

Each land has `stability` and `unrest` (chaos) 0-100 that drift back to that land's baseline.

```
unrest  += occupation (+6, less with a garrison) | un-integrated annexation (+2.5) | overstretch | war exhaustion
target   = baseline - 0.6*(unrest above baseline) - 0.35*warExhaustion - broke malus - overstretch malus (home)
stability moves 12% of the way to target each month
```

- Garrison need: 1.2k troops per million people. Held land with unrest 78+ can **rebel** and restore its nation.
- Bots are couped below stability 14; the player loses at 5.

### Chaos transmission (Plague-style)

A land with unrest above `chaos.threshold` (38) is contagious. Each month, for every link:

```
p = 0.3 * (unrest - 38)/62 * vectorWeight * (1 - targetStability/130)
vectorWeight: land border 1.0 | trade partner of the owner 0.5 | sea/media link 0.3
```

A misinformation campaign doubles the weights for 4 months. Unrest only flows from higher to lower.

### Imperial overstretch and infamy

```
overstretch points = (occupied lands + un-integrated share of annexed lands) - 2 free
home stability target -= min(28, 1.6 * points); every held land gains extra unrest
infamy: +12 declaring war (less with a grudge/casus), +9 annexation, +5 puppet, +8 failed coup; decays 0.6/month
```

Infamy sours relations with everyone. A **coalition** forms against any power whose share passes the difficulty threshold (26% on Normal) or whose infamy reaches 45: members sanction the target and get a large bonus to declaring war on it. Puppets avoid overstretch, which is why the Diplomat keeps arguing with the General.

### Combat (Risk-style dice)

Armies are chunked into about 14 units per side. Each exchange the attacker rolls up to 3 dice, the defender up to 2; dice are sorted and compared pairwise; each lost pair costs one unit. The attacker retreats at 30% strength.

```
edge = attackerMod - defenderMod
attacker wins a pair when  attDie + edge + (u - 1) >= defDie,  u uniform in [0,1)
```

With `edge = 0` this is exactly Risk (ties go to the defender). Modifiers: tech (0.18 per level of advantage, max 1.2), morale/supply ((stability - 50) * 0.012 for each side), rough terrain (+0.6 defender), amphibious assault (-0.8 attacker), defending the homeland (+0.35), cyber-disrupted command (-0.6). The attack dialog shows a Monte-Carlo what-if preview (240 simulated battles) before you commit.

Capturing a nation's home territory ends that nation; its other lands capitulate to the conqueror. Occupied land can be annexed, turned into a puppet, or liberated.

### Covert operations and fog of war

```
detection = base * (1 - 0.07*spyLevel) * (0.7 + 0.6*targetParanoia) * difficulty
```

A detected op is traced to its author 55% of the time (+2% per target tech level): relations drop, the target holds a grudge, infamy rises. If it is detected but not traced, a paranoid target may blame whoever it already distrusts most. Undetected ops have no diplomatic effect at all: bots only react to what they found out, and the same rules apply to bot operations against you.

### Bot leaders (utility AI)

Every nation has a generated leader (name, portrait, six traits: aggression, paranoia, ambition, diplomacy, greed, loyalty; a goal; a government type that biases the traits). Each month every bot:

1. Scores each candidate action (attack, declare war, peace, recruit, research, build, change laws, crack down, alliance, trade, treaty, sanction, betrayal, vassalage, coup, bribery, spying, sabotage, chaos ops, annex/puppet).
2. Multiplies each score by personality-weighted noise (`ai.noise`, larger for aggressive/ambitious leaders).
3. Executes the best 1-3 through the same `doAction()` the player uses.

War desire combines aggression, ambition, grudges, relations, the target's instability and distraction, coalition membership and the military ratio (needs 1.25:1), minus a peace inertia, existing wars, war exhaustion and own infamy. Bots remember grudges, betrayals and promises; they join coalitions, call in allies, sue for peace when losing, break away from weak overlords and fight each other, not only you.

### Advisors

Rule-based and offline. Military, Intelligence, Economy and Diplomat each read the state and emit ranked advice with success chance (the real acceptance check or Monte-Carlo odds), cost and risk. They can object to each other (annex vs puppet, war vs budget). The threat radar runs the bots' own war-desire function against you and lists the reasons.

### Events

Famine, global financial crash, pandemic, revolution, nuclear scare, natural disaster, scandal, UN resolution, arms race. About one every two months. When one hits you, you get a choice with trade-offs; bots resolve theirs automatically.

### Difficulty

| | Player income | Bot income | Bot aggression vs you | Coalition at share | Detection |
| --- | --- | --- | --- | --- | --- |
| Easy | 125% | 90% | 60% | 32% | 80% |
| Normal | 100% | 100% | 100% | 26% | 100% |
| Hard | 90% | 110% | 130% | 22% | 115% |
| Brutal | 80% | 125% | 170% | 18% | 130% |

### Determinism

The RNG (mulberry32) state is part of the game state, so a seed always produces the same world and a loaded save continues with the same random sequence. Combat previews use a separate throw-away generator.

## Balance simulation

`npm run simulate` plays AI-vs-AI games with no human and reports wars, battles, alliances, coalitions, fallen nations, the top power's empire share and which country finishes on top. A 10-game, 10-year run with the shipped config gave roughly: 20 wars, 21 alliances and 14 conquered nations per game, about 149 of 189 nations still alive, the top power holding 19% at the start and 19% on average at the end (max 24%), and no bot reaching the 60% win threshold.
