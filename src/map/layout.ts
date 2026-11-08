import type { MapData } from '../commands/map.js';
import type { Relationship } from '../imports/classify.js';

export const CELL_SIZE = 300;
export const MAX_DISTANCE_SQ = 90000; // 300 * 300
export const REPULSION_STRENGTH = 1400;
export const SPRING_FACTOR = 0.05;
export const DIR_PULL = 0.012;
export const DAMPING = 0.62;
export const ALPHA_DECAY = 0.985;
export const ALPHA_STOP = 0.02;
export const MAX_LAYOUT_TICKS = 400;

export interface LayoutResult {
  x: number[];
  y: number[];
}

export interface LayoutOptions {
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
