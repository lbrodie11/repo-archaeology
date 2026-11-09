/**
 * Pair-centered, layered ego layout for the Briefing blueprint plate (Cut C-01).
 *
 * One implementation, two environments: `computeFeaturedPlateLayout` (src/map/copy.ts) calls
 * `computePlateLayout` when the report is generated, and `scripts/build-plate-layout.mjs` compiles this
 * same file into `src/map/plate-layout.browser.ts`, which the rich map embeds so plates rebuilt after a
 * click use identical geometry. Keep this module dependency-free, deterministic and browser-safe: no
 * imports, no I/O, no Date/Math.random, and no reliance on input array order beyond indices.
 *
 * Layout model (rows by relationship to the focus pair, not by strength):
 *   focus row      the selected pair A (left) and B (right), labels above, speech balloon over the wire
 *   shared rows    files with a visible relationship to both A and B
 *   one-sided rows files related to A only (left) or B only (right), side by side
 *   other rows     family files reachable only through other files
 * Within each group, files are ranked by their strongest relationship to the pair, rows are packed
 * using measured label widths, rows are ordered to reduce weighted crossings, and x positions come
 * from a barycenter target with minimum label separation. Labels are part of each node's slot, so
 * labels cannot overlap each other or other dots by construction.
 */

export type PlateGroup = 'focus' | 'shared' | 'a-only' | 'b-only' | 'other';
export type PlateMode = 'desktop' | 'compact';
export type LabelCandidatePosition = 'S' | 'N' | 'E' | 'W' | 'SE' | 'SW' | 'NE' | 'NW';
type PlateRelationship = 'ghost' | 'unknown' | 'indirect' | 'direct' | 'test';

/** The subset of `MapData` the layout reads; `MapData` satisfies it structurally on both sides. */
export interface PlateGraph {
  nodes: readonly { path: string; dir: string; changes: number }[];
  edges: readonly {
    source: number;
    target: number;
    relationship: PlateRelationship;
    interval?: { low: number };
    reverseInterval?: { low: number };
    score: number;
    overviewPriority: number;
    shared: number;
  }[];
}

export interface PlateFocus {
  /** Node indices that define the finding: the pair endpoints, or every family member. */
  seeds: readonly number[];
  /** Edge index of the selected relationship (A = source, B = target), or null for the empty state. */
  leadEdge: number | null;
  /** Edge indices drawn as part of the finding (family pairs, or just the lead edge). */
  featuredEdges: readonly number[];
}

export interface PlateOptions {
  mode?: PlateMode;
  /**
   * Plate width in CSS pixels, so the SVG is drawn near 1:1 and labels keep their intended size.
   * Clamped to 560-760 (desktop) or 300-440 (compact); defaults to 760 / 340.
   */
  width?: number;
  /** Relationship kinds currently shown; the lead edge is always kept. Defaults to all kinds. */
  visible?: Partial<Record<string, boolean>>;
  /** x positions from the plate on screen before this one, used to keep shared files in place. */
  previous?: readonly { nodeIndex: number; x: number }[];
}

export interface PlateLabelBox {
  nodeIndex: number;
  text: string;
  fullPath: string;
  position: LabelCandidatePosition;
  x: number;
  y: number;
  w: number;
  h: number;
  anchorX: number;
  anchorY: number;
  textAlign: 'left' | 'center' | 'right';
}

export interface PlateNodeLayout {
  nodeIndex: number;
  path: string;
  shortLabel: string;
  dir: string;
  changes: number;
  x: number;
  y: number;
  r: number;
  isFeaturedEndpoint: boolean;
  group: PlateGroup;
  label: PlateLabelBox;
}

export interface PlateEdgeLayout {
  edgeIndex: number;
  sourceNodeIndex: number;
  targetNodeIndex: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  relationship: PlateRelationship;
  intervalLow: number;
  strokeWidth: number;
  isFeatured: boolean;
  isLeadEdge: boolean;
  /**
   * How far the wire bows to clear files, labels and other wires: the control point of its quadratic
   * curve sits `bend` x length from the chord midpoint along the normal (0 = straight). Kept as a ratio
   * so a dragged file reshapes the curve instead of breaking it. See `wireControlPoint`.
   */
  bend: number;
}

export interface PlateOverflowItem {
  nodeIndex: number;
  path: string;
  shortLabel: string;
  group: PlateGroup;
}

export interface PlateMetrics {
  /** Proper crossings between drawn wires (shared endpoints excluded). */
  crossings: number;
  /** Crossings weighted by importance (lead wire 3, focus wires 1.5, context wires 1). */
  weightedCrossings: number;
  labelOverlaps: number;
  labelNodeOverlaps: number;
  /** Wires that pass through a dot they do not connect to. */
  wiresThroughDots: number;
  /** Wires that cross a label pill of a file they do not connect to. */
  wiresThroughLabels: number;
}

export interface FeaturedPlateLayout {
  width: number;
  height: number;
  mode: PlateMode;
  nodes: PlateNodeLayout[];
  edges: PlateEdgeLayout[];
  leadEdge: PlateEdgeLayout | null;
  balloonTarget: { x: number; y: number } | null;
  balloonBox: { x: number; y: number; w: number; h: number } | null;
  fullComponentNodeCount: number;
  truncatedToEgoCap: boolean;
  /** Relationships between drawn files that the plate omits to stay legible (always disclosed). */
  hiddenContextEdges: number;
  hiddenEdgeIndices: number[];
  /** Compact plates draw the pair and a few neighbours; the rest are listed here, strongest first. */
  overflow: PlateOverflowItem[];
  /** Finding files with no visible relationship under the current filters (not drawn, disclosed). */
  disconnectedNodeIndices: number[];
  metrics: PlateMetrics;
}

export const MAX_EGO_NODES = 12;
/** Context files drawn on a compact (phone) plate besides the pair; the rest go in the list. */
export const COMPACT_CONTEXT_NODES = 2;
export const LABEL_HEIGHT = 18;
/** Width ranges per mode; callers pick compact below the desktop minimum. */
export const PLATE_WIDTH = { desktop: { min: 560, max: 760 }, compact: { min: 300, max: 440 } } as const;

interface PlateConfig {
  width: number;
  pad: number;
  labelFont: number;
  focusFont: number;
  maxLabelUnits: number;
  slotGap: number;
  focusY: number;
  /** Gap from the focus row to the first context row (taller so wires fan out legibly). */
  firstRowGap: number;
  rowGap: number;
  minHeight: number;
  bottomPad: number;
  /** Preferred distance between the two focus files. */
  focusSpan: number;
  balloon: { y: number; w: number; h: number } | null;
  contextEdgeBudget: (contextCount: number) => number;
}

const DESKTOP: PlateConfig = {
  width: 760,
  pad: 16,
  labelFont: 12.5,
  focusFont: 13.5,
  maxLabelUnits: 30,
  slotGap: 18,
  focusY: 100,
  firstRowGap: 100,
  rowGap: 74,
  minHeight: 220,
  bottomPad: 14,
  focusSpan: 320,
  balloon: { y: 12, w: 340, h: 38 },
  contextEdgeBudget: (n) => Math.max(2, Math.ceil(n / 2)),
};

const COMPACT: PlateConfig = {
  width: 340,
  pad: 10,
  labelFont: 13,
  focusFont: 13,
  maxLabelUnits: 22,
  slotGap: 12,
  focusY: 48,
  firstRowGap: 84,
  rowGap: 66,
  minHeight: 150,
  bottomPad: 10,
  focusSpan: 170,
  balloon: null,
  contextEdgeBudget: () => 1,
};

/**
 * Objective weights for choosing between orderings. Label and dot overlaps dominate (they make
 * a file unreadable or unclickable), then wires through unrelated dots (they imply a relationship
 * that does not exist), then weighted crossings, wires through labels, wire length, and movement
 * from the previous plate. Overlaps should already be zero by construction; the weights keep the
 * search honest if a future change breaks that.
 */
/**
 * Candidate bends for each wire and what it costs to choose one. A wire through an unrelated dot reads
 * as a false relationship, so it dominates; then leaving the plate or touching the balloon; then
 * running under a label and crossing other wires. A small cost per unit of bend keeps wires straight
 * unless a curve buys real clarity.
 */
const BEND_OPTIONS = [0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4, -0.4, 0.5, -0.5];
const CURVE_COST = { throughDot: 400, outsidePlate: 500, throughBalloon: 300, throughLabel: 30, crossing: 12, perBend: 20 };

const OBJECTIVE = {
  labelOverlap: 10000,
  labelNodeOverlap: 10000,
  wireThroughDot: 400,
  weightedCrossing: 12,
  wireThroughLabel: 20,
  wireLength: 1,
  movement: 2,
};

// ---- text measurement ------------------------------------------------------------------------

/**
 * Advance width of one code point in em, from the embedded `M PLUS 1 Code` metrics (Latin 0.5em,
 * CJK 1.0em, Hangul 0.865em, emoji ~1.3em via fallback, combining marks 0) plus a 10% margin.
 */
function advanceEm(cp: number): number {
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200d
  ) {
    return 0;
  }
  if (cp >= 0x1f000 && cp <= 0x1faff) return 1.45;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 1.1;
  }
  return 0.55;
}

/** Display units (half-width = 1) used for truncation budgets. */
function codePointUnits(cp: number): number {
  return Math.round(advanceEm(cp) / 0.55);
}

/** Estimated rendered width of a label pill: measured glyph advances plus 10px of padding. */
export function measureLabelWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of Array.from(text)) em += advanceEm(ch.codePointAt(0)!);
  return Math.ceil(em * fontSize + 10);
}

/** Same replacement set as the HTML sanitizers: control, zero-width, separator and bidi controls. */
export function sanitizeDisplayText(value: string): string {
  return String(value == null ? '' : value).replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g,
    (ch) => {
      if (ch === '\n') return '\\n';
      if (ch === '\r') return '\\r';
      if (ch === '\t') return '\\t';
      const code = ch.charCodeAt(0);
      return code <= 0xff ? '\\x' + ('00' + code.toString(16)).slice(-2) : '\\u' + ('0000' + code.toString(16)).slice(-4);
    },
  );
}

/**
 * Middle-truncates to a display-unit budget without splitting surrogate pairs or separating a
 * combining mark from its base, keeping the end of the name (usually the most specific part).
 */
export function truncateLabel(text: string, maxUnits: number): string {
  const cps = Array.from(text);
  const units = cps.map((c) => codePointUnits(c.codePointAt(0)!));
  const total = units.reduce((a, b) => a + b, 0);
  if (total <= maxUnits) return text;
  const budget = Math.max(2, maxUnits - 1);
  const headBudget = Math.ceil(budget * 0.4);
  const tailBudget = budget - headBudget;
  let head = 0;
  let used = 0;
  while (head < cps.length && used + units[head]! <= headBudget) used += units[head++]!;
  while (head > 0 && units[head] === 0) head--;
  let tail = cps.length;
  used = 0;
  while (tail > head && used + units[tail - 1]! <= tailBudget) used += units[--tail]!;
  while (tail < cps.length && units[tail] === 0) tail++;
  return cps.slice(0, head).join('') + '\u2026' + cps.slice(tail).join('');
}

/** Shortest distinct path suffixes (basename, then parent/basename, ...) for the files on one plate. */
export function disambiguateLabels(paths: readonly string[]): string[] {
  const parts = paths.map((p) => p.split('/').filter(Boolean));
  const depth = paths.map(() => 1);
  const labelAt = (i: number): string => {
    const segs = parts[i]!;
    const d = Math.min(depth[i]!, segs.length);
    return segs.slice(segs.length - d).join('/') || paths[i]!;
  };
  for (let pass = 0; pass < 8; pass++) {
    const counts = new Map<string, number>();
    for (let i = 0; i < paths.length; i++) counts.set(labelAt(i), (counts.get(labelAt(i)) ?? 0) + 1);
    let changed = false;
    for (let i = 0; i < paths.length; i++) {
      if ((counts.get(labelAt(i)) ?? 0) > 1 && depth[i]! < parts[i]!.length) {
        depth[i]! += 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return paths.map((_, i) => labelAt(i));
}

// ---- graph normalization --------------------------------------------------------------------

interface NEdge {
  id: number;
  s: number;
  t: number;
  rel: PlateRelationship;
  low: number;
  score: number;
  prio: number;
  shared: number;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Strongest first: ghost wires, overview priority, score, Wilson lower bound, shared commits, index. */
function compareEdgeStrength(a: NEdge, b: NEdge): number {
  return (
    (b.rel === 'ghost' ? 1 : 0) - (a.rel === 'ghost' ? 1 : 0) ||
    b.prio - a.prio ||
    b.score - a.score ||
    b.low - a.low ||
    b.shared - a.shared ||
    a.id - b.id
  );
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

// ---- geometry helpers ------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function segmentsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): number =>
    (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = o(cx, cy, dx, dy, ax, ay);
  const d2 = o(cx, cy, dx, dy, bx, by);
  const d3 = o(ax, ay, bx, by, cx, cy);
  const d4 = o(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function segmentHitsBox(x1: number, y1: number, x2: number, y2: number, b: Box): boolean {
  if (Math.max(x1, x2) < b.x || Math.min(x1, x2) > b.x + b.w || Math.max(y1, y2) < b.y || Math.min(y1, y2) > b.y + b.h) {
    return false;
  }
  const inside = (x: number, y: number): boolean => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  if (inside(x1, y1) || inside(x2, y2)) return true;
  const r = b.x + b.w;
  const btm = b.y + b.h;
  return (
    segmentsCross(x1, y1, x2, y2, b.x, b.y, r, b.y) ||
    segmentsCross(x1, y1, x2, y2, r, b.y, r, btm) ||
    segmentsCross(x1, y1, x2, y2, b.x, btm, r, btm) ||
    segmentsCross(x1, y1, x2, y2, b.x, b.y, b.x, btm)
  );
}

/**
 * Control point of a wire's quadratic Bezier: the chord midpoint moved `bend` x chord length along the
 * left-hand normal (screen coordinates). A bend of 0 gives the midpoint, i.e. a straight wire. The
 * renderer uses this same function, so drawn curves match the geometry the layout scored.
 */
export function wireControlPoint(x1: number, y1: number, x2: number, y2: number, bend: number): { x: number; y: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  if (!(len > 1) || !bend || !Number.isFinite(bend)) return { x: mx, y: my };
  return { x: mx - (dy / len) * bend * len, y: my + (dx / len) * bend * len };
}

type Point = [number, number];

/** Points along a wire: its two ends when straight, or 10 segments along the curve (enough for a gentle quadratic). */
function wirePolyline(x1: number, y1: number, x2: number, y2: number, bend: number): Point[] {
  if (!bend) return [[x1, y1], [x2, y2]];
  const c = wireControlPoint(x1, y1, x2, y2, bend);
  const pts: Point[] = [];
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    const u = 1 - t;
    pts.push([u * u * x1 + 2 * u * t * c.x + t * t * x2, u * u * y1 + 2 * u * t * c.y + t * t * y2]);
  }
  return pts;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boundsOf(poly: readonly Point[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function polylineCrossings(a: readonly Point[], b: readonly Point[]): number {
  const ba = boundsOf(a);
  const bb = boundsOf(b);
  if (ba.maxX < bb.minX || bb.maxX < ba.minX || ba.maxY < bb.minY || bb.maxY < ba.minY) return 0;
  let n = 0;
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      if (segmentsCross(a[i]![0], a[i]![1], a[i + 1]![0], a[i + 1]![1], b[j]![0], b[j]![1], b[j + 1]![0], b[j + 1]![1])) n++;
    }
  }
  return n;
}

/** True when (px, py) lies within `limit` of the wire. */
function polylineNear(px: number, py: number, poly: readonly Point[], limit: number): boolean {
  const b = boundsOf(poly);
  if (px < b.minX - limit || px > b.maxX + limit || py < b.minY - limit || py > b.maxY + limit) return false;
  return polylineDistance(px, py, poly) < limit;
}

function polylineDistance(px: number, py: number, poly: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    best = Math.min(best, distToSegment(px, py, poly[i]![0], poly[i]![1], poly[i + 1]![0], poly[i + 1]![1]));
  }
  return best;
}

function polylineHitsBox(poly: readonly Point[], b: Box): boolean {
  const pb = boundsOf(poly);
  if (pb.maxX < b.x || pb.minX > b.x + b.w || pb.maxY < b.y || pb.minY > b.y + b.h) return false;
  for (let i = 0; i + 1 < poly.length; i++) {
    if (segmentHitsBox(poly[i]![0], poly[i]![1], poly[i + 1]![0], poly[i + 1]![1], b)) return true;
  }
  return false;
}

/**
 * Least-squares placement of an ordered row: positions as close as possible to their targets while
 * keeping each neighbour at least `gaps[i]` apart and the row inside [lo, hi] (pool-adjacent-violators).
 */
function placeRow(targets: readonly number[], halfWidths: readonly number[], gap: number, lo: number, hi: number): number[] {
  const n = targets.length;
  if (n === 0) return [];
  const offsets = [0];
  for (let i = 1; i < n; i++) offsets.push(offsets[i - 1]! + halfWidths[i - 1]! + halfWidths[i]! + gap);
  const q = targets.map((t, i) => t - offsets[i]!);
  const blocks: { sum: number; count: number }[] = [];
  for (const v of q) {
    blocks.push({ sum: v, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!;
      const prev = blocks[blocks.length - 2]!;
      if (prev.sum / prev.count <= last.sum / last.count) break;
      prev.sum += last.sum;
      prev.count += last.count;
      blocks.pop();
    }
  }
  const y: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.count; k++) y.push(b.sum / b.count);
  const yMin = lo + halfWidths[0]!;
  const yMax = hi - halfWidths[n - 1]! - offsets[n - 1]!;
  return y.map((v, i) => Math.max(yMin, Math.min(Math.max(yMin, yMax), v)) + offsets[i]!);
}

/** Splits an ordered list into `k` contiguous chunks whose sizes differ by at most one (larger first). */
function chunk<T>(list: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  let start = 0;
  for (let r = 0; r < k; r++) {
    const size = Math.floor(list.length / k) + (r < list.length % k ? 1 : 0);
    out.push(list.slice(start, start + size));
    start += size;
  }
  return out;
}

// ---- main entry ----------------------------------------------------------------------------

interface PNode {
  id: number;
  path: string;
  dir: string;
  changes: number;
  group: PlateGroup;
  /** 0 = A-side, 1 = middle, 2 = B-side: rows keep this left-to-right order. */
  side: number;
  rank: number;
  r: number;
  label: string;
  labelW: number;
  slotHalf: number;
}

export function computePlateLayout(graph: PlateGraph, focus: PlateFocus, options: PlateOptions = {}): FeaturedPlateLayout {
  const mode: PlateMode = options.mode === 'compact' ? 'compact' : 'desktop';
  const base = mode === 'compact' ? COMPACT : DESKTOP;
  const range = PLATE_WIDTH[mode];
  const requested = typeof options.width === 'number' && Number.isFinite(options.width) ? Math.floor(options.width) : base.width;
  const W = Math.max(range.min, Math.min(range.max, requested));
  const cfg: PlateConfig = W === base.width ? base : { ...base, width: W, focusSpan: Math.round((base.focusSpan * W) / base.width) };
  const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
  const validNode = (i: unknown): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < nodeCount;
  const leadId = typeof focus.leadEdge === 'number' && Number.isInteger(focus.leadEdge) ? focus.leadEdge : -1;
  const isShown = (rel: string, id: number): boolean =>
    id === leadId || !options.visible || Boolean(options.visible[rel]);

  // 1) Normalize the visible graph (indices are the shared identity across server and browser)
  const edges: NEdge[] = [];
  const pairKey = (a: number, b: number): string => Math.min(a, b) + ':' + Math.max(a, b);
  const leadRaw = leadId >= 0 ? (graph.edges || [])[leadId] : undefined;
  const leadKey = leadRaw && validNode(leadRaw.source) && validNode(leadRaw.target) ? pairKey(leadRaw.source, leadRaw.target) : null;
  const seenPairs = new Set<string>(leadKey ? [leadKey] : []);
  (graph.edges || []).forEach((e, id) => {
    if (!e || !validNode(e.source) || !validNode(e.target) || e.source === e.target) return;
    if (!isShown(e.relationship, id)) return;
    const key = pairKey(e.source, e.target);
    // One wire per pair; the selected relationship wins over any duplicate of it
    if (id !== leadId && seenPairs.has(key)) return;
    seenPairs.add(key);
    const low = Math.max(finite(e.interval?.low), finite(e.reverseInterval?.low));
    edges.push({
      id,
      s: e.source,
      t: e.target,
      rel: e.relationship,
      low: Math.max(0, Math.min(1, low)),
      score: finite(e.score),
      prio: finite(e.overviewPriority),
      shared: finite(e.shared),
    });
  });
  const edgeById = new Map<number, NEdge>();
  const adjacency = new Map<number, NEdge[]>();
  for (const e of edges) {
    edgeById.set(e.id, e);
    for (const v of [e.s, e.t]) {
      const list = adjacency.get(v);
      if (list) list.push(e);
      else adjacency.set(v, [e]);
    }
  }
  const other = (e: NEdge, v: number): number => (e.s === v ? e.t : e.s);
  const lead = edgeById.get(leadId) ?? null;
  const A = lead ? lead.s : -1;
  const B = lead ? lead.t : -1;

  const seeds = Array.from(new Set((focus.seeds || []).filter(validNode))).sort((a, b) => a - b);
  if (lead) {
    for (const v of [A, B]) if (seeds.indexOf(v) < 0) seeds.push(v);
  }
  const featured = new Set<number>((focus.featuredEdges || []).filter((id) => edgeById.has(id)));
  if (lead) featured.add(lead.id);

  // 2) Component size (for the "N of M files" disclosure)
  const compSeen = new Set<number>(seeds);
  const queue = seeds.slice();
  for (let q = 0; q < queue.length; q++) {
    for (const e of adjacency.get(queue[q]!) ?? []) {
      const v = other(e, queue[q]!);
      if (!compSeen.has(v)) {
        compSeen.add(v);
        queue.push(v);
      }
    }
  }

  const bestEdgeBetween = (v: number, targets: ReadonlySet<number>): NEdge | null => {
    let best: NEdge | null = null;
    for (const e of adjacency.get(v) ?? []) {
      if (targets.has(other(e, v)) && (!best || compareEdgeStrength(e, best) < 0)) best = e;
    }
    return best;
  };
  const byStrength = (a: { edge: NEdge | null; id: number }, b: { edge: NEdge | null; id: number }): number => {
    if (a.edge && b.edge) return compareEdgeStrength(a.edge, b.edge) || a.id - b.id;
    if (a.edge) return -1;
    if (b.edge) return 1;
    return a.id - b.id;
  };
  const pathOf = (v: number): string => sanitizeDisplayText(graph.nodes[v]!.path);

  // 3) Ego selection: the pair, then seeds, then neighbours, each ranked by their strongest wire
  const focusSet = new Set<number>(lead ? [A, B] : []);
  const ego: number[] = lead ? [A, B] : [];
  const seedRank = seeds
    .filter((v) => !focusSet.has(v))
    .map((id) => ({ id, edge: bestEdgeBetween(id, focusSet.size ? focusSet : new Set(seeds)) }))
    .sort(byStrength);
  for (const s of seedRank) if (ego.length < MAX_EGO_NODES) ego.push(s.id);
  if (ego.length < MAX_EGO_NODES) {
    const egoSet = new Set(ego);
    const candidates = new Map<number, NEdge>();
    for (const v of ego) {
      for (const e of adjacency.get(v) ?? []) {
        const u = other(e, v);
        if (egoSet.has(u)) continue;
        const prev = candidates.get(u);
        if (!prev || compareEdgeStrength(e, prev) < 0) candidates.set(u, e);
      }
    }
    const ranked = Array.from(candidates.entries())
      .map(([id, edge]) => ({ id, edge }))
      .sort(byStrength);
    for (const c of ranked) if (ego.length < MAX_EGO_NODES) ego.push(c.id);
  }

  // 4) Classify by relationship to the pair, then decide what is drawn
  const egoSet = new Set(ego);
  const neighbours = (v: number): number[] => (adjacency.get(v) ?? []).map((e) => other(e, v)).filter((u) => egoSet.has(u));
  const groupOf = (v: number): PlateGroup => {
    if (focusSet.has(v)) return 'focus';
    if (!lead) return 'other';
    const ns = neighbours(v);
    const hasA = ns.indexOf(A) >= 0;
    const hasB = ns.indexOf(B) >= 0;
    return hasA && hasB ? 'shared' : hasA ? 'a-only' : hasB ? 'b-only' : 'other';
  };
  const groupOrder: Record<PlateGroup, number> = { focus: 0, shared: 1, 'a-only': 2, 'b-only': 2, other: 3 };
  const strengthToPair = (v: number): NEdge | null =>
    bestEdgeBetween(v, focusSet.size ? focusSet : egoSet) ?? bestEdgeBetween(v, egoSet);
  const contextRanked = ego
    .filter((v) => !focusSet.has(v))
    .map((id) => ({ id, group: groupOf(id), edge: strengthToPair(id) }))
    .sort((a, b) => groupOrder[a.group] - groupOrder[b.group] || byStrength(a, b));
  // With a selected pair, a finding file with no visible relationship cannot be placed honestly, so it is
  // disclosed instead of drawn. The context view (no pair) shows its files even when they are unlinked.
  const disconnected = lead ? contextRanked.filter((c) => neighbours(c.id).length === 0).map((c) => c.id) : [];
  const connectedContext = contextRanked.filter((c) => disconnected.indexOf(c.id) < 0);
  // Compact plates draw only files wired straight to the pair, so every drawn file keeps a visible wire;
  // the context view (no pair) draws as many files as the pair would have taken plus its neighbours.
  const compactDrawable = lead
    ? connectedContext.filter((c) => c.group !== 'other').slice(0, COMPACT_CONTEXT_NODES)
    : connectedContext.slice(0, COMPACT_CONTEXT_NODES + 2);
  const drawnContext = mode === 'compact' ? compactDrawable : connectedContext;
  const overflowContext = mode === 'compact' ? connectedContext.filter((c) => compactDrawable.indexOf(c) < 0) : [];
  const drawnIds = ego.filter((v) => focusSet.has(v)).concat(drawnContext.map((c) => c.id));
  const drawnSet = new Set(drawnIds);

  // Labels are disambiguated across everything the reader can see (plate and overflow list)
  const visibleIds = drawnIds.concat(overflowContext.map((c) => c.id));
  const fullLabels = disambiguateLabels(visibleIds.map(pathOf));
  const labelById = new Map<number, string>();
  visibleIds.forEach((id, i) => labelById.set(id, fullLabels[i]!));

  // 5) Topology-aware wire selection. Required: the lead wire, every wire to the pair (they define
  //    the groups) and, for any file still without a wire, its strongest one. Small plates show every
  //    wire; denser plates add optional context wires after placement (see step 9).
  const raw = edges.filter((e) => drawnSet.has(e.s) && drawnSet.has(e.t)).sort((a, b) => a.id - b.id);
  const showAll = !lead || raw.length <= drawnIds.length + 3;
  const kept: NEdge[] = showAll ? raw.slice() : raw.filter((e) => focusSet.has(e.s) || focusSet.has(e.t));
  if (!showAll) {
    const degree = new Map<number, number>();
    for (const e of kept) for (const v of [e.s, e.t]) degree.set(v, (degree.get(v) ?? 0) + 1);
    for (const v of drawnIds) {
      if (degree.get(v)) continue;
      const rescue = raw.filter((e) => e.s === v || e.t === v).sort(compareEdgeStrength)[0];
      if (rescue && kept.indexOf(rescue) < 0) {
        kept.push(rescue);
        for (const u of [rescue.s, rescue.t]) degree.set(u, (degree.get(u) ?? 0) + 1);
      }
    }
  }
  const optionalWires = showAll ? [] : raw.filter((e) => kept.indexOf(e) < 0).sort(compareEdgeStrength);
  // Placement only uses the required wires (optional ones are added after placement), so index them once
  const placementNeighbours = new Map<number, number[]>();
  for (const e of kept) {
    for (const v of [e.s, e.t]) {
      const list = placementNeighbours.get(v);
      if (list) list.push(other(e, v));
      else placementNeighbours.set(v, [other(e, v)]);
    }
  }

  // 6) Node sizes and label widths
  const focusLabelMax = Math.floor((W / 2 - cfg.pad - 12) / (cfg.focusFont * 0.55)) - 2;
  const rowCap = W - 2 * cfg.pad;
  const contextLabelMax = Math.min(cfg.maxLabelUnits, Math.floor((rowCap - cfg.slotGap - 10) / (cfg.labelFont * 0.55)));
  const radiusOf = (v: number): number => {
    const base = Math.max(5.5, Math.min(11, 4.2 + Math.sqrt(Math.max(0, finite(graph.nodes[v]!.changes))) * 0.85));
    return round1(focusSet.has(v) ? Math.max(7.5, base) : base);
  };
  const pnodes = new Map<number, PNode>();
  const rankById = new Map<number, number>();
  contextRanked.forEach((c, i) => rankById.set(c.id, i));
  for (const id of drawnIds) {
    const isFocus = focusSet.has(id);
    const label = truncateLabel(labelById.get(id) ?? pathOf(id), isFocus ? Math.min(cfg.maxLabelUnits, focusLabelMax) : contextLabelMax);
    const labelW = measureLabelWidth(label, isFocus ? cfg.focusFont : cfg.labelFont);
    const r = radiusOf(id);
    const group = groupOf(id);
    pnodes.set(id, {
      id,
      path: pathOf(id),
      dir: sanitizeDisplayText(graph.nodes[id]!.dir),
      changes: finite(graph.nodes[id]!.changes),
      group,
      side: group === 'a-only' ? 0 : group === 'b-only' ? 2 : 1,
      rank: rankById.get(id) ?? -1,
      r,
      label,
      labelW,
      slotHalf: Math.max(labelW, 2 * r) / 2,
    });
  }

  // 7) Rows: focus pair, then shared, one-sided (A left / B right), and other files
  const byGroup = (g: PlateGroup): PNode[] => drawnContext.filter((c) => c.group === g).map((c) => pnodes.get(c.id)!);
  const fits = (row: readonly PNode[]): boolean =>
    row.reduce((sum, p) => sum + 2 * p.slotHalf, 0) + Math.max(0, row.length - 1) * cfg.slotGap <= rowCap + 1e-6;
  const packTier = (sides: readonly PNode[][]): PNode[][] => {
    const live = sides.filter((s) => s.length > 0);
    if (live.length === 0) return [];
    const most = Math.max(...live.map((s) => s.length));
    for (let k = 1; k <= most; k++) {
      const rows: PNode[][] = [];
      for (let r = 0; r < k; r++) rows.push(([] as PNode[]).concat(...live.map((s) => chunk(s, k)[r]!)));
      if (rows.every(fits)) return rows.filter((row) => row.length > 0);
    }
    return live.reduce((acc, s) => acc.concat(s.map((p) => [p])), [] as PNode[][]);
  };
  const rows: PNode[][] = [
    ...packTier([byGroup('shared')]),
    ...packTier([byGroup('a-only'), byGroup('b-only')]),
    ...packTier([byGroup('other')]),
  ];

  const previousX = new Map<number, number>();
  for (const p of options.previous ?? []) {
    if (p && validNode(p.nodeIndex) && Number.isFinite(p.x)) previousX.set(p.nodeIndex, p.x);
  }

  // Focus row geometry (fixed during the search)
  const mid = W / 2;
  const pos = new Map<number, { x: number; y: number }>();
  if (lead) {
    const pa = pnodes.get(A)!;
    const pb = pnodes.get(B)!;
    const half = Math.max(cfg.focusSpan / 2, Math.max(pa.labelW, pb.labelW) / 2 + 14);
    const ax = Math.max(cfg.pad + pa.labelW / 2, Math.min(mid - 14 - pa.labelW / 2, mid - half));
    const bx = Math.min(W - cfg.pad - pb.labelW / 2, Math.max(mid + 14 + pb.labelW / 2, mid + half));
    pos.set(A, { x: ax, y: cfg.focusY });
    pos.set(B, { x: bx, y: cfg.focusY });
  }
  const firstRowY = lead ? cfg.focusY + cfg.firstRowGap : cfg.pad + LABEL_HEIGHT;
  const rowY = (r: number): number => firstRowY + r * cfg.rowGap;

  // 8) Ordering search: barycenter start, then adjacent swaps within a side, scored by the objective
  type Positions = Map<number, { x: number; y: number }>;
  /** Barycenter target for a file: mean x of its drawn wires' already-placed ends. */
  const targetX = (p: PNode, g: Positions): number => {
    const placed = (placementNeighbours.get(p.id) ?? []).filter((u) => g.has(u));
    if (placed.length > 0) return placed.reduce((sum, u) => sum + g.get(u)!.x, 0) / placed.length;
    return previousX.get(p.id) ?? mid;
  };
  /** Places rows top to bottom, each against the rows above it. */
  const placeOrders = (orders: readonly PNode[][], shifts: readonly number[] = []): Positions => {
    const g: Positions = new Map(pos);
    orders.forEach((row, r) => {
      const targets = row.map((p) => targetX(p, g) + (shifts[r] ?? 0));
      const xs = placeRow(targets, row.map((p) => p.slotHalf), cfg.slotGap, cfg.pad, W - cfg.pad);
      row.forEach((p, i) => g.set(p.id, { x: xs[i]!, y: rowY(r) }));
    });
    return g;
  };
  const geometry = (orders: PNode[][], shifts: readonly number[] = []): { pos: Positions; score: number; metrics: PlateMetrics } => {
    const g = placeOrders(orders, shifts);
    const metrics = measure(g);
    let movement = 0;
    for (const [id, x] of previousX) if (g.has(id) && !focusSet.has(id)) movement += Math.abs(g.get(id)!.x - x) / W;
    let length = 0;
    for (const e of kept) length += Math.hypot(g.get(e.s)!.x - g.get(e.t)!.x, g.get(e.s)!.y - g.get(e.t)!.y) / W;
    const score =
      OBJECTIVE.labelOverlap * metrics.labelOverlaps +
      OBJECTIVE.labelNodeOverlap * metrics.labelNodeOverlaps +
      OBJECTIVE.wireThroughDot * metrics.wiresThroughDots +
      OBJECTIVE.weightedCrossing * metrics.weightedCrossings +
      OBJECTIVE.wireThroughLabel * metrics.wiresThroughLabels +
      OBJECTIVE.wireLength * length +
      OBJECTIVE.movement * movement;
    return { pos: g, score, metrics };
  };

  const labelBoxOf = (p: PNode, at: { x: number; y: number }): Box =>
    focusSet.has(p.id)
      ? { x: at.x - p.labelW / 2, y: at.y - p.r - 5 - LABEL_HEIGHT, w: p.labelW, h: LABEL_HEIGHT }
      : { x: at.x - p.labelW / 2, y: at.y + p.r + 5, w: p.labelW, h: LABEL_HEIGHT };

  function measure(g: Positions, bends?: ReadonlyMap<number, number>): PlateMetrics {
    const list = drawnIds.map((id) => ({ p: pnodes.get(id)!, at: g.get(id)! }));
    const boxes = list.map(({ p, at }) => labelBoxOf(p, at));
    let labelOverlaps = 0;
    let labelNodeOverlaps = 0;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) if (boxesOverlap(boxes[i]!, boxes[j]!)) labelOverlaps++;
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const c = list[j]!;
        const b = boxes[i]!;
        const nx = Math.max(b.x, Math.min(c.at.x, b.x + b.w));
        const ny = Math.max(b.y, Math.min(c.at.y, b.y + b.h));
        if (Math.hypot(c.at.x - nx, c.at.y - ny) < c.p.r) labelNodeOverlaps++;
      }
    }
    const weight = (e: NEdge): number => (e === lead ? 3 : focusSet.has(e.s) || focusSet.has(e.t) ? 1.5 : 1);
    const polys = kept.map((e) => {
      const p1 = g.get(e.s)!, p2 = g.get(e.t)!;
      return wirePolyline(p1.x, p1.y, p2.x, p2.y, bends?.get(e.id) ?? 0);
    });
    let crossings = 0;
    let weightedCrossings = 0;
    for (let i = 0; i < kept.length; i++) {
      for (let j = i + 1; j < kept.length; j++) {
        const e = kept[i]!;
        const f = kept[j]!;
        if (e.s === f.s || e.s === f.t || e.t === f.s || e.t === f.t) continue;
        const n = polylineCrossings(polys[i]!, polys[j]!);
        crossings += n;
        weightedCrossings += n * weight(e) * weight(f);
      }
    }
    let wiresThroughDots = 0;
    let wiresThroughLabels = 0;
    kept.forEach((e, k) => {
      list.forEach(({ p, at }, i) => {
        if (p.id === e.s || p.id === e.t) return;
        if (polylineNear(at.x, at.y, polys[k]!, p.r + 3)) wiresThroughDots++;
        if (polylineHitsBox(polys[k]!, boxes[i]!)) wiresThroughLabels++;
      });
    });
    return { crossings, weightedCrossings, labelOverlaps, labelNodeOverlaps, wiresThroughDots, wiresThroughLabels };
  }

  const sortRow = (row: PNode[], g: Positions): PNode[] =>
    row
      .map((p) => ({ p, t: targetX(p, g), prev: previousX.get(p.id) ?? Infinity }))
      .sort((a, b) => a.p.side - b.p.side || a.t - b.t || a.prev - b.prev || a.p.rank - b.p.rank || a.p.id - b.p.id)
      .map((o) => o.p);

  let orders: PNode[][] = [];
  for (let r = 0; r < rows.length; r++) orders.push(sortRow(rows[r]!, placeOrders(orders)));
  let best = geometry(orders);
  for (let pass = 0; pass < 6; pass++) {
    let improved = false;
    // Re-sort each row against the current placement (a barycenter sweep that also sees lower rows)
    for (let r = 0; r < orders.length; r++) {
      const all = best.pos;
      const resorted = sortRow(orders[r]!, all);
      if (resorted.some((p, i) => p !== orders[r]![i])) {
        const trial = orders.slice();
        trial[r] = resorted;
        const t = geometry(trial);
        if (t.score < best.score - 1e-9) {
          orders = trial;
          best = t;
          improved = true;
        }
      }
    }
    for (let r = 0; r < orders.length; r++) {
      for (let i = 0; i + 1 < orders[r]!.length; i++) {
        const row = orders[r]!;
        if (row[i]!.side !== row[i + 1]!.side) continue;
        const swapped = row.slice();
        swapped[i] = row[i + 1]!;
        swapped[i + 1] = row[i]!;
        const trial = orders.slice();
        trial[r] = swapped;
        const t = geometry(trial);
        if (t.score < best.score - 1e-9) {
          orders = trial;
          best = t;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }

  // Slide rows sideways (by fractions of a typical slot) when that clears wires from dots and labels
  const shifts = orders.map(() => 0);
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 0; r < orders.length; r++) {
      const row = orders[r]!;
      const slot = row.reduce((sum, p) => sum + 2 * p.slotHalf, 0) / Math.max(1, row.length) + cfg.slotGap;
      for (const f of [-0.5, -0.25, 0.25, 0.5, -1, 1]) {
        const trialShifts = shifts.slice();
        trialShifts[r] = f * slot;
        const t = geometry(orders, trialShifts);
        if (t.score < best.score - 1e-9) {
          best = t;
          shifts[r] = f * slot;
        }
      }
    }
  }

  // 9) Optional context wires, strongest first, while they stay legible: no wire through an unrelated
  //    dot and at most one new crossing each, up to the mode's budget. Everything else is disclosed.
  let budget = cfg.contextEdgeBudget(drawnContext.length);
  for (const e of optionalWires) {
    if (budget <= 0) break;
    kept.push(e);
    const m = measure(best.pos);
    if (m.wiresThroughDots > best.metrics.wiresThroughDots || m.crossings - best.metrics.crossings > 1) {
      kept.pop();
      continue;
    }
    best = { pos: best.pos, score: best.score, metrics: m };
    budget--;
  }
  // 10) Curve wires around what they would otherwise run through. The lead wire stays straight (the
  //     balloon points at its midpoint); every other wire picks the cheapest bend given the others,
  //     longest first, over two passes so early choices can adapt to later ones.
  const bends = new Map<number, number>();
  {
    const g = best.pos;
    let bottom = 0;
    for (const id of drawnIds) {
      const p = pnodes.get(id)!;
      const box = labelBoxOf(p, g.get(id)!);
      bottom = Math.max(bottom, g.get(id)!.y + p.r, box.y + box.h);
    }
    const plateBottom = Math.max(cfg.minHeight, bottom + cfg.bottomPad);
    const files = drawnIds.map((id) => ({ p: pnodes.get(id)!, at: g.get(id)!, box: labelBoxOf(pnodes.get(id)!, g.get(id)!) }));
    let balloonZone: Box | null = null;
    if (lead && cfg.balloon) {
      const cx = (g.get(A)!.x + g.get(B)!.x) / 2;
      const bx = Math.max(12, Math.min(W - cfg.balloon.w - 12, cx - cfg.balloon.w / 2));
      balloonZone = { x: bx - 4, y: cfg.balloon.y - 4, w: cfg.balloon.w + 8, h: cfg.balloon.h + 8 };
    }
    const ends = (e: NEdge): [number, number, number, number] => {
      const p1 = g.get(e.s)!, p2 = g.get(e.t)!;
      return [p1.x, p1.y, p2.x, p2.y];
    };
    const polyOf = (e: NEdge, bend: number): Point[] => {
      const [x1, y1, x2, y2] = ends(e);
      return wirePolyline(x1, y1, x2, y2, bend);
    };
    // Each wire's current curve, resampled only when its bend changes
    const current = new Map<number, Point[]>();
    for (const e of kept) current.set(e.id, polyOf(e, 0));
    const cost = (e: NEdge, bend: number, limit = Infinity): number => {
      const poly = polyOf(e, bend);
      let c = Math.abs(bend) * CURVE_COST.perBend;
      for (const { p, at, box } of files) {
        // +1.5px covers the gap between the sampled polyline and the true curve
        if (p.id !== e.s && p.id !== e.t && polylineNear(at.x, at.y, poly, p.r + 4.5)) c += CURVE_COST.throughDot;
        if (polylineHitsBox(poly, box)) c += CURVE_COST.throughLabel;
      }
      // Margins of a few px cover the gap between the sampled polyline and the true curve
      if (poly.some(([x, y]) => x < 3 || x > W - 3 || y < 3 || y > plateBottom - 3)) c += CURVE_COST.outsidePlate;
      // The pair is the top of the drawing: no other wire may climb above its row (or into the balloon)
      if (lead && poly.some(([, y]) => y < cfg.focusY - 4)) c += CURVE_COST.throughBalloon;
      if (balloonZone && polylineHitsBox(poly, balloonZone)) c += CURVE_COST.throughBalloon;
      for (const f of kept) {
        if (c >= limit) return c;
        if (f === e || f.s === e.s || f.s === e.t || f.t === e.s || f.t === e.t) continue;
        c += CURVE_COST.crossing * polylineCrossings(poly, current.get(f.id)!);
      }
      return c;
    };
    const curvable = kept
      .filter((e) => e !== lead)
      .map((e) => {
        const [x1, y1, x2, y2] = ends(e);
        return { e, len: Math.hypot(x2 - x1, y2 - y1) };
      })
      .sort((a, b) => b.len - a.len || a.e.id - b.e.id)
      .map((o) => o.e);
    for (let pass = 0; pass < 2; pass++) {
      for (const e of curvable) {
        let bestBend = bends.get(e.id) ?? 0;
        let bestCost = cost(e, bestBend);
        for (const b of BEND_OPTIONS) {
          const c = cost(e, b, bestCost);
          if (c < bestCost - 1e-9) {
            bestCost = c;
            bestBend = b;
          }
        }
        if (bestBend) bends.set(e.id, bestBend);
        else bends.delete(e.id);
        current.set(e.id, polyOf(e, bestBend));
      }
    }
    best = { pos: best.pos, score: best.score, metrics: measure(best.pos, bends) };
  }

  const keptIds = new Set(kept.map((e) => e.id));
  const hiddenEdgeIndices = raw.filter((e) => !keptIds.has(e.id)).map((e) => e.id);

  // 11) Emit geometry (vertically centred inside the minimum height), validating every coordinate
  const finalPos = best.pos;
  let contentBottom = 0;
  for (const id of drawnIds) {
    const p = pnodes.get(id)!;
    const at = finalPos.get(id)!;
    const box = labelBoxOf(p, at);
    contentBottom = Math.max(contentBottom, at.y + p.r, box.y + box.h);
  }
  const contentHeight = contentBottom + cfg.bottomPad;
  const height = Math.ceil(Math.max(cfg.minHeight, contentHeight));
  const shiftY = drawnIds.length > 0 ? Math.max(0, Math.floor((cfg.minHeight - contentHeight) / 2)) : 0;

  const nodesOut: PlateNodeLayout[] = drawnIds.map((id) => {
    const p = pnodes.get(id)!;
    const at = finalPos.get(id)!;
    const x = round1(at.x);
    const y = round1(at.y + shiftY);
    const box = labelBoxOf(p, { x, y });
    const isFocus = focusSet.has(id);
    return {
      nodeIndex: id,
      path: p.path,
      shortLabel: p.label,
      dir: p.dir,
      changes: p.changes,
      x,
      y,
      r: p.r,
      isFeaturedEndpoint: isFocus,
      group: p.group,
      label: {
        nodeIndex: id,
        text: p.label,
        fullPath: p.path,
        position: isFocus ? 'N' : 'S',
        x: round1(box.x),
        y: round1(box.y),
        w: box.w,
        h: box.h,
        anchorX: x,
        anchorY: round1(box.y + 13),
        textAlign: 'center',
      },
    };
  });
  const nodeOut = new Map(nodesOut.map((n) => [n.nodeIndex, n]));
  const edgesOut: PlateEdgeLayout[] = kept
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((e) => ({
      edgeIndex: e.id,
      sourceNodeIndex: e.s,
      targetNodeIndex: e.t,
      x1: nodeOut.get(e.s)!.x,
      y1: nodeOut.get(e.s)!.y,
      x2: nodeOut.get(e.t)!.x,
      y2: nodeOut.get(e.t)!.y,
      relationship: e.rel,
      intervalLow: e.low,
      strokeWidth: round1(1.4 + e.low * 2.8),
      isFeatured: featured.has(e.id),
      isLeadEdge: e === lead,
      bend: bends.get(e.id) ?? 0,
    }));
  const leadOut = edgesOut.find((e) => e.isLeadEdge) ?? null;
  const balloonTarget =
    leadOut && cfg.balloon ? { x: round1((leadOut.x1 + leadOut.x2) / 2), y: round1((leadOut.y1 + leadOut.y2) / 2) } : null;
  const balloonBox =
    balloonTarget && cfg.balloon
      ? {
          x: round1(Math.max(12, Math.min(W - cfg.balloon.w - 12, balloonTarget.x - cfg.balloon.w / 2))),
          y: cfg.balloon.y + shiftY,
          w: cfg.balloon.w,
          h: cfg.balloon.h,
        }
      : null;

  const coords: number[] = [];
  for (const n of nodesOut) coords.push(n.x, n.y, n.r, n.label.x, n.label.y, n.label.w);
  for (const e of edgesOut) coords.push(e.x1, e.y1, e.x2, e.y2, e.strokeWidth, e.bend);
  if (!coords.every((v) => Number.isFinite(v)) || !Number.isFinite(height)) {
    return emptyLayout(W, cfg.minHeight, mode, compSeen.size);
  }

  return {
    width: W,
    height,
    mode,
    nodes: nodesOut,
    edges: edgesOut,
    leadEdge: leadOut,
    balloonTarget,
    balloonBox,
    fullComponentNodeCount: compSeen.size,
    truncatedToEgoCap: compSeen.size > ego.length,
    hiddenContextEdges: hiddenEdgeIndices.length,
    hiddenEdgeIndices,
    overflow: overflowContext.map((c) => ({
      nodeIndex: c.id,
      path: pathOf(c.id),
      shortLabel: truncateLabel(labelById.get(c.id) ?? pathOf(c.id), cfg.maxLabelUnits + 10),
      group: c.group,
    })),
    disconnectedNodeIndices: disconnected,
    metrics: best.metrics,
  };
}

function emptyLayout(width: number, height: number, mode: PlateMode, componentSize: number): FeaturedPlateLayout {
  return {
    width,
    height,
    mode,
    nodes: [],
    edges: [],
    leadEdge: null,
    balloonTarget: null,
    balloonBox: null,
    fullComponentNodeCount: componentSize,
    truncatedToEgoCap: false,
    hiddenContextEdges: 0,
    hiddenEdgeIndices: [],
    overflow: [],
    disconnectedNodeIndices: [],
    metrics: { crossings: 0, weightedCrossings: 0, labelOverlaps: 0, labelNodeOverlaps: 0, wiresThroughDots: 0, wiresThroughLabels: 0 },
  };
}
