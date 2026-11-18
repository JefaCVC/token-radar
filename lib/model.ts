// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board ranks every protocol on the snapshot's watchlist plus every other pre-token protocol
// that passes the same shape of rule (not an exchange, bridge, liquid-staking or versioned product),
// about 198 rows. A protocol is pre-token when its record carries no token at all: no market cap,
// no CoinGecko id, no symbol. Protocols that already trade are kept apart and shown with the
// market's own value, never mixed into the ranking.
//
// Implied value follows only from the snapshot's own figures, one function for every row:
//
//   size      = 10^(a + b * log10(TVL))          fitted on the tokens that already trade
//   family    = 10^(shrunk category offset)     residual mean per category, shrunk toward 0
//   carry     = clamp(1 + 0.5 * change_7d/100, 0.8, 1.25)
//   odds      = launch odds from the snapshot's own age curve (share with a token, by age)
//   kin       = 0.5 when a same-stem name already records a token, else 1
//   implied   = size * family * carry * odds * kin
//
// The fit is tested, not asserted: leave-one-out and walk-forward holdouts, a term-by-term
// ablation table, bootstrap rank ranges and bands from the holdout miss distribution. All of
// it is computed here from the snapshot and shipped to the dashboard, which shows the numbers.
//
// No protocol name is ever special-cased. The same function scores every row.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const LOG10 = Math.log10;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a sorted-or-unsorted list of numbers. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The q-quantile of a list of numbers (linear interpolation). */
function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories the watchlist rule leaves out: wrapped, staked or bridged products and exchanges. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Whole words that mark a name as a wrapped or staked product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Exchange names a protocol name must not begin with. */
const EXCHANGE_PREFIX = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Why a pre-token protocol is not one the board ranks, or null when it is rankable. */
export function exclusionReason(p: SnapshotProtocol): string | null {
  if (!isPreToken(p)) return 'token already trades';
  if (p.category === 'CEX') return 'exchange custody, not a protocol launch';
  if (p.category === 'Bridge' || p.category === 'Canonical Bridge') return 'bridge: a wrapped product of a token that trades';
  if (p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC') return 'liquid staking: a staked product of a token that trades';
  if (VERSIONED.test(p.name)) return 'versioned pool of another protocol';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped or staked product by name';
  if (EXCHANGE_PREFIX.some((e) => p.name === e || p.name.startsWith(`${e} `))) return 'exchange product by name';
  return null;
}

/** Whether a protocol is one the board may rank: pre-token and not excluded by the rule above. */
export function isRankable(p: SnapshotProtocol): boolean {
  return exclusionReason(p) === null;
}

/** The first word of a name, lowercased: the family stem kinship is read from. */
function familyStem(name: string): string {
  const first = name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean)[0] ?? '';
  return first.length > 2 ? first : '';
}

/**
 * The set of family stems that already record a token: a pre-token protocol sharing one is a
 * sibling of a traded token, so its own launch, if it ever comes, shares the family.
 */
export function tokenStems(protocols: SnapshotProtocol[]): Set<string> {
  const stems = new Set<string>();
  for (const p of protocols) {
    if (isPreToken(p)) continue;
    const stem = familyStem(p.name);
    if (stem !== '') stems.add(stem);
  }
  return stems;
}

/** Whether a pre-token protocol shares its family stem with a protocol whose token trades. */
export function isKin(p: SnapshotProtocol, stems: Set<string>): boolean {
  const stem = familyStem(p.name);
  return stem !== '' && stems.has(stem);
}

// ---------------------------------------------------------------- the fit

/** A least-squares line through log10(market cap) against log10(TVL). */
export interface SizeCurve {
  intercept: number;
  slope: number;
  r2: number;
  n: number;
}

/** Ordinary least squares on two equal-length lists. */
export function ols(xs: number[], ys: number[]): { intercept: number; slope: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return { intercept: my - slope * mx, slope };
}

/** The traded tokens the size curve is fitted on: a market cap and a TVL, both positive. */
export function comparables(protocols: SnapshotProtocol[]): SnapshotProtocol[] {
  return protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

/** The size curve fitted on a set of comparables, with its R squared. */
export function fitCurve(comps: SnapshotProtocol[]): SizeCurve {
  const xs = comps.map((p) => LOG10(p.tvl_usd));
  const ys = comps.map((p) => LOG10(p.mcap_usd!));
  const { intercept, slope } = ols(xs, ys);
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let ss = 0;
  let st = 0;
  for (let i = 0; i < ys.length; i++) {
    const r = ys[i]! - (intercept + slope * xs[i]!);
    ss += r * r;
    st += (ys[i]! - my) * (ys[i]! - my);
  }
  return { intercept: round4(intercept), slope: round4(slope), r2: round4(st === 0 ? 0 : 1 - ss / st), n: comps.length };
}

/** A category's offset: its comparables' mean log residual, shrunk toward zero. */
export interface FamilyOffsets {
  /** category -> log10 offset; categories with too few comparables are absent (offset 0). */
  offsets: Record<string, number>;
  /** category -> number of comparables behind the offset. */
  counts: Record<string, number>;
  shrink: number;
  minCount: number;
}

export const OFFSET_SHRINK = 20;
export const OFFSET_MIN_COUNT = 3;

/** Family offsets from a fit's residuals: mean residual per category, shrunk by n/(n+shrink). */
export function fitOffsets(comps: SnapshotProtocol[], curve: SizeCurve, shrink = OFFSET_SHRINK, minCount = OFFSET_MIN_COUNT): FamilyOffsets {
  const byCat = new Map<string, number[]>();
  for (const p of comps) {
    const r = LOG10(p.mcap_usd!) - (curve.intercept + curve.slope * LOG10(p.tvl_usd));
    const cat = p.category ?? 'Other';
    const list = byCat.get(cat) ?? [];
    list.push(r);
    byCat.set(cat, list);
  }
  const offsets: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const [cat, rs] of [...byCat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (rs.length < minCount) continue;
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    offsets[cat] = round4((rs.length / (rs.length + shrink)) * mean);
    counts[cat] = rs.length;
  }
  return { offsets, counts, shrink, minCount };
}

/** The 7-day growth carry: half the week's move, bounded so one hot week cannot double a value. */
export function growthCarry(change7d: number | null): number {
  const g = change7d === null || !Number.isFinite(change7d) ? 0 : Math.min(100, Math.max(-50, change7d));
  return round4(Math.min(1.25, Math.max(0.8, 1 + (g / 100) * 0.5)));
}

/** One bucket of the empirical launch-odds curve. */
export interface OddsBucket {
  loDays: number;
  hiDays: number | null;
  n: number;
  withToken: number;
  /** The pooled (monotone) share with a token. */
  odds: number;
}

/** Age buckets for the launch-odds curve, in days. */
const ODDS_BUCKETS: Array<[number, number | null]> = [
  [0, 90],
  [90, 180],
  [180, 365],
  [365, 730],
  [730, 1095],
  [1095, null],
];

/**
 * The launch-odds curve: among protocols shaped like the ones the board ranks, the share whose
 * token already trades, by how long DefiLlama has tracked them. Bucket shares are pooled with the
 * pool-adjacent-violators rule so the curve never falls with age (a younger bucket cannot sit
 * above an older one on a handful of protocols), then read by linear interpolation between
 * bucket midpoints. Unknown ages read the curve at the snapshot's median age.
 */
export function fitOddsCurve(snapshot: Snapshot): { buckets: OddsBucket[]; medianAgeDays: number } {
  const asOf = snapshot.as_of;
  const ages: number[] = [];
  const pool = snapshot.protocols.filter((p) => {
    if (EXCLUDED_CATEGORIES.has(p.category ?? '')) return false;
    if (VERSIONED.test(p.name)) return false;
    const age = ageDays(asOf, p.listed_at);
    if (age === null) return false;
    ages.push(age);
    return true;
  });
  const medianAgeDays = Math.round(median(ages));
  const raw: OddsBucket[] = ODDS_BUCKETS.map(([lo, hi]) => {
    const inBucket = pool.filter((p) => {
      const age = ageDays(asOf, p.listed_at)!;
      return age >= lo && (hi === null || age < hi);
    });
    const withToken = inBucket.filter((p) => !isPreToken(p)).length;
    return { loDays: lo, hiDays: hi, n: inBucket.length, withToken, odds: inBucket.length === 0 ? 0 : withToken / inBucket.length };
  });
  // Pool adjacent violators: while a bucket sits above the next, merge the two.
  const blocks: Array<{ n: number; withToken: number; buckets: OddsBucket[] }> = raw.map((b) => ({ n: b.n, withToken: b.withToken, buckets: [b] }));
  for (let i = 0; i + 1 < blocks.length; ) {
    const a = blocks[i]!;
    const b = blocks[i + 1]!;
    const oddsA = a.n === 0 ? 0 : a.withToken / a.n;
    const oddsB = b.n === 0 ? 0 : b.withToken / b.n;
    if (oddsA > oddsB) {
      blocks.splice(i, 2, { n: a.n + b.n, withToken: a.withToken + b.withToken, buckets: [...a.buckets, ...b.buckets] });
      if (i > 0) i--;
    } else {
      i++;
    }
  }
  for (const block of blocks) {
    const odds = block.n === 0 ? 0 : block.withToken / block.n;
    for (const b of block.buckets) b.odds = round4(odds);
  }
  return { buckets: raw, medianAgeDays };
}

/** Bucket midpoints the odds curve interpolates between (the open bucket reads at 1500 days). */
function bucketMidpoint(b: OddsBucket): number {
  if (b.hiDays === null) return 1500;
  return (b.loDays + b.hiDays) / 2;
}

/** Launch odds for an age in days, interpolated along the fitted curve. */
export function launchOdds(age: number, buckets: OddsBucket[]): number {
  const points = buckets.map((b) => ({ at: bucketMidpoint(b), odds: b.odds }));
  if (age <= points[0]!.at) return points[0]!.odds;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (age <= b.at) {
      const t = (age - a.at) / (b.at - a.at);
      return round4(a.odds + t * (b.odds - a.odds));
    }
  }
  return points[points.length - 1]!.odds;
}

/** The kin haircut: a sibling token already trades, so a new launch shares the family. */
export const KIN_HAIRCUT = 0.5;

/** Everything the value model needs to score one protocol. */
export interface FittedModel {
  curve: SizeCurve;
  offsets: FamilyOffsets;
  oddsBuckets: OddsBucket[];
  medianAgeDays: number;
  kinStems: Set<string>;
  /** The flat baseline: the median market-cap-to-TVL multiple of the comparables. */
  flatMultiple: number;
}

/** Fit the whole model on a snapshot. */
export function fitModel(snapshot: Snapshot): FittedModel {
  const comps = comparables(snapshot.protocols);
  const curve = fitCurve(comps);
  const offsets = fitOffsets(comps, curve);
  const { buckets, medianAgeDays } = fitOddsCurve(snapshot);
  const ratios = comps.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  return {
    curve,
    offsets,
    oddsBuckets: buckets,
    medianAgeDays,
    kinStems: tokenStems(snapshot.protocols),
    flatMultiple: round4(median(ratios)),
  };
}

/** One protocol's value, term by term. */
export interface ValueTerms {
  ageDays: number | null;
  ageUsed: number;
  sizeValue: number;
  familyOffset: number;
  familyMult: number;
  growthMult: number;
  odds: number;
  kin: boolean;
  kinMult: number;
  /** The value if a token launched tomorrow: size x family x carry, before odds and kin. */
  valueIfLaunched: number;
  implied: number;
}

/**
 * The implied value of one protocol under a fitted model. The same function scores every row:
 * nothing here looks at a name.
 */
export function impliedValue(p: SnapshotProtocol, asOf: string, model: FittedModel): ValueTerms {
  const age = ageDays(asOf, p.listed_at);
  const ageUsed = age ?? model.medianAgeDays;
  const sizeValue = Math.pow(10, model.curve.intercept + model.curve.slope * LOG10(Math.max(1, p.tvl_usd)));
  const familyOffset = model.offsets.offsets[p.category ?? 'Other'] ?? 0;
  const familyMult = Math.pow(10, familyOffset);
  const growthMult = growthCarry(p.change_7d);
  const odds = launchOdds(ageUsed, model.oddsBuckets);
  const kin = isKin(p, model.kinStems);
  const kinMult = kin ? KIN_HAIRCUT : 1;
  const valueIfLaunched = sizeValue * familyMult * growthMult;
  const implied = Math.max(1, Math.round(valueIfLaunched * odds * kinMult));
  return {
    ageDays: age,
    ageUsed,
    sizeValue: Math.round(sizeValue),
    familyOffset: round4(familyOffset),
    familyMult: round4(familyMult),
    growthMult,
    odds,
    kin,
    kinMult,
    valueIfLaunched: Math.round(valueIfLaunched),
    implied,
  };
}

/** The size curve's reading for a TVL, without any other term: what the curve alone would say. */
export function curveValue(tvlUsd: number, curve: SizeCurve): number {
  return Math.pow(10, curve.intercept + curve.slope * LOG10(Math.max(1, tvlUsd)));
}

// ---------------------------------------------------------------- validation

/** One holdout read: median miss multiple, share within 3x, and rank correlation. */
export interface HoldoutRead {
  medianMissX: number;
  within3x: number;
  /** Spearman rank correlation between predicted and actual market caps, when computable. */
  rankCorr: number | null;
  n: number;
}

/** A holdout read from paired log10 predictions and actuals. */
function holdoutRead(predLog: number[], actualLog: number[]): HoldoutRead {
  const misses = predLog.map((pr, i) => Math.abs(pr - actualLog[i]!));
  const med = median(misses);
  const within3x = misses.filter((m) => Math.pow(10, m) <= 3).length / misses.length;
  return { medianMissX: round2(Math.pow(10, med)), within3x: round4(within3x), rankCorr: round4(spearman(predLog, actualLog)), n: predLog.length };
}

/** Spearman rank correlation between two equal-length lists. */
export function spearman(a: number[], b: number[]): number {
  const rank = (v: number[]): number[] => {
    const idx = v.map((_, i) => i).sort((i, j) => v[i]! - v[j]!);
    const r = new Array<number>(v.length);
    let i = 0;
    while (i < v.length) {
      let j = i;
      while (j + 1 < v.length && v[idx[j + 1]!] === v[idx[i]!]) j++;
      const avg = (i + j) / 2 + 1;
      for (let t = i; t <= j; t++) r[idx[t]!] = avg;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const ma = ra.reduce((x, y) => x + y, 0) / n;
  const mb = rb.reduce((x, y) => x + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (ra[i]! - ma) * (rb[i]! - mb);
    sxx += (ra[i]! - ma) * (ra[i]! - ma);
    syy += (rb[i]! - mb) * (rb[i]! - mb);
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

/** Which terms a value prediction uses: the ablation switches terms on one at a time. */
export interface AblationSpec {
  label: string;
  curve: boolean;
  offsets: boolean;
  growth: boolean;
}

/** The ablation ladder: flat multiple, then the curve, then offsets, then growth. */
export const ABLATION_SPECS: AblationSpec[] = [
  { label: 'Flat multiple', curve: false, offsets: false, growth: false },
  { label: 'Size curve', curve: true, offsets: false, growth: false },
  { label: 'Curve + family offsets', curve: true, offsets: true, growth: false },
  { label: 'Curve + offsets + growth', curve: true, offsets: true, growth: true },
];

/** Predict one comparable's log10 market cap under a spec, from a training set's fit. */
function predictLog(p: SnapshotProtocol, train: SnapshotProtocol[], spec: AblationSpec): number {
  if (!spec.curve) {
    const ratios = train.map((t) => t.mcap_usd! / t.tvl_usd).sort((a, b) => a - b);
    return LOG10(median(ratios) * p.tvl_usd);
  }
  const curve = fitCurve(train);
  let v = curve.intercept + curve.slope * LOG10(p.tvl_usd);
  if (spec.offsets) {
    const off = fitOffsets(train, curve);
    v += off.offsets[p.category ?? 'Other'] ?? 0;
  }
  let val = Math.pow(10, v);
  if (spec.growth) val *= growthCarry(p.change_7d);
  return LOG10(val);
}

/**
 * Leave-one-out holdout for one spec: each comparable is predicted by a fit that never saw it.
 * Returns the read plus the signed log misses, which the bands are built from.
 */
export function looCheck(comps: SnapshotProtocol[], spec: AblationSpec): { read: HoldoutRead; signedMissLog: number[] } {
  const predLog: number[] = [];
  const actualLog: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    predLog.push(predictLog(comps[i]!, train, spec));
    actualLog.push(LOG10(comps[i]!.mcap_usd!));
  }
  return { read: holdoutRead(predLog, actualLog), signedMissLog: predLog.map((pr, i) => pr - actualLog[i]!) };
}

/** Walk-forward origins: fit on tokens listed before the date, test on the ones listed after. */
export const WALK_ORIGINS = ['2023-07-01', '2024-01-01', '2024-07-01', '2025-01-01'];

/** Walk-forward holdout for one spec, pooled over the origins. */
export function walkForward(comps: SnapshotProtocol[], spec: AblationSpec): { read: HoldoutRead; perOrigin: Array<{ origin: string; train: number; test: number; medianMissX: number }> } {
  const predLog: number[] = [];
  const actualLog: number[] = [];
  const perOrigin: Array<{ origin: string; train: number; test: number; medianMissX: number }> = [];
  for (const origin of WALK_ORIGINS) {
    const train = comps.filter((p) => p.listed_at !== null && p.listed_at < origin);
    const test = comps.filter((p) => p.listed_at !== null && p.listed_at >= origin);
    if (train.length < 10 || test.length < 5) continue;
    const misses: number[] = [];
    for (const p of test) {
      const pr = predictLog(p, train, spec);
      predLog.push(pr);
      actualLog.push(LOG10(p.mcap_usd!));
      misses.push(Math.abs(pr - LOG10(p.mcap_usd!)));
    }
    perOrigin.push({ origin, train: train.length, test: test.length, medianMissX: round2(Math.pow(10, median(misses))) });
  }
  return { read: holdoutRead(predLog, actualLog), perOrigin };
}

/** One row of the ablation table. */
export interface AblationRow {
  label: string;
  loo: HoldoutRead;
  walkForward: HoldoutRead;
}

/** The full ablation table: every spec, leave-one-out and walk-forward. */
export function ablationTable(comps: SnapshotProtocol[]): AblationRow[] {
  return ABLATION_SPECS.map((spec) => ({
    label: spec.label,
    loo: looCheck(comps, spec).read,
    walkForward: walkForward(comps, spec).read,
  }));
}

/** The uncertainty bands, from the leave-one-out miss distribution of the full value model. */
export interface Bands {
  /** Half-width in log10 for the 50% band (the median absolute miss). */
  half50: number;
  /** Half-width in log10 for the 80% band (the 80th percentile absolute miss). */
  half80: number;
  /** Share of leave-one-out comparables whose actual market cap lands inside the 50% band. */
  hold50: number;
  /** Share inside the 80% band. */
  hold80: number;
}

/** Bands from signed leave-one-out log misses: symmetric in log space, hold rates measured. */
export function fitBands(signedMissLog: number[]): Bands {
  const abs = signedMissLog.map((m) => Math.abs(m));
  const half50 = quantile(abs, 0.5);
  const half80 = quantile(abs, 0.8);
  const hold = (half: number): number => abs.filter((m) => m <= half).length / abs.length;
  return { half50: round4(half50), half80: round4(half80), hold50: round4(hold(half50)), hold80: round4(hold(half80)) };
}

/** A seeded PRNG (mulberry32): the bootstrap refits are reproducible, run to run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BOOTSTRAP_REFITS = 200;
export const BOOTSTRAP_SEED = 20261114;

/**
 * Rank ranges from bootstrap refits: resample the comparables, refit the curve and the offsets,
 * re-score every board row and re-rank. Each row's range is the 10th to 90th percentile of the
 * ranks it took across the refits. Growth, odds and kin are not refitted: they come from the
 * snapshot's own figures, not from the comparables.
 */
export function bootstrapRankRanges(
  rows: Array<{ slug: string; tvl_usd: number; change_7d: number | null; category: string | null; ageUsed: number; odds: number; kinMult: number }>,
  comps: SnapshotProtocol[],
  buckets: OddsBucket[],
  refits = BOOTSTRAP_REFITS,
): { ranges: Record<string, { lo: number; hi: number }>; top20Stable: number } {
  const rand = mulberry32(BOOTSTRAP_SEED);
  const ranksBySlug = new Map<string, number[]>();
  for (const r of rows) ranksBySlug.set(r.slug, []);
  for (let k = 0; k < refits; k++) {
    const sample: SnapshotProtocol[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rand() * comps.length)]!);
    const curve = fitCurve(sample);
    const off = fitOffsets(sample, curve);
    const scored = rows.map((r) => {
      const size = Math.pow(10, curve.intercept + curve.slope * LOG10(Math.max(1, r.tvl_usd)));
      const fam = Math.pow(10, off.offsets[r.category ?? 'Other'] ?? 0);
      const implied = size * fam * growthCarry(r.change_7d) * r.odds * r.kinMult;
      return { slug: r.slug, implied };
    });
    scored.sort((a, b) => b.implied - a.implied || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    scored.forEach((s, i) => ranksBySlug.get(s.slug)!.push(i + 1));
  }
  const ranges: Record<string, { lo: number; hi: number }> = {};
  for (const [slug, ranks] of ranksBySlug) {
    ranges[slug] = { lo: Math.round(quantile(ranks, 0.1)), hi: Math.round(quantile(ranks, 0.9)) };
  }
  const top20 = rows.slice(0, 20).map((r) => r.slug);
  const top20Stable = top20.filter((slug) => ranksBySlug.get(slug)!.filter((r) => r <= 20).length >= 0.8 * refits).length;
  return { ranges, top20Stable };
}

/** How far the board's order sits from plain TVL order: rows 5+ ranks away from it. */
export function offTvlOrderCount(rows: Array<{ slug: string; tvl_usd: number }>, boardRank: Map<string, number>): number {
  const byTvl = [...rows].sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  let count = 0;
  byTvl.forEach((r, i) => {
    if (Math.abs(boardRank.get(r.slug)! - (i + 1)) >= 5) count++;
  });
  return count;
}

// ---------------------------------------------------------------- farm plans

/** The default farm ticket the board's plans are written for, in dollars. */
export const DEFAULT_TICKET = 1000;
/** The share of a launched token's value a drop is assumed to hand to farmers. */
export const DROP_SHARE = 0.1;
/** The T-bill yield a farm gives up, per year, on the ticket. */
export const TBILL_YIELD = 0.04;
/** Net per hands-on hour a plan needs to read FARM rather than THIN. */
export const FARM_PER_HOUR = 5;

/** Whole dollars with commas: "$1,234". Shared with the dashboard, character for character. */
export function usd0(n: number): string {
  return `$${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** Dollars and cents with commas: "$12.34". Shared with the dashboard, character for character. */
export function usd2(n: number): string {
  const fixed = n.toFixed(2);
  const parts = fixed.split('.');
  return `$${parts[0]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${parts[1]!}`;
}

/** A date `days` after `asOf` (YYYY-MM-DD), as YYYY-MM-DD. */
export function addDays(asOf: string, days: number): string {
  const d = new Date(Date.parse(`${asOf}T00:00:00Z`) + days * DAY_MS);
  return d.toISOString().slice(0, 10);
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 60;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 45;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, ticket: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const t = usd0(ticket);
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply ${t} of USDC to ${name} on ${chain} and leave the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide ${t} of liquidity to ${name}'s main pool on ${chain} and leave the position open.`;
  if (c.includes('bridge')) return `Bridge ${t} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake ${t} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit ${t} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund ${t} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('manager')) return `Deposit ${t} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit ${t} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa') || c.includes('basis')) return `Mint ${t} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy ${t} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('launchpad')) return `Stake ${t} through ${name} on ${chain} to qualify for its launches.`;
  if (c.includes('payment')) return `Run ${t} of volume through ${name} on ${chain} over the hold.`;
  return `Deposit ${t} of USDC into ${name} on ${chain} and leave the position open.`;
}

/** A protocol's farm economics at one ticket size. */
export interface FarmPlan {
  ticket: number;
  holdDays: number;
  weeks: number;
  gasUsd: number;
  forgoneUsd: number;
  timeMin: number;
  sliceIfLaunched: number;
  expectedSlice: number;
  net: number;
  perHour: number;
  /** The launch odds at which the plan breaks even; null when the slice is zero. */
  breakEvenOdds: number | null;
  /** The smallest deposit at which the plan pays; null when no deposit pays. */
  paysFrom: number | null;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  exitTvl: number;
  reviewDate: string;
  steps: string[];
}

/**
 * A protocol's farm plan: the arithmetic first, then the steps. The slice is the farmer's share
 * of a 10% drop (ticket over TVL), the net takes off gas and the T-bill yield the ticket gives
 * up, and the verdict follows from the net and the net per hands-on hour.
 */
export function farmPlan(p: SnapshotProtocol, terms: ValueTerms, asOf: string, ticket = DEFAULT_TICKET): FarmPlan {
  const holdDays = holdDaysFor(terms.ageDays);
  const weeks = Math.ceil(holdDays / 7);
  // Gas, in dollars: $4 to set up ($1 wallet + $3 deposit), $1 a week to stay active, $3 to claim
  // or unwind. Most of these protocols live on cheap chains; a mainnet-only farm costs more.
  const gasUsd = 7 + weeks;
  const forgoneUsd = ticket * TBILL_YIELD * (holdDays / 365);
  const timeMin = 20 + 10 * weeks + 10;
  const sliceIfLaunched = DROP_SHARE * terms.valueIfLaunched * (ticket / Math.max(1, p.tvl_usd));
  const expectedSlice = sliceIfLaunched * terms.odds * terms.kinMult;
  const net = expectedSlice - gasUsd - forgoneUsd;
  const perHour = net / (timeMin / 60);
  const breakEvenOdds = sliceIfLaunched * terms.kinMult > 0 ? (gasUsd + forgoneUsd) / (sliceIfLaunched * terms.kinMult) : null;
  const perDollar = (DROP_SHARE * terms.valueIfLaunched * terms.odds * terms.kinMult) / Math.max(1, p.tvl_usd) - TBILL_YIELD * (holdDays / 365);
  const paysFrom = perDollar > 0 ? Math.max(1, Math.ceil(gasUsd / perDollar)) : null;
  const verdict: FarmPlan['verdict'] = net > 0 && perHour >= FARM_PER_HOUR ? 'FARM' : net > 0 ? 'THIN' : 'SKIP';
  const exitTvl = Math.round(p.tvl_usd / 2);
  const reviewDate = addDays(asOf, holdDays);
  const chain = chainOf(p);
  const action = actionFor(p, ticket, chain);
  const steps = [
    `WHEN: Day 1. Set up a fresh wallet that holds only the funds you plan to farm, and write its seed phrase on paper, offline. COST: no capital; about $1 of gas for the first transaction. TIME: 10 minutes.`,
    `WHEN: Day 1. ${action} COST: ${usd0(ticket)} of capital plus about $3 of gas. TIME: 20 minutes to set up.`,
    `WHEN: Weekly. Make one qualifying action, such as a deposit, a borrow, a swap or a vote, so the position stays active in each snapshot. COST: about $1 of gas a week. TIME: 10 minutes a week.`,
    `WHEN: Day 1 to day ${holdDays}. Hold the position for at least ${holdDays} days; drops usually reward activity across several weeks, not one day. COST: the ${usd0(ticket)} stays in the position; about ${usd2(forgoneUsd)} of T-bill yield forgone. TIME: ${holdDays} days.`,
    `WHEN: Day 30. Open the protocol's own points or rewards page and check the position is accruing; claim only from the link the protocol itself publishes. COST: nothing to check; never pay to claim. TIME: 10 minutes.`,
    `WHEN: ${reviewDate}. Review the position: if TVL has sat under ${usd0(exitTvl)} for a week, unwind; otherwise hold to the next review. COST: nothing to review. TIME: 15 minutes.`,
    `WHEN: At launch, or at the review date. If a token launches, claim from the protocol's own page and sell or hold on your own call; if nothing has launched by ${reviewDate}, unwind unless the numbers still pay. COST: about $3 of gas to claim or unwind. TIME: 15 minutes.`,
  ];
  return {
    ticket,
    holdDays,
    weeks,
    gasUsd,
    forgoneUsd: round2(forgoneUsd),
    timeMin,
    sliceIfLaunched: round2(sliceIfLaunched),
    expectedSlice: round2(expectedSlice),
    net: round2(net),
    perHour: round2(perHour),
    breakEvenOdds: breakEvenOdds === null ? null : round4(breakEvenOdds),
    paysFrom,
    verdict,
    exitTvl,
    reviewDate,
    steps,
  };
}

// ---------------------------------------------------------------- the board

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    size_value_usd: number;
    value_if_launched_usd: number;
    family_offset_log10: number;
    family_multiplier: number;
    growth_multiplier: number;
    launch_odds: number;
    kin: boolean;
    band50_low_usd: number;
    band50_high_usd: number;
    band80_low_usd: number;
    band80_high_usd: number;
    rank_lo: number;
    rank_hi: number;
  };
  farm: {
    verdict: 'FARM' | 'THIN' | 'SKIP';
    ticket_usd: number;
    net_usd: number;
    net_per_hour_usd: number;
    break_even_odds: number | null;
    pays_from_usd: number | null;
    review_date: string;
  };
  farm_steps: string[];
}

/** A traded comparable shown beside a board row: the nearest ones by size. */
export interface NearestComp {
  slug: string;
  name: string;
  tvl_usd: number;
  mcap_usd: number;
  /** What the size curve alone would say for this comparable's TVL. */
  curve_usd: number;
  /** The comparable's actual market cap over the curve's reading. */
  tested_miss_x: number;
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  value_if_launched_usd: number;
  size_value_usd: number;
  family_multiplier: number;
  growth_multiplier: number;
  launch_odds: number;
  kin: boolean;
  band50_low_usd: number;
  band50_high_usd: number;
  band80_low_usd: number;
  band80_high_usd: number;
  rank_lo: number;
  rank_hi: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  net_usd: number;
  net_per_hour_usd: number;
  break_even_odds: number | null;
  pays_from_usd: number | null;
  review_date: string;
  exit_tvl_usd: number;
  hold_days: number;
  farm_steps: string[];
  nearest: NearestComp[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

/** One group of the 758-protocol ledger. */
export interface LedgerGroup {
  label: string;
  count: number;
  reason: string;
}

/** The model's validation, as the dashboard shows it. */
export interface ValidationData {
  comps: number;
  curve: SizeCurve;
  flatMultiple: number;
  ablation: AblationRow[];
  loo: HoldoutRead;
  walkForward: HoldoutRead;
  walkOrigins: Array<{ origin: string; train: number; test: number; medianMissX: number }>;
  bands: Bands;
  bootstrapRefits: number;
  top20Stable: number;
  offTvlOrder: number;
  oddsBuckets: OddsBucket[];
  medianAgeDays: number;
}

/** Everything the dashboard needs: the board, the live set, the model and its validation. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  total_protocols: number;
  ledger: LedgerGroup[];
  model: {
    curve: SizeCurve;
    flatMultiple: number;
    offsets: Record<string, number>;
    offsetCounts: Record<string, number>;
    oddsBuckets: OddsBucket[];
    medianAgeDays: number;
    kinStems: string[];
    bands: Bands;
  };
  validation: ValidationData;
  verdictCounts: { FARM: number; THIN: number; SKIP: number };
  totalImplied: number;
  bestPerHour: { slug: string; name: string; perHour: number };
  rows: RadarRow[];
  live: LiveRow[];
  comps: Array<{ slug: string; name: string; category: string | null; tvl_usd: number; mcap_usd: number }>;
}

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-comps-1';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The three nearest traded comparables by size, same-category ones read a little closer. */
export function nearestComps(p: SnapshotProtocol, comps: SnapshotProtocol[], curve: SizeCurve): NearestComp[] {
  const lt = LOG10(Math.max(1, p.tvl_usd));
  return comps
    .map((c) => {
      const dist = Math.abs(LOG10(c.tvl_usd) - lt) - (c.category === p.category ? 0.15 : 0);
      const curveUsd = curveValue(c.tvl_usd, curve);
      return { c, dist, curveUsd };
    })
    .sort((a, b) => a.dist - b.dist || (a.c.slug < b.c.slug ? -1 : a.c.slug > b.c.slug ? 1 : 0))
    .slice(0, 3)
    .map(({ c, curveUsd }) => ({
      slug: c.slug,
      name: c.name,
      tvl_usd: c.tvl_usd,
      mcap_usd: c.mcap_usd!,
      curve_usd: Math.round(curveUsd),
      tested_miss_x: round2(c.mcap_usd! / curveUsd),
    }));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: FittedModel, bands: Bands, ranges: Record<string, { lo: number; hi: number }>): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug on it.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, whatever its size.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => ({ p, terms: impliedValue(p, snapshot.as_of, model) }));
  scored.sort((a, b) => b.terms.implied - a.terms.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => {
    const plan = farmPlan(s.p, s.terms, snapshot.as_of);
    const range = ranges[s.p.slug] ?? { lo: i + 1, hi: i + 1 };
    const band50 = { low: Math.max(1, Math.round(s.terms.implied / Math.pow(10, bands.half50))), high: Math.round(s.terms.implied * Math.pow(10, bands.half50)) };
    const band80 = { low: Math.max(1, Math.round(s.terms.implied / Math.pow(10, bands.half80))), high: Math.round(s.terms.implied * Math.pow(10, bands.half80)) };
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      watchlist: snapshot.watchlist.includes(s.p.slug),
      age_days: s.terms.ageDays,
      implied_value_usd: s.terms.implied,
      model: {
        size_value_usd: s.terms.sizeValue,
        value_if_launched_usd: s.terms.valueIfLaunched,
        family_offset_log10: s.terms.familyOffset,
        family_multiplier: s.terms.familyMult,
        growth_multiplier: s.terms.growthMult,
        launch_odds: s.terms.odds,
        kin: s.terms.kin,
        band50_low_usd: band50.low,
        band50_high_usd: band50.high,
        band80_low_usd: band80.low,
        band80_high_usd: band80.high,
        rank_lo: range.lo,
        rank_hi: range.hi,
      },
      farm: {
        verdict: plan.verdict,
        ticket_usd: plan.ticket,
        net_usd: plan.net,
        net_per_hour_usd: plan.perHour,
        break_even_odds: plan.breakEvenOdds,
        pays_from_usd: plan.paysFrom,
        review_date: plan.reviewDate,
      },
      farm_steps: plan.steps,
    };
  });
}

/** The full 758-protocol ledger: every protocol accounted for, with a reason. */
export function buildLedger(snapshot: Snapshot, boardSlugs: Set<string>): LedgerGroup[] {
  const groups = new Map<string, { count: number; reason: string }>();
  const add = (label: string, reason: string): void => {
    const g = groups.get(label) ?? { count: 0, reason };
    g.count++;
    groups.set(label, g);
  };
  for (const p of snapshot.protocols) {
    if (boardSlugs.has(p.slug)) {
      add(snapshot.watchlist.includes(p.slug) ? 'On the board: watchlist' : 'On the board: early', 'ranked by implied value');
      continue;
    }
    const reason = exclusionReason(p);
    if (reason === 'token already trades') add('Already trade', 'the token trades; the market cap is a fact, not a model');
    else if (reason === 'exchange custody, not a protocol launch') add('Set aside: exchange', 'exchange custody, not a protocol launch');
    else if (reason === 'bridge: a wrapped product of a token that trades') add('Set aside: bridge', 'a wrapped product of a token that trades');
    else if (reason === 'liquid staking: a staked product of a token that trades') add('Set aside: liquid staking', 'a staked product of a token that trades');
    else if (reason === 'versioned pool of another protocol') add('Set aside: versioned', 'a versioned pool of another protocol');
    else if (reason === 'wrapped or staked product by name') add('Set aside: wrapped by name', 'a wrapped or staked product by name');
    else if (reason === 'exchange product by name') add('Set aside: exchange by name', 'an exchange product by name');
    else add('Set aside: other', reason ?? 'not rankable');
  }
  const order = ['On the board: watchlist', 'On the board: early', 'Already trade', 'Set aside: exchange', 'Set aside: bridge', 'Set aside: liquid staking', 'Set aside: versioned', 'Set aside: wrapped by name', 'Set aside: exchange by name', 'Set aside: other'];
  return order
    .filter((label) => groups.has(label))
    .map((label) => ({ label, count: groups.get(label)!.count, reason: groups.get(label)!.reason }));
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd!, change_7d: p.change_7d }));
}

/** A board row's compact form for data.js, with the farm plan and nearest comparables. */
function radarRow(row: BoardRow, p: SnapshotProtocol, comps: SnapshotProtocol[], curve: SizeCurve, asOf: string): RadarRow {
  const plan = farmPlan(p, { ageDays: row.age_days, ageUsed: row.age_days ?? 0, sizeValue: row.model.size_value_usd, familyOffset: row.model.family_offset_log10, familyMult: row.model.family_multiplier, growthMult: row.model.growth_multiplier, odds: row.model.launch_odds, kin: row.model.kin, kinMult: row.model.kin ? KIN_HAIRCUT : 1, valueIfLaunched: row.model.value_if_launched_usd, implied: row.implied_value_usd }, asOf);
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    watchlist: row.watchlist,
    implied_value_usd: row.implied_value_usd,
    value_if_launched_usd: row.model.value_if_launched_usd,
    size_value_usd: row.model.size_value_usd,
    family_multiplier: row.model.family_multiplier,
    growth_multiplier: row.model.growth_multiplier,
    launch_odds: row.model.launch_odds,
    kin: row.model.kin,
    band50_low_usd: row.model.band50_low_usd,
    band50_high_usd: row.model.band50_high_usd,
    band80_low_usd: row.model.band80_low_usd,
    band80_high_usd: row.model.band80_high_usd,
    rank_lo: row.model.rank_lo,
    rank_hi: row.model.rank_hi,
    verdict: row.farm.verdict,
    net_usd: row.farm.net_usd,
    net_per_hour_usd: row.farm.net_per_hour_usd,
    break_even_odds: row.farm.break_even_odds,
    pays_from_usd: row.farm.pays_from_usd,
    review_date: row.farm.review_date,
    exit_tvl_usd: plan.exitTvl,
    hold_days: plan.holdDays,
    farm_steps: row.farm_steps,
    nearest: nearestComps(p, comps, curve),
  };
}

// ---------------------------------------------------------------- putting it together

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const model = fitModel(snapshot);
  const comps = comparables(snapshot.protocols);
  const fullSpec = ABLATION_SPECS[ABLATION_SPECS.length - 1]!;
  const loo = looCheck(comps, fullSpec);
  const wf = walkForward(comps, fullSpec);
  const bands = fitBands(loo.signedMissLog);
  const ablation = ablationTable(comps);

  // Bootstrap rank ranges need the board's rows first, scored once.
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => ({ p, terms: impliedValue(p, snapshot.as_of, model) }));
  scored.sort((a, b) => b.terms.implied - a.terms.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const { ranges, top20Stable } = bootstrapRankRanges(
    scored.map((s) => ({ slug: s.p.slug, tvl_usd: s.p.tvl_usd, change_7d: s.p.change_7d, category: s.p.category, ageUsed: s.terms.ageUsed, odds: s.terms.odds, kinMult: s.terms.kinMult })),
    comps,
    model.oddsBuckets,
  );

  const board = buildBoard(snapshot, model, bands, ranges);
  const boardRank = new Map(board.map((r) => [r.slug, r.rank]));
  const offTvl = offTvlOrderCount(board, boardRank);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.watchlist).length;
  const verdictCounts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of board) verdictCounts[r.farm.verdict]++;
  const totalImplied = board.reduce((n, r) => n + r.implied_value_usd, 0);
  const best = [...board].sort((a, b) => b.farm.net_per_hour_usd - a.farm.net_per_hour_usd || (a.slug < b.slug ? -1 : 1))[0]!;
  const ledger = buildLedger(snapshot, new Set(board.map((r) => r.slug)));

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    total_protocols: snapshot.protocols.length,
    ledger,
    model: {
      curve: model.curve,
      flatMultiple: model.flatMultiple,
      offsets: model.offsets.offsets,
      offsetCounts: model.offsets.counts,
      oddsBuckets: model.oddsBuckets,
      medianAgeDays: model.medianAgeDays,
      kinStems: [...model.kinStems].sort(),
      bands,
    },
    validation: {
      comps: comps.length,
      curve: model.curve,
      flatMultiple: model.flatMultiple,
      ablation,
      loo: loo.read,
      walkForward: wf.read,
      walkOrigins: wf.perOrigin,
      bands,
      bootstrapRefits: BOOTSTRAP_REFITS,
      top20Stable,
      offTvlOrder: offTvl,
      oddsBuckets: model.oddsBuckets,
      medianAgeDays: model.medianAgeDays,
    },
    verdictCounts,
    totalImplied,
    bestPerHour: { slug: best.slug, name: best.name, perHour: best.farm.net_per_hour_usd },
    rows: board.map((r) => radarRow(r, index.get(r.slug)!, comps, model.curve, snapshot.as_of)),
    live,
    comps: comps
      .map((p) => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd! }))
      .sort((a, b) => b.mcap_usd - a.mcap_usd),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
