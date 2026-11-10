import type { MapData, MapEdge } from '../commands/map.js';
import type { Relationship } from '../imports/classify.js';
import { FRAME12, type StyleMode } from '../style/frame12.js';

export const CELL_SIZE = 300;
export const MAX_DISTANCE_SQ = 90000; // 300 * 300
export const REPULSION_STRENGTH = 1400;
export const SPRING_FACTOR = 0.05;
export const DIR_PULL = 0.012;
export const DAMPING = 0.62;
export const ALPHA_DECAY = 0.985;
export const ALPHA_STOP = 0.02;
export const MAX_LAYOUT_TICKS = 400;

export const RICH_GRID_COLS = 12;
export const RICH_COL_WIDTH = 88;
export const RICH_FRAME_PAD_X = 28;
export const RICH_FRAME_PAD_TOP = 52;
export const RICH_FRAME_PAD_BOTTOM = 28;
export const WEAK_INTERVAL_THRESHOLD = 0.3;

/**
 * `unchecked` holds components made only of unchecked (`unknown`) links while the map also has
 * import-backed relationships: those links start hidden, so their frames sort last instead of
 * opening the sheet with empty-looking frames.
 */
export type PriorityBand = 'surprising' | 'ghost' | 'other' | 'unchecked';

export interface RichFrameLayout {
  /** Cut number label: "C-01", "C-02", ... */
  id: string;
  /** 1-based cut index. */
  index: number;
  /** Priority band matching the panel tabs ("surprising", "ghost", "other"). */
  band: PriorityBand;
  /** Plain-text directional caption: "C-01 · 3 files · 2 ghost wires · strongest 9 of 12 commits (in fileA.ts)". */
  caption: string;
  /** Explicit directional explanation for the lead relationship in this frame. */
  directionalSummary: string;
  /** Basename of the lead edge's source file (whose total commits form the denominator). */
  leadFile: string;
  /** Number of distinct ghost-wire subgroups bridged by non-ghost links inside this component. */
  bridgedSubgroups: number;
  /** True when any ghost or unknown link in this frame has interval.low < 0.3. */
  weak: boolean;
  /** Column span on the 12-column grid (3, 4, 6, or 12). */
  cols: number;
  /** Shelf row index (0-based). */
  row: number;
  /** Frame bounding box in world coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  width: number;
  height: number;
  /** Padded inner insets within the frame where node centers are placed. */
  pad: { top: number; right: number; bottom: number; left: number };
  /** Node indices in `data.nodes` belonging to this component. */
  nodeIndices: number[];
  /** Edge indices in `data.edges` belonging to this component. */
  edgeIndices: number[];
  /** Index into `data.edges` of the highest-priority edge in this component (-1 if isolated). */
  leadEdgeIndex: number;
  /** Count of ghost wires in this component. */
  ghostCount: number;
  /** Highest overviewPriority in this component. */
  overviewPriority: number;
  /** Highest score on the lead edge in this component. */
  score: number;
  /** Shared commit count on the lead edge in this component. */
  shared: number;
}

export interface RichLayoutTiming {
  componentDiscoveryMs: number;
  packingMs: number;
  simulationMs: number;
  totalMs: number;
}

export interface LayoutResult {
  x: number[];
  y: number[];
  style?: StyleMode;
  frames?: RichFrameLayout[];
  sheet?: { w: number; h: number; cols: 12 };
}

export interface LayoutOptions {
  /** Visual style mode ("classic" or "rich"). Defaults to "classic". */
  style?: StyleMode;
  /** Optional visibility override per relationship kind; defaults to the map's initial visibility rules. */
  visible?: Partial<Record<Relationship, boolean>>;
  /** Use `'pairwise'` to run the reference O(N²) pair loop (for equivalence testing). Defaults to `'grid'`. */
  mode?: 'grid' | 'pairwise';
  /** Round final coordinates to 0.1 (defaults to true). Set false for unrounded floating-point equivalence checks. */
  round?: boolean;
  /** Maximum number of simulation ticks (defaults to 400). */
  maxTicks?: number;
}

export interface SimNode {
  i: number;
  dir: string;
  r: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
}

/**
 * Deterministic coincident-node jitter (`d2 < 1`) derived purely from the two node indices `(i, j)`.
 * Independent of loop iteration order and does not consume the stateful PRNG sequence.
 */
export function pairJitter(i: number, j: number): [number, number] {
  const lo = i < j ? i : j;
  const hi = i < j ? j : i;
  let h1 = (Math.imul(lo + 1, 0x9e3779b1) ^ Math.imul(hi + 1, 0x85ebca6b)) | 0;
  h1 = Math.imul(h1 ^ (h1 >>> 15), 1 | h1);
  h1 = (h1 + Math.imul(h1 ^ (h1 >>> 7), 61 | h1)) ^ h1;
  const jx = ((h1 ^ (h1 >>> 14)) >>> 0) / 4294967296 - 0.5;

  let h2 = (h1 + 0x6d2b79f5) | 0;
  h2 = Math.imul(h2 ^ (h2 >>> 15), 1 | h2);
  h2 = (h2 + Math.imul(h2 ^ (h2 >>> 7), 61 | h2)) ^ h2;
  const jy = ((h2 ^ (h2 >>> 14)) >>> 0) / 4294967296 - 0.5;

  return i < j ? [jx, jy] : [-jx, -jy];
}

function applyCoincidentJitter(
  i: number,
  j: number,
  repAlpha: number,
  svx: Float64Array,
  svy: Float64Array,
  origA: number,
  origB: number,
): void {
  const [dx, dy] = pairJitter(origA, origB);
  const fx = dx * repAlpha;
  const fy = dy * repAlpha;
  svx[i] = svx[i]! - fx;
  svy[i] = svy[i]! - fy;
  svx[j] = svx[j]! + fx;
  svy[j] = svy[j]! + fy;
}

export function deriveSeed(repoName: string): number {
  let seed = 7;
  for (let s = 0; s < repoName.length; s++) {
    seed = (seed * 31 + repoName.charCodeAt(s)) | 0;
  }
  return seed;
}

export function createSeededRandom(repoName: string): () => number {
  let seed = deriveSeed(repoName);
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function defaultVisibleKinds(data: MapData): Record<Relationship, boolean> {
  const hasKindInData = (kind: Relationship): boolean => {
    if (data.edges.some((e) => e.relationship === kind)) return true;
    return (data.families ?? []).some((f) => (f.undrawnPairs ?? []).some((up) => up.relationship === kind));
  };
  const hasPrimary = data.edges.some((e) => e.relationship !== 'unknown');
  return {
    ghost: hasKindInData('ghost'),
    unknown: !hasPrimary && hasKindInData('unknown'),
    indirect: hasKindInData('indirect'),
    direct: hasKindInData('direct'),
    test: hasKindInData('test'),
  };
}

export interface GridScratch {
  xOrder: Int32Array;
  cellX: Int32Array;
  cellY: Int32Array;
  nodeCell: Int32Array;
  sortedNode: Int32Array;
  sx: Float64Array;
  sy: Float64Array;
  svx: Float64Array;
  svy: Float64Array;
  sOrig: Int32Array;
  cellCounts: Int32Array;
  cellStarts: Int32Array;
  cellWrite: Int32Array;
  nonEmptyCells: Int32Array;
}

function createGridScratch(nLen: number): GridScratch {
  const xOrder = new Int32Array(nLen);
  for (let i = 0; i < nLen; i++) xOrder[i] = i;
  return {
    xOrder,
    cellX: new Int32Array(nLen),
    cellY: new Int32Array(nLen),
    nodeCell: new Int32Array(nLen),
    sortedNode: new Int32Array(nLen),
    sx: new Float64Array(nLen),
    sy: new Float64Array(nLen),
    svx: new Float64Array(nLen),
    svy: new Float64Array(nLen),
    sOrig: new Int32Array(nLen),
    cellCounts: new Int32Array(1024),
    cellStarts: new Int32Array(1024),
    cellWrite: new Int32Array(1024),
    nonEmptyCells: new Int32Array(1024),
  };
}

function applyRepulsionGridSoA(
  nLen: number,
  ax: Float64Array,
  ay: Float64Array,
  avx: Float64Array,
  avy: Float64Array,
  aOrigIdx: Int32Array,
  alpha: number,
  scratch: GridScratch,
  isFirstTick: boolean,
): void {
  if (nLen <= 1) return;

  const { xOrder, cellX, cellY, nodeCell, sortedNode, sx, sy, svx, svy, sOrig } = scratch;
  if (isFirstTick) {
    for (let i = 0; i < nLen; i++) xOrder[i] = i;
    xOrder.subarray(0, nLen).sort((a, b) => ax[a]! - ax[b]!);
  } else {
    for (let i = 1; i < nLen; i++) {
      const idx = xOrder[i]!;
      const x = ax[idx]!;
      let j = i - 1;
      while (j >= 0 && ax[xOrder[j]!]! > x) {
        xOrder[j + 1] = xOrder[j]!;
        j--;
      }
      xOrder[j + 1] = idx;
    }
  }

  const invCell = 1 / CELL_SIZE;
  let minCx = 0x7fffffff;
  let maxCx = -0x7fffffff;
  let minCy = 0x7fffffff;
  let maxCy = -0x7fffffff;

  for (let i = 0; i < nLen; i++) {
    const cx = Math.floor(ax[i]! * invCell) | 0;
    const cy = Math.floor(ay[i]! * invCell) | 0;
    cellX[i] = cx;
    cellY[i] = cy;
    if (cx < minCx) minCx = cx;
    if (cx > maxCx) maxCx = cx;
    if (cy < minCy) minCy = cy;
    if (cy > maxCy) maxCy = cy;
  }

  const gw = maxCx - minCx + 3;
  const gh = maxCy - minCy + 3;
  const totalCells = gw * gh;
  const repAlpha = REPULSION_STRENGTH * alpha;

  // Pathological spread fallback: X-sorted sweep-and-prune using O(N) memory
  if (totalCells > 65536) {
    for (let k = 0; k < nLen; k++) {
      const idx = xOrder[k]!;
      sortedNode[k] = idx;
      sx[k] = ax[idx]!;
      sy[k] = ay[idx]!;
      svx[k] = 0;
      svy[k] = 0;
      sOrig[k] = aOrigIdx[idx]!;
    }
    for (let i = 0; i < nLen; i++) {
      const xi = sx[i]!;
      const yi = sy[i]!;
      const maxX = xi + CELL_SIZE;
      let vxi = svx[i]!;
      let vyi = svy[i]!;
      for (let j = i + 1; j < nLen; j++) {
        const xj = sx[j]!;
        if (xj > maxX) break;
        const dx = xj - xi;
        const dy = sy[j]! - yi;
        const d2 = dx * dx + dy * dy;
        if (d2 > MAX_DISTANCE_SQ) continue;
        if (d2 < 1) {
          svx[i] = vxi;
          svy[i] = vyi;
          applyCoincidentJitter(i, j, repAlpha, svx, svy, sOrig[i]!, sOrig[j]!);
          vxi = svx[i]!;
          vyi = svy[i]!;
          continue;
        }
        const f = repAlpha / d2;
        const fx = dx * f;
        const fy = dy * f;
        vxi -= fx;
        vyi -= fy;
        svx[j] = svx[j]! + fx;
        svy[j] = svy[j]! + fy;
      }
      svx[i] = vxi;
      svy[i] = vyi;
    }
    for (let pos = 0; pos < nLen; pos++) {
      const idx = sortedNode[pos]!;
      avx[idx] = avx[idx]! + svx[pos]!;
      avy[idx] = avy[idx]! + svy[pos]!;
    }
    return;
  }

  let { cellCounts, cellStarts, cellWrite, nonEmptyCells } = scratch;
  if (cellCounts.length < totalCells + 1) {
    cellCounts = new Int32Array(totalCells + 1);
    cellStarts = new Int32Array(totalCells + 1);
    cellWrite = new Int32Array(totalCells + 1);
    nonEmptyCells = new Int32Array(totalCells + 1);
    scratch.cellCounts = cellCounts;
    scratch.cellStarts = cellStarts;
    scratch.cellWrite = cellWrite;
    scratch.nonEmptyCells = nonEmptyCells;
  } else {
    cellCounts.fill(0, 0, totalCells + 1);
  }

  for (let i = 0; i < nLen; i++) {
    const cIdx = (cellY[i]! - minCy + 1) * gw + (cellX[i]! - minCx + 1);
    nodeCell[i] = cIdx;
    cellCounts[cIdx] = cellCounts[cIdx]! + 1;
  }

  let sum = 0;
  let nonEmptyCount = 0;
  for (let c = 0; c < totalCells; c++) {
    cellStarts[c] = sum;
    cellWrite[c] = sum;
    const cnt = cellCounts[c]!;
    if (cnt > 0) nonEmptyCells[nonEmptyCount++] = c;
    sum += cnt;
  }
  cellStarts[totalCells] = sum;

  // Insert in ascending X order so every 300x300 cell (and contiguous horizontal cell span) is X-sorted
  for (let k = 0; k < nLen; k++) {
    const idx = xOrder[k]!;
    const c = nodeCell[idx]!;
    const pos = cellWrite[c]!;
    cellWrite[c] = pos + 1;
    sortedNode[pos] = idx;
    sx[pos] = ax[idx]!;
    sy[pos] = ay[idx]!;
    svx[pos] = 0;
    svy[pos] = 0;
    sOrig[pos] = aOrigIdx[idx]!;
  }

  for (let ncIdx = 0; ncIdx < nonEmptyCount; ncIdx++) {
    const cIdx = nonEmptyCells[ncIdx]!;
    const startA = cellStarts[cIdx]!;
    const endA = cellStarts[cIdx + 1]!;
    // Contiguous X-sorted span covering (cx, cy) and (cx + 1, cy)
    const endARight = cellStarts[cIdx + 2]!;
    // Contiguous X-sorted span covering (cx - 1, cy + 1), (cx, cy + 1), (cx + 1, cy + 1)
    const startBottom = cellStarts[cIdx + gw - 1]!;
    const endBottom = cellStarts[cIdx + gw + 2]!;
    let jStartBottom = startBottom;

    for (let i = startA; i < endA; i++) {
      const xi = sx[i]!;
      const yi = sy[i]!;
      const maxX = xi + CELL_SIZE;
      let vxi = svx[i]!;
      let vyi = svy[i]!;

      // 1. Same cell (cx, cy) after i + right neighbor cell (cx + 1, cy)
      for (let j = i + 1; j < endARight; j++) {
        const xj = sx[j]!;
        if (xj > maxX) break;
        const dx = xj - xi;
        const dy = sy[j]! - yi;
        const d2 = dx * dx + dy * dy;
        if (d2 > MAX_DISTANCE_SQ) continue;
        if (d2 < 1) {
          svx[i] = vxi;
          svy[i] = vyi;
          applyCoincidentJitter(i, j, repAlpha, svx, svy, sOrig[i]!, sOrig[j]!);
          vxi = svx[i]!;
          vyi = svy[i]!;
          continue;
        }
        const f = repAlpha / d2;
        const fx = dx * f;
        const fy = dy * f;
        vxi -= fx;
        vyi -= fy;
        svx[j] = svx[j]! + fx;
        svy[j] = svy[j]! + fy;
      }

      // 2. Three bottom neighbor cells (cx - 1, cy + 1), (cx, cy + 1), (cx + 1, cy + 1)
      if (jStartBottom < endBottom) {
        const minX = xi - CELL_SIZE;
        while (jStartBottom < endBottom && sx[jStartBottom]! < minX) jStartBottom++;
        for (let j = jStartBottom; j < endBottom; j++) {
          const xj = sx[j]!;
          if (xj > maxX) break;
          const dx = xj - xi;
          const dy = sy[j]! - yi;
          const d2 = dx * dx + dy * dy;
          if (d2 > MAX_DISTANCE_SQ) continue;
          if (d2 < 1) {
            svx[i] = vxi;
            svy[i] = vyi;
            applyCoincidentJitter(i, j, repAlpha, svx, svy, sOrig[i]!, sOrig[j]!);
            vxi = svx[i]!;
            vyi = svy[i]!;
            continue;
          }
          const f = repAlpha / d2;
          const fx = dx * f;
          const fy = dy * f;
          vxi -= fx;
          vyi -= fy;
          svx[j] = svx[j]! + fx;
          svy[j] = svy[j]! + fy;
        }
      }

      svx[i] = vxi;
      svy[i] = vyi;
    }
  }

  for (let pos = 0; pos < nLen; pos++) {
    const idx = sortedNode[pos]!;
    avx[idx] = avx[idx]! + svx[pos]!;
    avy[idx] = avy[idx]! + svy[pos]!;
  }
}

/**
 * Applies pairwise repulsion forces across `activeNodes` using either the 300-unit uniform grid
 * spatial hash (`'grid'`) or the reference O(N²) loop (`'pairwise'`).
 */
export function applyRepulsionForces(
  activeNodes: readonly SimNode[],
  alpha: number,
  mode: 'grid' | 'pairwise',
  scratch?: GridScratch,
): void {
  const nLen = activeNodes.length;
  if (nLen <= 1) return;

  if (mode === 'pairwise') {
    for (let i = 0; i < nLen; i++) {
      const a = activeNodes[i]!;
      for (let j = i + 1; j < nLen; j++) {
        const b = activeNodes[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > MAX_DISTANCE_SQ) continue;
        if (d2 < 1) {
          [dx, dy] = pairJitter(a.i, b.i);
          d2 = 1;
        }
        const f = (REPULSION_STRENGTH * alpha) / d2;
        a.vx -= dx * f;
        a.vy -= dy * f;
        b.vx += dx * f;
        b.vy += dy * f;
      }
    }
    return;
  }

  const ax = new Float64Array(nLen);
  const ay = new Float64Array(nLen);
  const avx = new Float64Array(nLen);
  const avy = new Float64Array(nLen);
  const aOrigIdx = new Int32Array(nLen);
  for (let i = 0; i < nLen; i++) {
    const n = activeNodes[i]!;
    ax[i] = n.x;
    ay[i] = n.y;
    avx[i] = n.vx;
    avy[i] = n.vy;
    aOrigIdx[i] = n.i;
  }

  const sc = scratch && scratch.xOrder.length >= nLen ? scratch : createGridScratch(nLen);
  applyRepulsionGridSoA(nLen, ax, ay, avx, avy, aOrigIdx, alpha, sc, true);

  for (let i = 0; i < nLen; i++) {
    const n = activeNodes[i]!;
    n.vx = avx[i]!;
    n.vy = avy[i]!;
  }
}

/**
 * Pure force-directed layout simulation matching the browser's layout constants and seed derivation.
 */
export function computeLayout(data: MapData, opts?: LayoutOptions): LayoutResult {
  if (opts?.style === 'rich') {
    return computeRichLayout(data, opts);
  }
  const mode = opts?.mode ?? 'grid';
  const shouldRound = opts?.round ?? true;
  const maxTicks = opts?.maxTicks ?? MAX_LAYOUT_TICKS;
  const visible: Record<Relationship, boolean> = {
    ...defaultVisibleKinds(data),
    ...(opts?.visible ?? {}),
  };

  const random = createSeededRandom(data.repoName);
  const totalNodes = data.nodes.length;

  const dirMap = Object.create(null) as Record<string, number>;
  let dirCount = 0;
  const nodeDir = new Int32Array(totalNodes);
  const nodeR = new Float64Array(totalNodes);

  for (let i = 0; i < totalNodes; i++) {
    const n = data.nodes[i]!;
    let dIdx = dirMap[n.dir];
    if (dIdx === undefined) {
      dIdx = dirCount++;
      dirMap[n.dir] = dIdx;
    }
    nodeDir[i] = dIdx;
    nodeR[i] = 4 + Math.min(14, Math.sqrt(n.changes) * 1.25);
  }

  const dirX = new Float64Array(dirCount);
  const dirY = new Float64Array(dirCount);
  const radius = 120 + 40 * Math.sqrt(dirCount);
  const invDirLen = 1 / Math.max(1, dirCount);
  for (let i = 0; i < dirCount; i++) {
    const angle = i * invDirLen * Math.PI * 2;
    dirX[i] = Math.cos(angle) * radius;
    dirY[i] = Math.sin(angle) * radius;
  }

  const nx = new Float64Array(totalNodes);
  const ny = new Float64Array(totalNodes);
  for (let i = 0; i < totalNodes; i++) {
    const dIdx = nodeDir[i]!;
    nx[i] = dirX[dIdx]! + (random() - 0.5) * 80;
    ny[i] = dirY[dIdx]! + (random() - 0.5) * 80;
  }

  const nodeHasVisibleEdge = new Uint8Array(totalNodes);
  const validEdgeIndices: number[] = [];
  for (let i = 0; i < data.edges.length; i++) {
    const e = data.edges[i]!;
    if (e.source < 0 || e.source >= totalNodes || e.target < 0 || e.target >= totalNodes) continue;
    if (visible[e.relationship]) {
      nodeHasVisibleEdge[e.source] = 1;
      nodeHasVisibleEdge[e.target] = 1;
      validEdgeIndices.push(i);
    }
  }

  let activeCount = 0;
  const oldToActive = new Int32Array(totalNodes).fill(-1);
  for (let i = 0; i < totalNodes; i++) {
    if (nodeHasVisibleEdge[i]) {
      oldToActive[i] = activeCount++;
    }
  }

  const ax = new Float64Array(activeCount);
  const ay = new Float64Array(activeCount);
  const avx = new Float64Array(activeCount);
  const avy = new Float64Array(activeCount);
  const aOrigIdx = new Int32Array(activeCount);
  const aDir = new Int32Array(activeCount);
  const aR = new Float64Array(activeCount);

  for (let i = 0; i < totalNodes; i++) {
    const aIdx = oldToActive[i]!;
    if (aIdx !== -1) {
      ax[aIdx] = nx[i]!;
      ay[aIdx] = ny[i]!;
      aOrigIdx[aIdx] = i;
      aDir[aIdx] = nodeDir[i]!;
      aR[aIdx] = nodeR[i]!;
    }
  }

  const eCount = validEdgeIndices.length;
  const eS = new Int32Array(eCount);
  const eT = new Int32Array(eCount);
  const eRest = new Float64Array(eCount);
  const eFactor = new Float64Array(eCount);
  for (let i = 0; i < eCount; i++) {
    const e = data.edges[validEdgeIndices[i]!]!;
    const s = oldToActive[e.source]!;
    const t = oldToActive[e.target]!;
    eS[i] = s;
    eT[i] = t;
    const strength = Math.max(e.confidence, e.reverseConfidence);
    eRest[i] = 50 + (1 - strength) * 90 + aR[s]! + aR[t]!;
    eFactor[i] = SPRING_FACTOR * (0.4 + strength);
  }

  const scratch = createGridScratch(activeCount);
  const dirCx = new Float64Array(dirCount);
  const dirCy = new Float64Array(dirCount);
  const dirCnt = new Int32Array(dirCount);

  let alpha = 1;
  let ticks = 0;
  while (alpha > ALPHA_STOP && ticks < maxTicks) {
    if (mode === 'pairwise') {
      const repAlpha = REPULSION_STRENGTH * alpha;
      for (let i = 0; i < activeCount; i++) {
        const xi = ax[i]!;
        const yi = ay[i]!;
        let vxi = avx[i]!;
        let vyi = avy[i]!;
        for (let j = i + 1; j < activeCount; j++) {
          let dx = ax[j]! - xi;
          let dy = ay[j]! - yi;
          let d2 = dx * dx + dy * dy;
          if (d2 > MAX_DISTANCE_SQ) continue;
          if (d2 < 1) {
            [dx, dy] = pairJitter(aOrigIdx[i]!, aOrigIdx[j]!);
            d2 = 1;
          }
          const f = repAlpha / d2;
          const fx = dx * f;
          const fy = dy * f;
          vxi -= fx;
          vyi -= fy;
          avx[j] = avx[j]! + fx;
          avy[j] = avy[j]! + fy;
        }
        avx[i] = vxi;
        avy[i] = vyi;
      }
    } else {
      applyRepulsionGridSoA(activeCount, ax, ay, avx, avy, aOrigIdx, alpha, scratch, ticks === 0);
    }

    for (let i = 0; i < eCount; i++) {
      const s = eS[i]!;
      const t = eT[i]!;
      const dx = ax[t]! - ax[s]!;
      const dy = ay[t]! - ay[s]!;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - eRest[i]!) / d) * eFactor[i]! * alpha;
      const fx = dx * f;
      const fy = dy * f;
      avx[s] = avx[s]! + fx;
      avy[s] = avy[s]! + fy;
      avx[t] = avx[t]! - fx;
      avy[t] = avy[t]! - fy;
    }

    dirCx.fill(0);
    dirCy.fill(0);
    dirCnt.fill(0);
    for (let i = 0; i < activeCount; i++) {
      const d = aDir[i]!;
      dirCx[d] = dirCx[d]! + ax[i]!;
      dirCy[d] = dirCy[d]! + ay[i]!;
      dirCnt[d] = dirCnt[d]! + 1;
    }
    const pullAlpha = DIR_PULL * alpha;
    for (let i = 0; i < activeCount; i++) {
      const d = aDir[i]!;
      const cnt = dirCnt[d]!;
      const x = ax[i]!;
      const y = ay[i]!;
      const vx = (avx[i]! + (dirCx[d]! / cnt - x) * pullAlpha - x * pullAlpha) * DAMPING;
      const vy = (avy[i]! + (dirCy[d]! / cnt - y) * pullAlpha - y * pullAlpha) * DAMPING;
      avx[i] = vx;
      avy[i] = vy;
      ax[i] = x + vx;
      ay[i] = y + vy;
    }

    alpha *= ALPHA_DECAY;
    ticks++;
  }

  for (let i = 0; i < activeCount; i++) {
    const orig = aOrigIdx[i]!;
    nx[orig] = ax[i]!;
    ny[orig] = ay[i]!;
  }

  const roundCoord = (v: number): number => {
    const r = Math.round(v * 10) / 10;
    return Object.is(r, -0) ? 0 : r;
  };

  const outX = new Array<number>(totalNodes);
  const outY = new Array<number>(totalNodes);
  for (let i = 0; i < totalNodes; i++) {
    outX[i] = shouldRound ? roundCoord(nx[i]!) : nx[i]!;
    outY[i] = shouldRound ? roundCoord(ny[i]!) : ny[i]!;
  }

  return { x: outX, y: outY };
}

function simulateComponentSubgraph(
  data: MapData,
  nodeIndices: readonly number[],
  edgeIndices: readonly number[],
  random: () => number,
  mode: 'grid' | 'pairwise',
  maxTicks: number,
): { x: Float64Array; y: Float64Array } {
  const nLen = nodeIndices.length;
  const ax = new Float64Array(nLen);
  const ay = new Float64Array(nLen);
  const avx = new Float64Array(nLen);
  const avy = new Float64Array(nLen);
  const aOrigIdx = new Int32Array(nLen);
  const aDir = new Int32Array(nLen);
  const aR = new Float64Array(nLen);

  const localIndexByGlobal = new Map<number, number>();
  const dirMap = Object.create(null) as Record<string, number>;
  let dirCount = 0;

  for (let i = 0; i < nLen; i++) {
    const globalIdx = nodeIndices[i]!;
    localIndexByGlobal.set(globalIdx, i);
    const n = data.nodes[globalIdx]!;
    let dIdx = dirMap[n.dir];
    if (dIdx === undefined) {
      dIdx = dirCount++;
      dirMap[n.dir] = dIdx;
    }
    aOrigIdx[i] = globalIdx;
    aDir[i] = dIdx;
    aR[i] = 4 + Math.min(14, Math.sqrt(n.changes) * 1.25);
  }

  const radius = 60 + 28 * Math.sqrt(dirCount);
  const invDirLen = 1 / Math.max(1, dirCount);
  const dirX = new Float64Array(dirCount);
  const dirY = new Float64Array(dirCount);
  for (let i = 0; i < dirCount; i++) {
    const angle = i * invDirLen * Math.PI * 2;
    dirX[i] = Math.cos(angle) * radius;
    dirY[i] = Math.sin(angle) * radius;
  }

  for (let i = 0; i < nLen; i++) {
    const dIdx = aDir[i]!;
    ax[i] = dirX[dIdx]! + (random() - 0.5) * 60;
    ay[i] = dirY[dIdx]! + (random() - 0.5) * 60;
  }

  const eCount = edgeIndices.length;
  const eS = new Int32Array(eCount);
  const eT = new Int32Array(eCount);
  const eRest = new Float64Array(eCount);
  const eFactor = new Float64Array(eCount);
  for (let i = 0; i < eCount; i++) {
    const e: MapEdge = data.edges[edgeIndices[i]!]!;
    const s = localIndexByGlobal.get(e.source) ?? 0;
    const t = localIndexByGlobal.get(e.target) ?? 0;
    eS[i] = s;
    eT[i] = t;
    const strength = Math.max(e.confidence, e.reverseConfidence);
    eRest[i] = 50 + (1 - strength) * 90 + aR[s]! + aR[t]!;
    eFactor[i] = SPRING_FACTOR * (0.4 + strength);
  }

  const scratch = createGridScratch(nLen);
  const dirCx = new Float64Array(dirCount);
  const dirCy = new Float64Array(dirCount);
  const dirCnt = new Int32Array(dirCount);

  let alpha = 1;
  let ticks = 0;
  while (alpha > ALPHA_STOP && ticks < maxTicks) {
    if (mode === 'pairwise') {
      const repAlpha = REPULSION_STRENGTH * alpha;
      for (let i = 0; i < nLen; i++) {
        const xi = ax[i]!;
        const yi = ay[i]!;
        let vxi = avx[i]!;
        let vyi = avy[i]!;
        for (let j = i + 1; j < nLen; j++) {
          let dx = ax[j]! - xi;
          let dy = ay[j]! - yi;
          let d2 = dx * dx + dy * dy;
          if (d2 > MAX_DISTANCE_SQ) continue;
          if (d2 < 1) {
            [dx, dy] = pairJitter(aOrigIdx[i]!, aOrigIdx[j]!);
            d2 = 1;
          }
          const f = repAlpha / d2;
          const fx = dx * f;
          const fy = dy * f;
          vxi -= fx;
          vyi -= fy;
          avx[j] = avx[j]! + fx;
          avy[j] = avy[j]! + fy;
        }
        avx[i] = vxi;
        avy[i] = vyi;
      }
    } else {
      applyRepulsionGridSoA(nLen, ax, ay, avx, avy, aOrigIdx, alpha, scratch, ticks === 0);
    }

    for (let i = 0; i < eCount; i++) {
      const s = eS[i]!;
      const t = eT[i]!;
      const dx = ax[t]! - ax[s]!;
      const dy = ay[t]! - ay[s]!;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - eRest[i]!) / d) * eFactor[i]! * alpha;
      const fx = dx * f;
      const fy = dy * f;
      avx[s] = avx[s]! + fx;
      avy[s] = avy[s]! + fy;
      avx[t] = avx[t]! - fx;
      avy[t] = avy[t]! - fy;
    }

    dirCx.fill(0);
    dirCy.fill(0);
    dirCnt.fill(0);
    for (let i = 0; i < nLen; i++) {
      const d = aDir[i]!;
      dirCx[d] = dirCx[d]! + ax[i]!;
      dirCy[d] = dirCy[d]! + ay[i]!;
      dirCnt[d] = dirCnt[d]! + 1;
    }
    const pullAlpha = DIR_PULL * alpha;
    for (let i = 0; i < nLen; i++) {
      const d = aDir[i]!;
      const cnt = dirCnt[d]!;
      const x = ax[i]!;
      const y = ay[i]!;
      const vx = (avx[i]! + (dirCx[d]! / cnt - x) * pullAlpha - x * pullAlpha) * DAMPING;
      const vy = (avy[i]! + (dirCy[d]! / cnt - y) * pullAlpha - y * pullAlpha) * DAMPING;
      avx[i] = vx;
      avy[i] = vy;
      ax[i] = x + vx;
      ay[i] = y + vy;
    }

    alpha *= ALPHA_DECAY;
    ticks++;
  }

  return { x: ax, y: ay };
}

function fileBasename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx < 0 ? p : p.slice(idx + 1);
}

function countGhostSubgroups(data: MapData, edgeIndices: readonly number[]): number {
  const ghostAdj = new Map<number, number[]>();
  for (let i = 0; i < edgeIndices.length; i++) {
    const e = data.edges[edgeIndices[i]!]!;
    if (e.relationship !== 'ghost') continue;
    let listS = ghostAdj.get(e.source);
    if (!listS) {
      listS = [];
      ghostAdj.set(e.source, listS);
    }
    listS.push(e.target);
    let listT = ghostAdj.get(e.target);
    if (!listT) {
      listT = [];
      ghostAdj.set(e.target, listT);
    }
    listT.push(e.source);
  }
  if (ghostAdj.size === 0) return 0;
  const seen = new Set<number>();
  let subgroups = 0;
  for (const startNode of ghostAdj.keys()) {
    if (seen.has(startNode)) continue;
    subgroups++;
    seen.add(startNode);
    const q = [startNode];
    for (let qi = 0; qi < q.length; qi++) {
      const u = q[qi]!;
      const nbrs = ghostAdj.get(u) ?? [];
      for (let k = 0; k < nbrs.length; k++) {
        const v = nbrs[k]!;
        if (!seen.has(v)) {
          seen.add(v);
          q.push(v);
        }
      }
    }
  }
  return subgroups;
}

/**
 * Contact-sheet layout (`--style rich`):
 * - Finds connected components over all edges in `data.edges`.
 * - Orders components by highest `overviewPriority`, then `score`, then `shared`; components whose
 *   links are all hidden by default (unchecked-only) sort last in their own band.
 * - Labels frames `C-01`, `C-02`... with plain-text directional captions and `weak` markers.
 * - Runs RA-15's simulation inside each frame (`> 40` nodes gets full 12-column sheet width).
 * - Shelf-packs frames on a 12-column grid with exact FRAME/12 gutters (`12` horizontal,
 *   `20` vertical between rows, `32` vertical before the first frame of a lower priority band).
 */
export function computeRichLayout(data: MapData, opts?: LayoutOptions): LayoutResult {
  return computeRichLayoutWithTiming(data, opts).layout;
}

export function computeRichLayoutWithTiming(
  data: MapData,
  opts?: LayoutOptions,
): { layout: LayoutResult; timing: RichLayoutTiming } {
  const tStart = performance.now();
  const mode = opts?.mode ?? 'grid';
  const shouldRound = opts?.round ?? true;
  const maxTicks = opts?.maxTicks ?? MAX_LAYOUT_TICKS;
  const totalNodes = data.nodes.length;
  const totalEdges = data.edges.length;
  const sheetWidth = RICH_GRID_COLS * RICH_COL_WIDTH + (RICH_GRID_COLS - 1) * FRAME12.gutterPx.pair;

  const roundCoord = (v: number): number => {
    const r = Math.round(v * 10) / 10;
    return Object.is(r, -0) ? 0 : r;
  };

  const outX = new Array<number>(totalNodes).fill(0);
  const outY = new Array<number>(totalNodes).fill(0);

  if (totalNodes === 0 || totalEdges === 0) {
    const totalMs = performance.now() - tStart;
    return {
      layout: {
        x: outX,
        y: outY,
        style: 'rich',
        frames: [],
        sheet: { w: sheetWidth, h: 0, cols: RICH_GRID_COLS },
      },
      timing: {
        componentDiscoveryMs: totalMs,
        packingMs: 0,
        simulationMs: 0,
        totalMs,
      },
    };
  }

  // Build undirected adjacency over ALL edges in `data.edges`
  const adjNodes: number[][] = Array.from({ length: totalNodes }, () => []);
  const adjEdges: number[][] = Array.from({ length: totalNodes }, () => []);
  const touched = new Uint8Array(totalNodes);

  for (let ei = 0; ei < totalEdges; ei++) {
    const e = data.edges[ei]!;
    if (e.source < 0 || e.source >= totalNodes || e.target < 0 || e.target >= totalNodes) continue;
    adjNodes[e.source]!.push(e.target);
    adjNodes[e.target]!.push(e.source);
    adjEdges[e.source]!.push(ei);
    adjEdges[e.target]!.push(ei);
    touched[e.source] = 1;
    touched[e.target] = 1;
  }

  interface RawComponent {
    nodeIndices: number[];
    edgeIndices: number[];
    leadEdgeIndex: number;
    ghostCount: number;
    bridgedSubgroups: number;
    overviewPriority: number;
    score: number;
    shared: number;
    band: PriorityBand;
    bandRank: number;
    weak: boolean;
    cols: number;
    baseH: number;
  }

  const visited = new Uint8Array(totalNodes);
  const rawComponents: RawComponent[] = [];
  // Mirrors the map client's default filter: unchecked links start hidden when any other kind exists
  const uncheckedHiddenByDefault = data.edges.some((e) => e.relationship !== 'unknown');

  for (let start = 0; start < totalNodes; start++) {
    if (!touched[start] || visited[start]) continue;
    visited[start] = 1;
    const queue: number[] = [start];
    const edgeSet = new Set<number>();

    for (let q = 0; q < queue.length; q++) {
      const u = queue[q]!;
      const neighbors = adjNodes[u]!;
      const incEdges = adjEdges[u]!;
      for (let k = 0; k < incEdges.length; k++) {
        edgeSet.add(incEdges[k]!);
      }
      for (let k = 0; k < neighbors.length; k++) {
        const v = neighbors[k]!;
        if (!visited[v]) {
          visited[v] = 1;
          queue.push(v);
        }
      }
    }

    const nodeIndices = queue.sort((a, b) => a - b);
    const edgeIndices = Array.from(edgeSet).sort((a, b) => a - b);
    if (edgeIndices.length === 0) continue;

    let ghostCount = 0;
    for (let k = 0; k < edgeIndices.length; k++) {
      const e = data.edges[edgeIndices[k]!]!;
      if (e.relationship === 'ghost') ghostCount++;
    }
    const bridgedSubgroups = countGhostSubgroups(data, edgeIndices);

    const rankedEdges = [...edgeIndices].sort((eiA, eiB) => {
      const a = data.edges[eiA]!;
      const b = data.edges[eiB]!;
      const aGhost = a.relationship === 'ghost' ? 1 : 0;
      const bGhost = b.relationship === 'ghost' ? 1 : 0;
      return (
        b.overviewPriority - a.overviewPriority ||
        bGhost - aGhost ||
        b.score - a.score ||
        b.shared - a.shared ||
        eiA - eiB
      );
    });

    const leadEdgeIndex = rankedEdges[0]!;
    const leadEdge = data.edges[leadEdgeIndex]!;
    const weak =
      (leadEdge.relationship === 'ghost' || leadEdge.relationship === 'unknown') &&
      leadEdge.interval.low < WEAK_INTERVAL_THRESHOLD;
    const overviewPriority = leadEdge.overviewPriority;
    const score = leadEdge.score;
    const shared = leadEdge.shared;

    let band: PriorityBand;
    let bandRank: number;
    const onlyUnchecked =
      uncheckedHiddenByDefault && edgeIndices.every((ei) => data.edges[ei]!.relationship === 'unknown');
    if (onlyUnchecked) {
      band = 'unchecked';
      bandRank = -1;
    } else if (overviewPriority >= 2) {
      band = 'surprising';
      bandRank = 2;
    } else if (overviewPriority >= 1 || ghostCount > 0) {
      band = 'ghost';
      bandRank = 1;
    } else {
      band = 'other';
      bandRank = 0;
    }

    const nCount = nodeIndices.length;
    let cols: number;
    let baseH: number;
    if (nCount > 40) {
      cols = 12;
      baseH = 440;
    } else if (nCount >= 10) {
      cols = 6;
      baseH = 300;
    } else if (nCount >= 4) {
      cols = 4;
      baseH = 240;
    } else if (nCount === 3) {
      cols = 4;
      baseH = 210;
    } else {
      cols = 3;
      baseH = 190;
    }

    rawComponents.push({
      nodeIndices,
      edgeIndices,
      leadEdgeIndex,
      ghostCount,
      bridgedSubgroups,
      overviewPriority,
      score,
      shared,
      band,
      bandRank,
      weak,
      cols,
      baseH,
    });
  }

  // Order components by priority band / highest overviewPriority, then score, then shared
  rawComponents.sort(
    (a, b) =>
      b.bandRank - a.bandRank ||
      b.overviewPriority - a.overviewPriority ||
      b.score - a.score ||
      b.shared - a.shared ||
      a.leadEdgeIndex - b.leadEdgeIndex,
  );
  const tAfterDiscovery = performance.now();

  // Shelf-pack frames onto a 12-column grid using only FRAME/12 gutters (12, 20, 32)
  const gutterPair = FRAME12.gutterPx.pair; // 12
  const gutterScene = FRAME12.gutterPx.scene; // 20
  const gutterChange = FRAME12.gutterPx.change; // 32

  interface PackedRow {
    rowIndex: number;
    band: PriorityBand;
    y: number;
    h: number;
    usedCols: number;
    nextX: number;
    frames: RichFrameLayout[];
  }

  const rows: PackedRow[] = [];
  const frames: RichFrameLayout[] = [];

  for (let idx = 0; idx < rawComponents.length; idx++) {
    const comp = rawComponents[idx]!;
    const cutIndex = idx + 1;
    const cutId = `C-${String(cutIndex).padStart(2, '0')}`;
    const leadEdge = data.edges[comp.leadEdgeIndex]!;
    const leadSourceNode = data.nodes[leadEdge.source];
    const leadFile = leadSourceNode ? fileBasename(leadSourceNode.path) : `file-${leadEdge.source}`;
    const fileLabel = `${comp.nodeIndices.length} ${comp.nodeIndices.length === 1 ? 'file' : 'files'}`;
    const ghostLabel = `${comp.ghostCount} ${comp.ghostCount === 1 ? 'ghost wire' : 'ghost wires'}`;
    const strongestLabel = `strongest ${leadEdge.shared} of ${leadEdge.fromChanges} commits (in ${leadFile})`;
    const caption = `${cutId} · ${fileLabel} · ${ghostLabel} · ${strongestLabel}${comp.weak ? ' · weak' : ''}`;
    const directionalSummary = `These files changed together in ${leadEdge.shared} of the ${leadEdge.fromChanges} analyzed changes to ${leadFile}`;

    const frameW = comp.cols * RICH_COL_WIDTH + (comp.cols - 1) * gutterPair;

    let currentRow = rows[rows.length - 1];
    const bandChanged = currentRow !== undefined && currentRow.band !== comp.band;
    const rowFull = currentRow !== undefined && currentRow.usedCols + comp.cols > RICH_GRID_COLS;

    if (!currentRow || bandChanged || rowFull) {
      const verticalGap = !currentRow ? 0 : bandChanged ? gutterChange : gutterScene;
      const rowY = !currentRow ? 0 : currentRow.y + currentRow.h + verticalGap;
      currentRow = {
        rowIndex: rows.length,
        band: comp.band,
        y: rowY,
        h: comp.baseH,
        usedCols: 0,
        nextX: 0,
        frames: [],
      };
      rows.push(currentRow);
    }

    const frameX = currentRow.nextX;
    currentRow.nextX += frameW + gutterPair;
    currentRow.usedCols += comp.cols;
    if (comp.baseH > currentRow.h) {
      currentRow.h = comp.baseH;
    }

    const frame: RichFrameLayout = {
      id: cutId,
      index: cutIndex,
      band: comp.band,
      caption,
      directionalSummary,
      leadFile,
      bridgedSubgroups: comp.bridgedSubgroups,
      weak: comp.weak,
      cols: comp.cols,
      row: currentRow.rowIndex,
      x: frameX,
      y: currentRow.y,
      w: frameW,
      h: currentRow.h,
      width: frameW,
      height: currentRow.h,
      pad: {
        top: RICH_FRAME_PAD_TOP,
        right: RICH_FRAME_PAD_X,
        bottom: RICH_FRAME_PAD_X,
        left: RICH_FRAME_PAD_X,
      },
      nodeIndices: comp.nodeIndices,
      edgeIndices: comp.edgeIndices,
      leadEdgeIndex: comp.leadEdgeIndex,
      ghostCount: comp.ghostCount,
      overviewPriority: comp.overviewPriority,
      score: comp.score,
      shared: comp.shared,
    };

    currentRow.frames.push(frame);
    frames.push(frame);
  }

  // Finalize row heights and vertical positions so all frames in a row share exact height
  let cursorY = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    if (r > 0) {
      const prevRow = rows[r - 1]!;
      const vGap = row.band !== prevRow.band ? gutterChange : gutterScene;
      cursorY = prevRow.y + prevRow.h + vGap;
    }
    row.y = cursorY;
    for (const f of row.frames) {
      f.y = row.y;
      f.h = row.h;
      f.height = row.h;
    }
  }

  const lastRow = rows[rows.length - 1];
  const sheetHeight = lastRow ? lastRow.y + lastRow.h : 0;
  const tAfterPacking = performance.now();

  // Run RA-15 force simulation per component and normalize into each frame's padded bounds
  const random = createSeededRandom(data.repoName);
  for (const frame of frames) {
    const { nodeIndices, edgeIndices } = frame;
    const nLen = nodeIndices.length;
    const sim = simulateComponentSubgraph(data, nodeIndices, edgeIndices, random, mode, maxTicks);

    const innerLeft = frame.x + frame.pad.left;
    const innerRight = frame.x + frame.w - frame.pad.right;
    const innerTop = frame.y + frame.pad.top;
    const innerBottom = frame.y + frame.h - frame.pad.bottom;

    // Keep an interior margin inside the padded box so node radii stay well inside the padded bounds
    const marginX = Math.min(18, Math.max(4, (innerRight - innerLeft) * 0.12));
    const marginY = Math.min(18, Math.max(4, (innerBottom - innerTop) * 0.12));
    const boxLeft = innerLeft + marginX;
    const boxRight = innerRight - marginX;
    const boxTop = innerTop + marginY;
    const boxBottom = innerBottom - marginY;
    const boxW = Math.max(1, boxRight - boxLeft);
    const boxH = Math.max(1, boxBottom - boxTop);

    if (nLen === 1) {
      const idx = nodeIndices[0]!;
      const cx = (boxLeft + boxRight) / 2;
      const cy = (boxTop + boxBottom) / 2;
      outX[idx] = shouldRound ? roundCoord(cx) : cx;
      outY[idx] = shouldRound ? roundCoord(cy) : cy;
      continue;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < nLen; i++) {
      const sx = sim.x[i]!;
      const sy = sim.y[i]!;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }

    const spanX = maxX - minX;
    const spanY = maxY - minY;

    for (let i = 0; i < nLen; i++) {
      const globalIdx = nodeIndices[i]!;
      const normX = spanX > 1e-6 ? (sim.x[i]! - minX) / spanX : 0.5;
      const normY = spanY > 1e-6 ? (sim.y[i]! - minY) / spanY : 0.5;
      let px = boxLeft + normX * boxW;
      let py = boxTop + normY * boxH;
      if (shouldRound) {
        px = roundCoord(px);
        py = roundCoord(py);
      }
      // Guarantee strict inclusion within padded frame bounds
      px = Math.max(innerLeft, Math.min(innerRight, px));
      py = Math.max(innerTop, Math.min(innerBottom, py));
      outX[globalIdx] = px;
      outY[globalIdx] = py;
    }
  }
  const tEnd = performance.now();

  return {
    layout: {
      x: outX,
      y: outY,
      style: 'rich',
      frames,
      sheet: { w: sheetWidth, h: sheetHeight, cols: RICH_GRID_COLS },
    },
    timing: {
      componentDiscoveryMs: tAfterDiscovery - tStart,
      packingMs: tAfterPacking - tAfterDiscovery,
      simulationMs: tEnd - tAfterPacking,
      totalMs: tEnd - tStart,
    },
  };
}
