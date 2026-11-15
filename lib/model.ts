export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  watchlist: string[];
  protocols: SnapshotProtocol[];
}

export interface FactorBreakdown {
  tvl: number;
  sizeMultiple: number;
  infra: boolean;
  implied: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  rank: number;
  implied_value_usd: number;
  size_multiple: number;
  infra: boolean;
  farm_steps: string[];
}

export interface ValueCurve {
  intercept: number;
  slope: number;
  infra: number;
  n: number;
  clampMin: number;
  clampMax: number;
}

// Categories where TVL is not the product: a chain, an exchange, a bridge,
// a prediction market, a CeDeFi vault or a governance-incentives protocol
// earns its footprint off-chain or off its own TVL, so its TVL understates
// it. The list is explicit: a category not named here is not infra.
export const INFRA_CATEGORIES: ReadonlySet<string> = new Set([
  "Chain",
  "CEX",
  "Bridge",
  "Canonical Bridge",
  "Prediction Market",
  "CeDeFi",
  "Governance Incentives",
]);

export function isInfra(category: string | null): boolean {
  return category !== null && INFRA_CATEGORIES.has(category);
}

const FALLBACK_INTERCEPT = 3.3114;
const FALLBACK_SLOPE = -0.5269;
const FALLBACK_INFRA = 0.4686;
const CLAMP_MIN = 0.02;
const CLAMP_MAX = 0.8;

// Fit log10(mcap / TVL) = a + b * log10(TVL) + c * [infra] by OLS on the
// snapshot's live tokens (mcap > 0, tvl > 0). Three coefficients, fitted at
// run time from the snapshot itself: no hardcoded multiple, no assumed
// discount. Solved through the 3x3 normal equations with Gaussian
// elimination; a degenerate design falls back to the shipped run's fit.
export function fitValueModel(live: SnapshotProtocol[]): ValueCurve {
  const points: Array<{ x: number; z: number; y: number }> = [];

  for (const protocol of live) {
    const tvl = protocol.tvl_usd;
    const mcap = protocol.mcap_usd;

    if (
      typeof tvl !== "number" ||
      typeof mcap !== "number" ||
      !Number.isFinite(tvl) ||
      !Number.isFinite(mcap) ||
      tvl <= 0 ||
      mcap <= 0
    ) {
      continue;
    }

    points.push({
      x: Math.log10(tvl),
      z: isInfra(protocol.category) ? 1 : 0,
      y: Math.log10(mcap / tvl),
    });
  }

  const n = points.length;
  const fallback = {
    intercept: FALLBACK_INTERCEPT,
    slope: FALLBACK_SLOPE,
    infra: FALLBACK_INFRA,
    n,
    clampMin: CLAMP_MIN,
    clampMax: CLAMP_MAX,
  };
  if (n < 10) {
    return fallback;
  }

  // Normal equations for [1, x, z]: A^T A beta = A^T y.
  const ata: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const aty: number[] = [0, 0, 0];
  for (const point of points) {
    const row = [1, point.x, point.z];
    for (let i = 0; i < 3; i++) {
      aty[i] += row[i] * point.y;
      for (let j = 0; j < 3; j++) {
        ata[i][j] += row[i] * row[j];
      }
    }
  }

  // Gaussian elimination with partial pivoting on the augmented matrix.
  const m: number[][] = [
    [ata[0][0], ata[0][1], ata[0][2], aty[0]],
    [ata[1][0], ata[1][1], ata[1][2], aty[1]],
    [ata[2][0], ata[2][1], ata[2][2], aty[2]],
  ];
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) {
        pivot = r;
      }
    }
    if (Math.abs(m[pivot][col]) < 1e-12) {
      return fallback;
    }
    if (pivot !== col) {
      const tmp = m[col];
      m[col] = m[pivot];
      m[pivot] = tmp;
    }
    for (let r = col + 1; r < 3; r++) {
      const factor = m[r][col] / m[col][col];
      for (let c = col; c < 4; c++) {
        m[r][c] -= factor * m[col][c];
      }
    }
  }
  const beta: number[] = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let sum = m[r][3];
    for (let c = r + 1; c < 3; c++) {
      sum -= m[r][c] * beta[c];
    }
    beta[r] = sum / m[r][r];
  }
  if (!beta.every(Number.isFinite)) {
    return fallback;
  }

  return {
    intercept: beta[0],
    slope: beta[1],
    infra: beta[2],
    n,
    clampMin: CLAMP_MIN,
    clampMax: CLAMP_MAX,
  };
}

// The fitted multiple for one TVL, with the infra shift when the protocol
// is infra. Clamp guards against implausibly tiny or huge fitted multiples.
export function fittedMultiple(
  tvl: number,
  infra: boolean,
  curve: ValueCurve,
): number {
  if (!Number.isFinite(tvl) || tvl <= 0) {
    return curve.clampMin;
  }

  const fitted = 10 ** (
    curve.intercept +
    curve.slope * Math.log10(tvl) +
    (infra ? curve.infra : 0)
  );
  return Math.min(curve.clampMax, Math.max(curve.clampMin, fitted));
}

export function ageDays(asOf: string | Date, listedAt: string | null): number | null {
  if (!listedAt) {
    return null;
  }

  const asOfTime = new Date(asOf).getTime();
  const listedTime = new Date(listedAt).getTime();
  if (!Number.isFinite(asOfTime) || !Number.isFinite(listedTime)) {
    return null;
  }

  return Math.max(0, Math.floor((asOfTime - listedTime) / 86_400_000));
}

// The implied value is the fitted live-comp value, nothing else: TVL times
// the fitted multiple, rounded to whole dollars. No pre-token haircut (the
// snapshot holds no pair from which one could be fitted), no growth or
// maturity multiplier (both tested as regressors and rejected: they carry no
// weight out of sample and adding them hurts the backtest).
export function calculateImpliedValue(
  p: SnapshotProtocol,
  curve: ValueCurve,
): FactorBreakdown {
  const tvl = Number.isFinite(p.tvl_usd) && p.tvl_usd > 0 ? p.tvl_usd : 0;
  const infra = isInfra(p.category);
  const multiple = fittedMultiple(tvl, infra, curve);
  const implied = Math.max(1, Math.round(tvl * multiple));

  return {
    tvl,
    sizeMultiple: multiple,
    infra,
    implied,
  };
}

export function rankable(p: SnapshotProtocol): boolean {
  if (
    p.mcap_usd !== null ||
    p.gecko_id !== null ||
    p.symbol !== null
  ) {
    return false;
  }

  const excludedCategories = new Set([
    "Bridge",
    "Canonical Bridge",
    "Cross Chain Bridge",
    "Liquid Staking",
    "Liquid Restaking",
    "Restaked BTC",
    "CEX",
  ]);
  if (excludedCategories.has(p.category)) {
    return false;
  }

  const name = p.name.trim();
  if (/\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/.test(name)) {
    return false;
  }
  if (/\b(?:wrapped|staked|staking)\b/i.test(name)) {
    return false;
  }
  if (/^(?:Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i.test(name)) {
    return false;
  }

  return true;
}

function cappedStep(text: string): string {
  if (text.length <= 600) {
    return text;
  }
  return `${text.slice(0, 597).trimEnd()}...`;
}

interface FarmArgs {
  name: string;
  chain: string;
  capital: number;
  holdDays: number;
}

type FarmShape = (a: FarmArgs) => string[];

function setupStep(a: FarmArgs): string {
  return `Set up a dedicated wallet for ${a.name} on ${a.chain}. Cost: $0. Time: 5 minutes.`;
}

function fundStep(a: FarmArgs): string {
  return `Fund it with $${a.capital} for the farm. Cost: $${a.capital} plus gas. Time: 10 minutes.`;
}

function holdStep(a: FarmArgs): string {
  return `Hold the position for ${a.holdDays} days. Cost: opportunity cost of $${a.capital} locked for ${a.holdDays} days. Time: ${a.holdDays} days.`;
}

function checkStep(a: FarmArgs): string {
  return `Check your position at least weekly and note any eligibility criteria. Cost: $0. Time: 5 minutes a week.`;
}

// One 6-step shape per major category family. Every step names a concrete
// cost and a time, and uses only snapshot fields plus how that category
// works in general: no invented token names, minimums, URLs, yields or
// points programs. The mechanism verb (step 3) and the later steps differ
// per shape, so the plan reads as a plan for that kind of protocol.
const SHAPES: Record<string, FarmShape> = {
  Lending: (a) => [
    setupStep(a),
    fundStep(a),
    `On ${a.chain}, supply a stablecoin or blue-chip asset to the ${a.name} lending market with $${a.capital}. Cost: $${a.capital} plus gas. Time: 15 minutes.`,
    `Borrow a smaller amount against the supplied collateral and keep the health factor above 1.5. Cost: gas. Time: 10 minutes.`,
    holdStep(a),
    `Repay the borrow, then withdraw the supplied collateral from ${a.name}. Cost: gas on ${a.chain}. Time: 10 minutes.`,
  ],
  Dexs: (a) => [
    setupStep(a),
    fundStep(a),
    `On ${a.chain}, pick the deepest pool on ${a.name} and provide liquidity with $${a.capital}. Cost: $${a.capital} plus gas. Time: 15 minutes.`,
    `Stake the LP tokens you receive so the position earns fees. Cost: gas. Time: 10 minutes.`,
    `Claim accrued trading fees at least weekly. Cost: gas. Time: 5 minutes a week.`,
    holdStep(a),
  ],
  "Risk Curators": (a) => [
    setupStep(a),
    fundStep(a),
    `On ${a.chain}, deposit $${a.capital} into the ${a.name} curator vault. Cost: $${a.capital} plus gas. Time: 15 minutes.`,
    `Read the curator's strategy and track its performance weekly. Cost: $0. Time: 5 minutes a week.`,
    holdStep(a),
    `Harvest any yield, then withdraw the deposit from ${a.name} when the token launches or the vault no longer earns. Cost: gas on ${a.chain}. Time: 10 minutes.`,
  ],
  RWA: (a) => [
    setupStep(a),
    fundStep(a),
    `Verify the offering documents, then mint $${a.capital} of the tokenised asset on ${a.name}. Cost: $${a.capital} plus gas. Time: 20 minutes.`,
    `Hold the tokenised asset and confirm the underlying asset and redemption terms. Cost: $0. Time: 10 minutes.`,
    holdStep(a),
    `Redeem the tokenised asset through ${a.name} when the token launches or the position no longer earns. Cost: gas on ${a.chain}. Time: 15 minutes.`,
  ],
  CDP: (a) => [
    setupStep(a),
    fundStep(a),
    `On ${a.chain}, open a collateralised debt position on ${a.name} with $${a.capital} of collateral. Cost: $${a.capital} plus gas. Time: 15 minutes.`,
    `Mint the protocol's stable asset against the collateral and keep the collateral ratio above 150%. Cost: gas. Time: 10 minutes.`,
    holdStep(a),
    `Repay the minted amount, then withdraw the collateral from ${a.name}. Cost: gas on ${a.chain}. Time: 10 minutes.`,
  ],
  CeDeFi: (a) => [
    setupStep(a),
    fundStep(a),
    `On ${a.chain}, deposit $${a.capital} into the ${a.name} CeDeFi vault. Cost: $${a.capital} plus gas. Time: 15 minutes.`,
    `Track the vault's centralised custody and strategy notes weekly. Cost: $0. Time: 5 minutes a week.`,
    holdStep(a),
    `Harvest any yield, then withdraw the deposit from ${a.name} when the token launches or the vault no longer earns. Cost: gas on ${a.chain}. Time: 10 minutes.`,
  ],
  // Chain rows name their own chain as their first chain (Noble on Noble,
  // XION on XION), so the generic "bridge from {chain}" wording reads
  // "Bridge $50 to Noble from Noble". Chain steps therefore never name a
  // source chain: funds come from the reader's main chain.
  Chain: (a) => [
    `Set up a dedicated wallet for ${a.name}. Cost: $0. Time: 5 minutes.`,
    fundStep(a),
    `Bridge $${a.capital} onto ${a.name} from your main chain. Cost: $${a.capital} plus bridge gas. Time: 20 minutes.`,
    `Use two or three of the chain's live dApps with the bridged funds. Cost: gas. Time: 20 minutes.`,
    holdStep(a),
    `Bridge the funds off ${a.name} back to your main chain when the token launches or the dApps no longer earn. Cost: gas. Time: 15 minutes.`,
  ],
  "Prediction Market": (a) => [
    setupStep(a),
    fundStep(a),
    `On ${a.chain}, place a $${a.capital} position on a ${a.name} market whose outcome you can judge. Cost: $${a.capital} plus gas. Time: 15 minutes.`,
    `Follow the market's resolution rules and the event's outcome. Cost: $0. Time: 10 minutes.`,
    holdStep(a),
    `Claim your winnings from ${a.name} once the market resolves, and withdraw the balance. Cost: gas on ${a.chain}. Time: 10 minutes.`,
  ],
  "Governance Incentives": (a) => [
    setupStep(a),
    fundStep(a),
    `On ${a.chain}, lock or delegate $${a.capital} of voting power through ${a.name}. Cost: $${a.capital} plus gas. Time: 15 minutes.`,
    `Vote on live proposals and track new ones weekly. Cost: gas per vote. Time: 10 minutes a week.`,
    holdStep(a),
    `Undelegate and withdraw the locked funds from ${a.name} when the token launches or the incentives end. Cost: gas on ${a.chain}. Time: 10 minutes.`,
  ],
  "Basis Trading": (a) => [
    setupStep(a),
    fundStep(a),
    `On ${a.chain}, open a $${a.capital} basis trade on ${a.name}: long spot, short the future. Cost: $${a.capital} plus gas. Time: 20 minutes.`,
    `Watch the funding rate and the spot-future gap daily; close if the gap turns against you. Cost: $0. Time: 5 minutes a day.`,
    holdStep(a),
    `Close both legs of the basis trade on ${a.name} and withdraw the funds. Cost: gas on ${a.chain}. Time: 15 minutes.`,
  ],
  "Collateral Markets": (a) => [
    setupStep(a),
    fundStep(a),
    `On ${a.chain}, post $${a.capital} of collateral to the ${a.name} market. Cost: $${a.capital} plus gas. Time: 15 minutes.`,
    `Monitor the collateral ratio and top it up if it falls near liquidation. Cost: gas. Time: 10 minutes a week.`,
    holdStep(a),
    `Withdraw the collateral from ${a.name} when the token launches or the market no longer earns. Cost: gas on ${a.chain}. Time: 10 minutes.`,
  ],
  "Onchain Capital Allocator": (a) => [
    setupStep(a),
    fundStep(a),
    `On ${a.chain}, deposit $${a.capital} into the ${a.name} allocator vault. Cost: $${a.capital} plus gas. Time: 15 minutes.`,
    `Read the allocator's strategy and track where it deploys capital weekly. Cost: $0. Time: 5 minutes a week.`,
    holdStep(a),
    `Harvest any yield, then withdraw the deposit from ${a.name} when the token launches or the vault no longer earns. Cost: gas on ${a.chain}. Time: 10 minutes.`,
  ],
  Payments: (a) => [
    setupStep(a),
    fundStep(a),
    `On ${a.chain}, settle a real payment of $${a.capital} through ${a.name}. Cost: $${a.capital} plus gas. Time: 10 minutes.`,
    `Confirm the payment settled and keep the receipt. Cost: $0. Time: 5 minutes.`,
    holdStep(a),
    `Withdraw any remaining balance from ${a.name} when the token launches or you stop using it. Cost: gas on ${a.chain}. Time: 10 minutes.`,
  ],
  Yield: (a) => [
    setupStep(a),
    fundStep(a),
    `On ${a.chain}, deposit $${a.capital} into the ${a.name} yield vault. Cost: $${a.capital} plus gas. Time: 15 minutes.`,
    `Track the vault's yield and strategy weekly. Cost: $0. Time: 5 minutes a week.`,
    holdStep(a),
    `Harvest the yield, then withdraw the deposit from ${a.name} when the token launches or the vault no longer earns. Cost: gas on ${a.chain}. Time: 10 minutes.`,
  ],
  Restaking: (a) => [
    setupStep(a),
    fundStep(a),
    `On ${a.chain}, restake $${a.capital} through the ${a.name} vault. Cost: $${a.capital} plus gas. Time: 15 minutes.`,
    `Monitor the restaking rewards and the operators securing them weekly. Cost: $0. Time: 5 minutes a week.`,
    holdStep(a),
    `Unstake from ${a.name} when the token launches or the rewards no longer earn, respecting the unbonding wait. Cost: gas on ${a.chain}. Time: 10 minutes.`,
  ],
  "Staking Pool": (a) => [
    setupStep(a),
    fundStep(a),
    `On ${a.chain}, stake $${a.capital} into the ${a.name} staking pool. Cost: $${a.capital} plus gas. Time: 15 minutes.`,
    `Track the staking rewards weekly. Cost: $0. Time: 5 minutes a week.`,
    holdStep(a),
    `Unstake from ${a.name} when the token launches or the pool no longer earns, respecting the unbonding wait. Cost: gas on ${a.chain}. Time: 10 minutes.`,
  ],
  Insurance: (a) => [
    setupStep(a),
    fundStep(a),
    `On ${a.chain}, buy $${a.capital} of cover on ${a.name} for a position you hold. Cost: $${a.capital} plus gas. Time: 15 minutes.`,
    `Track the covered position and the cover's expiry weekly. Cost: $0. Time: 5 minutes a week.`,
    holdStep(a),
    `File a claim on ${a.name} if the covered event happens, or let the cover lapse and withdraw. Cost: gas on ${a.chain}. Time: 15 minutes.`,
  ],
  Derivatives: (a) => [
    setupStep(a),
    fundStep(a),
    `On ${a.chain}, open a small $${a.capital} position on the ${a.name} derivatives market. Cost: $${a.capital} plus gas. Time: 15 minutes.`,
    `Watch the position's margin and funding rate daily; add margin before liquidation. Cost: gas. Time: 5 minutes a day.`,
    holdStep(a),
    `Close the position on ${a.name} and withdraw the balance. Cost: gas on ${a.chain}. Time: 10 minutes.`,
  ],
};

// Categories that share a shape with a named one: same mechanics, different
// name. "Mint" covers wrapped/stable assets minted against a deposit.
const SHAPE_ALIASES: Record<string, string> = {
  "Uncollateralized Lending": "Lending",
  "Liquidity Manager": "Dexs",
  "CDP Manager": "CDP",
  "Yield Aggregator": "Yield",
  Farm: "Yield",
  "Leveraged Farming": "Lending",
  "Interest Rate Derivatives": "Derivatives",
  "Anchor BTC": "Mint",
  "Decentralized BTC": "Mint",
  "Dual-Token Stablecoin": "Mint",
  "Stablecoin Wrapper": "Mint",
  Indexes: "Yield",
  "Crypto Card Issuer": "Payments",
  Stablecoin: "CDP",
};

const MINT_SHAPE: FarmShape = (a) => [
  setupStep(a),
  fundStep(a),
  `On ${a.chain}, mint $${a.capital} of the wrapped asset on ${a.name}. Cost: $${a.capital} plus gas. Time: 15 minutes.`,
  `Hold the minted asset and confirm the backing and redemption terms. Cost: $0. Time: 10 minutes.`,
  holdStep(a),
  `Redeem the minted asset through ${a.name} when the token launches or the position no longer earns. Cost: gas on ${a.chain}. Time: 15 minutes.`,
];

const DEFAULT_SHAPE: FarmShape = (a) => [
  setupStep(a),
  fundStep(a),
  `On ${a.chain}, interact with ${a.name} with $${a.capital} of capital. Cost: $${a.capital} plus gas. Time: 15 minutes.`,
  checkStep(a),
  holdStep(a),
  `Withdraw or harvest from ${a.name} when the token launches or the position no longer earns. Cost: gas on ${a.chain}. Time: 10 minutes.`,
];

export function generateFarmSteps(p: SnapshotProtocol, asOf: string | Date): string[] {
  const primaryChain = p.chains?.[0] || "its main chain";
  const capital = p.tvl_usd >= 5_000_000_000
    ? 250
    : p.tvl_usd >= 1_000_000_000
      ? 150
      : p.tvl_usd >= 100_000_000
        ? 100
        : 50;

  const age = ageDays(asOf, p.listed_at);
  const holdDays = age !== null && age > 1095
    ? 60
    : age !== null && age > 500
      ? 45
      : 30;

  const args: FarmArgs = { name: p.name, chain: primaryChain, capital, holdDays };
  const category = p.category ?? "";
  let shape: FarmShape | undefined = SHAPES[category];
  if (!shape) {
    const alias = SHAPE_ALIASES[category];
    if (alias === "Mint") {
      shape = MINT_SHAPE;
    } else if (alias) {
      shape = SHAPES[alias];
    }
  }
  if (!shape) {
    shape = DEFAULT_SHAPE;
  }

  return shape(args).map(cappedStep);
}
