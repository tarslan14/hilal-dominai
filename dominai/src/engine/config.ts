// ALL tunable balance numbers live here. Formulas are documented in README.md ("Design doc").

export type Difficulty = 'easy' | 'normal' | 'hard' | 'brutal';

export const CONFIG = {
  // ----- power formula: power = (wGdp*norm(GDP) + wMil*norm(military)) * (1 - wStab + wStab*stability/100)
  power: { wGdp: 0.55, wMil: 0.45, wStab: 0.2 },
  /** military strength = troops * (tech / techRef) ^ techExp */
  mil: { techRef: 5, techExp: 1.5 },

  // ----- economy (money in $B, one turn = one month)
  eco: {
    taxRate: 0.015, // monthly budget as a share of annual GDP
    startTreasuryMonths: 6,
    startUpkeepShare: 0.35, // starting army upkeep as a share of starting income
    unitCostMin: 0.00005,
    recruitMonths: 8, // recruiting 1k troops costs this many months of its upkeep
    manpowerShare: 0.05, // max troops as a share of population
    baseGrowth: 0.0025, // monthly GDP growth at 100 stability
    occupiedIncome: 0.3,
    annexedIncomeMin: 0.5, // income factor at 0 integration (-> 1 at 100)
    integrationPerTurn: 2.5,
    puppetTribute: 0.25,
    tradeBonus: 0.03, // income bonus per trade deal
    tradeMaxDeals: 6,
    sanctionPenalty: 0.04, // income malus per sanctioning power, weighted by its relative size
    sanctionMaxPenalty: 0.4,
    oilIncome: 0.02, // income bonus per oil point
    warDamage: 0.06, // GDP lost by a territory each time it is fought over
    researchCost: 0.004, // x nation GDP x tech level
    researchGain: 0.25,
    techMax: 12,
    debtInterest: 0.03,
    bankruptcyTurns: 4, // consecutive turns below the debt limit -> coup
    debtLimitMonths: 6,
  },

  // ----- stability / unrest
  stab: {
    baseTarget: 68,
    govBonus: { democracy: 6, autocracy: 0, monarchy: 4, oneparty: 3, theocracy: -2, junta: -6, hybrid: -2, failed: -25 } as Record<string, number>,
    unrestWeight: 0.6,
    warExhaustionWeight: 0.35,
    brokeMalus: 15,
    drift: 0.12, // share of the gap to target closed per turn
    unrestDecay: 2.2,
    occupationUnrest: 6,
    annexedUnrest: 2.5,
    garrisonPerMPop: 1.2, // troops (k) per million people needed to hold an occupied land quietly
    rebellionThreshold: 78,
    rebellionChance: 0.22,
    coupThreshold: 14,
    coupChance: 0.12,
    playerCoupStability: 5,
    suppressUnrest: 14,
    suppressStability: -3,
  },

  // ----- chaos transmission (Plague-style)
  chaos: {
    threshold: 38, // unrest above which a country is "infectious"
    beta: 0.3, // base transmission chance per link per turn at full unrest
    borderWeight: 1.0,
    tradeWeight: 0.5,
    mediaWeight: 0.3, // sea links / same-government "media sphere"
    mediaBoost: 2.0, // multiplier while a misinformation campaign is active
    doseMin: 3,
    doseMax: 8,
  },

  // ----- imperial overstretch
  overstretch: {
    freeTerritories: 2,
    perTerritory: 1.6, // home stability malus per un-integrated territory beyond the free ones
    maxMalus: 28,
    unrestPerPoint: 0.12,
    infamyAnnex: 9,
    infamyWar: 12,
    infamyPuppet: 5,
    infamyDecay: 0.6,
  },

  // ----- combat (Risk-style dice)
  combat: {
    targetRounds: 14, // battles are chunked into ~this many "units" per side
    attDice: 3,
    defDice: 2,
    techMod: 0.18, // die modifier per tech level of advantage
    techModMax: 1.2,
    moraleMod: 0.012, // per stability point away from 50
    terrainMod: 0.6,
    amphibiousMalus: 0.8,
    homeFortMod: 0.35,
    disruptedMalus: 0.6,
    retreatAt: 0.3, // attacker retreats when this share of the force is left
    occupationUnrest: 30,
    oddsSamples: 240,
  },

  // ----- development: three building types, levels 0..max, built per land
  build: {
    max: 5,
    costShare: 0.01, // cost = land GDP * costShare * (level + 1)
    farmStab: 1.5, // stability target per farm level
    farmManpower: 0.04, // manpower per farm level
    farmFood: 1, // food rating per level (famine protection)
    barracksRecruit: 0.08, // recruit discount per level
    barracksDef: 0.1, // defender die modifier per level
    industryIncome: 0.05, // income per level
    industryGdp: 0.02, // one-off GDP boost when built
    industryGrowth: 0.0002, // extra monthly growth per level
  },
  // ----- laws (nation-wide switches)
  laws: {
    taxIncome: [0.85, 1, 1.2], // low / normal / high
    taxStab: [4, 0, -6],
    conscriptManpower: 1.5,
    conscriptRecruit: 0.75,
    conscriptStab: -4,
    martialUnrest: 3, // unrest removed per month in every land
    martialStab: -5,
    martialGrowth: 0.001,
    censorChaos: 0.5, // multiplier on unrest flowing in
    censorDetect: 1.25, // foreign ops are easier to catch
    censorStab: -2,
  },

  // ----- actions
  ap: { base: 3, perSqrtTerritory: 1, perPuppets: 3, max: 10 },
  costScale: { exp: 0.7 }, // political/covert costs scale with target GDP ^ exp
  influence: { decay: 0.5, coupMin: 45, absorbMin: 75, vassalPowerRatio: 4 },
  covert: {
    spyMax: 5,
    spyDetectReduction: 0.07,
    spySuccessBonus: 0.06,
    attribution: 0.55, // chance a detected op is traced to its author
    paranoiaAttribution: 0.25,
  },
  diplomacy: {
    allianceMin: 40,
    tradeMin: -5,
    truceTurns: 12,
    pactTurns: 24,
    allyJoinBase: 0.55,
    relDriftToBase: 0.04,
  },
  coalition: { minInfamy: 45, relBoost: 15, minMembers: 3, dissolveShare: 0.7 },
  win: { share: 0.6 },

  difficulty: {
    easy: { playerIncome: 1.25, botIncome: 0.9, botAggro: 0.6, coalitionShare: 0.32, detection: 0.8, apBonus: 1 },
    normal: { playerIncome: 1.0, botIncome: 1.0, botAggro: 1.0, coalitionShare: 0.26, detection: 1.0, apBonus: 0 },
    hard: { playerIncome: 0.9, botIncome: 1.1, botAggro: 1.3, coalitionShare: 0.22, detection: 1.15, apBonus: 0 },
    brutal: { playerIncome: 0.8, botIncome: 1.25, botAggro: 1.7, coalitionShare: 0.18, detection: 1.3, apBonus: 0 },
  } as Record<Difficulty, { playerIncome: number; botIncome: number; botAggro: number; coalitionShare: number; detection: number; apBonus: number }>,

  // ----- AI
  ai: { noise: 0.18, maxActions: 3, warPowerRatio: 1.25, peaceExhaustion: 45, peaceInertia: 0.85, warThreshold: 0.7 },
  events: { perTurnChance: 0.5, playerBias: 0.2 },
};
