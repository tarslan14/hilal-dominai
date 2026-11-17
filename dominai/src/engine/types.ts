import type { Difficulty } from './config';

export type Gov = 'democracy' | 'autocracy' | 'monarchy' | 'oneparty' | 'theocracy' | 'junta' | 'hybrid' | 'failed';

export interface Traits {
  aggression: number;
  paranoia: number;
  ambition: number;
  diplomacy: number;
  greed: number;
  loyalty: number;
}

export type Goal = 'conquest' | 'wealth' | 'security' | 'influence' | 'survival';

export interface Leader {
  name: string;
  title: string;
  seed: number; // drives the generated portrait
  traits: Traits;
  goal: Goal;
}

export interface Memory {
  grudges: Record<string, number>; // 0..100 per nation id
  betrayedBy: string[];
  promises: Record<string, number>; // pact partner -> turn signed
}

/**
 * Every country is both a TERRITORY (land that can change hands) and, while it controls its own
 * home territory, a NATION (an actor with a leader, treasury and diplomacy).
 */
export interface Country {
  id: string;
  name: string;
  neighbors: string[];
  seaLinks: string[];
  terrain: number;
  lon: number;
  lat: number;
  // --- territory
  gdp: number;
  population: number;
  troops: number; // thousands stationed here
  stability: number;
  unrest: number;
  baseStab: number; // long-run stability this land drifts back to
  baseUnrest: number;
  resources: { oil: number; food: number; industry: number };
  owner: string; // nation id controlling this territory
  status: 'home' | 'occupied' | 'annexed';
  integration: number;
  buildings: Buildings; // development levels 0..CONFIG.build.max
  mediaInfected: number; // turns of active misinformation campaign
  disrupted: number; // turns of cyber disruption
  // --- nation
  alive: boolean;
  treasury: number;
  tech: number;
  government: Gov;
  leader: Leader;
  laws: Laws;
  overlord: string | null;
  allies: string[];
  wars: string[];
  sanctions: string[]; // nations this one sanctions
  trade: string[];
  pacts: Record<string, number>; // non-aggression pacts: partner -> expiry turn
  truces: Record<string, number>;
  influence: Record<string, number>; // foreign nation id -> its influence here (0..100)
  spies: Record<string, number>; // foreign nation id -> spy network level here
  debt: { to: string; amount: number } | null;
  memory: Memory;
  infamy: number;
  unitCost: number; // monthly upkeep per 1k troops
  warExhaustion: number;
  brokeTurns: number;
  lastIncome: number;
  lastUpkeep: number;
  hue: number;
}

export type BuildingId = 'farm' | 'barracks' | 'industry';
export type Buildings = Record<BuildingId, number>;
export interface Laws {
  tax: -1 | 0 | 1; // low / normal / high
  conscription: boolean;
  martial: boolean;
  censorship: boolean;
}

export type NewsKind = 'war' | 'combat' | 'diplo' | 'covert' | 'chaos' | 'econ' | 'event' | 'system';

export interface NewsItem {
  turn: number;
  kind: NewsKind;
  text: string;
  importance: 1 | 2 | 3;
  ids: string[];
}

export interface ChoiceOption {
  label: string;
  desc: string;
  effect: string; // key handled by events.ts
}

export interface PendingChoice {
  id: number;
  eventId: string;
  title: string;
  text: string;
  targetId: string;
  options: ChoiceOption[];
}

export interface HistoryEntry {
  turn: number;
  share: number; // player's (or top power's) empire share
  top: [string, number][]; // top powers by share
  changes: [string, string][]; // territory id -> new owner this turn
}

export interface FxEvent {
  kind: 'arc' | 'pulse' | 'conquer';
  from?: string;
  to: string;
  color?: string;
}

export interface GameState {
  version: number;
  seed: string;
  rng: number;
  turn: number;
  playerId: string | null;
  difficulty: Difficulty;
  countries: Record<string, Country>;
  ids: string[];
  relations: Record<string, number>;
  ap: number;
  news: NewsItem[];
  choices: PendingChoice[];
  choiceSeq: number;
  history: HistoryEntry[];
  startOwners: Record<string, string>;
  coalition: { target: string; members: string[]; since: number } | null;
  over: { won: boolean; reason: string; turn: number } | null;
  stats: { battlesWon: number; battlesLost: number; ops: number; opsDetected: number; annexed: number; puppets: number; warsDeclared: number };
  fx: FxEvent[]; // transient visual cues, drained by the renderer (never needed for logic)
  pendingChanges: [string, string][];
}

export interface CombatRound {
  att: number[];
  def: number[];
  won: boolean[]; // per compared pair: did the attacker win it
  attLost: number;
  defLost: number;
}

export interface CombatResult {
  win: boolean;
  attStart: number;
  defStart: number;
  attLeft: number;
  defLeft: number;
  attMod: number;
  defMod: number;
  rounds: CombatRound[];
  notes: string[];
}

export interface ActionResult {
  ok: boolean;
  msg: string;
  detected?: boolean;
  combat?: CombatResult;
}
