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
  cellX: Int32Array;
  cellY: Int32Array;
  nextInCell: Int32Array;
  cellHeads: Int32Array;
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

  const cellX = scratch && scratch.cellX.length >= nLen ? scratch.cellX : new Int32Array(nLen);
  const cellY = scratch && scratch.cellY.length >= nLen ? scratch.cellY : new Int32Array(nLen);
  const nextInCell =
    scratch && scratch.nextInCell.length >= nLen ? scratch.nextInCell : new Int32Array(nLen);

  let minCx = 0x7fffffff;
  let maxCx = -0x7fffffff;
  let minCy = 0x7fffffff;
  let maxCy = -0x7fffffff;

  for (let idx = 0; idx < nLen; idx++) {
    const n = activeNodes[idx]!;
    const cx = Math.floor(n.x / CELL_SIZE) | 0;
    const cy = Math.floor(n.y / CELL_SIZE) | 0;
    cellX[idx] = cx;
    cellY[idx] = cy;
    if (cx < minCx) minCx = cx;
    if (cx > maxCx) maxCx = cx;
    if (cy < minCy) minCy = cy;
    if (cy > maxCy) maxCy = cy;
  }

  // Pad by 1 cell on all sides so neighbor offsets never go out of bounds.
  const gw = maxCx - minCx + 3;
  const gh = maxCy - minCy + 3;
  const totalCells = gw * gh;

  // Fall back to Map if nodes are pathologically spread out (> 65k grid cells)
  if (totalCells > 65536) {
    const mapHeads = new Map<number, number>();
    for (let idx = nLen - 1; idx >= 0; idx--) {
      const key = ((cellX[idx]! & 0xffff) << 16) | (cellY[idx]! & 0xffff);
      const prev = mapHeads.get(key);
      nextInCell[idx] = prev === undefined ? -1 : prev;
      mapHeads.set(key, idx);
    }
    for (let idx = 0; idx < nLen; idx++) {
      const a = activeNodes[idx]!;
      const cx = cellX[idx]!;
      const cy = cellY[idx]!;
      for (let ox = -1; ox <= 1; ox++) {
        const ncx = (cx + ox) & 0xffff;
        for (let oy = -1; oy <= 1; oy++) {
          const nKey = (ncx << 16) | ((cy + oy) & 0xffff);
          for (let j = mapHeads.get(nKey) ?? -1; j !== -1; j = nextInCell[j]!) {
            if (j <= idx) continue;
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
      }
    }
    return;
  }

  let cellHeads: Int32Array;
  if (scratch && scratch.cellHeads.length >= totalCells) {
    cellHeads = scratch.cellHeads;
    cellHeads.fill(-1, 0, totalCells);
  } else {
    cellHeads = new Int32Array(totalCells);
    cellHeads.fill(-1);
    if (scratch) scratch.cellHeads = cellHeads;
  }

  for (let idx = nLen - 1; idx >= 0; idx--) {
    const cIdx = (cellY[idx]! - minCy + 1) * gw + (cellX[idx]! - minCx + 1);
    nextInCell[idx] = cellHeads[cIdx]!;
    cellHeads[cIdx] = idx;
  }

  const neighborOffsets = [1, gw - 1, gw, gw + 1];
  const maxRow = gh - 1;
  const maxCol = gw - 1;

  for (let row = 1; row < maxRow; row++) {
    const rowBase = row * gw;
    for (let col = 1; col < maxCol; col++) {
      const cIdx = rowBase + col;
      const head = cellHeads[cIdx]!;
      if (head === -1) continue;

      // 1. Pairs within the same cell
      for (let i = head; i !== -1; i = nextInCell[i]!) {
        const a = activeNodes[i]!;
        for (let j = nextInCell[i]!; j !== -1; j = nextInCell[j]!) {
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

      // 2. Pairs between this cell and the 4 forward neighbor cells
      for (let k = 0; k < 4; k++) {
        const nHead = cellHeads[cIdx + neighborOffsets[k]!]!;
        if (nHead === -1) continue;
        for (let i = head; i !== -1; i = nextInCell[i]!) {
          const n1 = activeNodes[i]!;
          for (let j = nHead; j !== -1; j = nextInCell[j]!) {
            const n2 = activeNodes[j]!;
            const a = n1.i < n2.i ? n1 : n2;
            const b = n1.i < n2.i ? n2 : n1;
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
      }
    }
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

  interface DirCenter {
    name: string;
    x: number;
    y: number;
    cx: number;
    cy: number;
    count: number;
  }

  const dirs = Object.create(null) as Record<string, DirCenter>;
  const dirList: DirCenter[] = [];

  interface InternalEdge {
    s: InternalNode;
    t: InternalNode;
    relationship: Relationship;
    confidence: number;
    reverseConfidence: number;
  }

  interface InternalNode extends SimNode {
    edges: InternalEdge[];
  }

  const nodes: InternalNode[] = data.nodes.map((n, i) => {
    if (!dirs[n.dir]) {
      dirs[n.dir] = { name: n.dir, x: 0, y: 0, cx: 0, cy: 0, count: 0 };
      dirList.push(dirs[n.dir]!);
    }
    return {
      i,
      dir: n.dir,
      r: 4 + Math.min(14, Math.sqrt(n.changes) * 1.25),
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      pinned: false,
      edges: [],
    };
  });

  const edges: InternalEdge[] = [];
  for (const e of data.edges) {
    const s = nodes[e.source];
    const t = nodes[e.target];
    if (!s || !t) continue;
    const edge: InternalEdge = {
      s,
      t,
      relationship: e.relationship,
      confidence: e.confidence,
      reverseConfidence: e.reverseConfidence,
    };
    s.edges.push(edge);
    t.edges.push(edge);
    edges.push(edge);
  }

  dirList.forEach((d, i) => {
    const angle = (i / Math.max(1, dirList.length)) * Math.PI * 2;
    const radius = 120 + 40 * Math.sqrt(dirList.length);
    d.x = Math.cos(angle) * radius;
    d.y = Math.sin(angle) * radius;
  });

  nodes.forEach((n) => {
    const d = dirs[n.dir]!;
    n.x = d.x + (random() - 0.5) * 80;
    n.y = d.y + (random() - 0.5) * 80;
  });

  const isVisible = (e: InternalEdge): boolean => Boolean(visible[e.relationship]);
  const isActive = (n: InternalNode): boolean => n.edges.some(isVisible);

  const activeNodes = nodes.filter(isActive);
  for (const n of nodes) {
    if (!isActive(n)) {
      n.vx = 0;
      n.vy = 0;
    }
  }
  const visibleEdges = edges.filter(isVisible);

  const scratch: GridScratch = {
    cellX: new Int32Array(activeNodes.length),
    cellY: new Int32Array(activeNodes.length),
    nextInCell: new Int32Array(activeNodes.length),
    cellHeads: new Int32Array(1024),
  };

  let alpha = 1;
  let ticks = 0;
  while (alpha > ALPHA_STOP && ticks < maxTicks) {
    applyRepulsionForces(activeNodes, alpha, mode, scratch);

    for (let i = 0; i < visibleEdges.length; i++) {
      const e = visibleEdges[i]!;
      const dx = e.t.x - e.s.x;
      const dy = e.t.y - e.s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const strength = Math.max(e.confidence, e.reverseConfidence);
      const rest = 50 + (1 - strength) * 90 + e.s.r + e.t.r;
      const f = ((d - rest) / d) * SPRING_FACTOR * alpha * (0.4 + strength);
      e.s.vx += dx * f;
      e.s.vy += dy * f;
      e.t.vx -= dx * f;
      e.t.vy -= dy * f;
    }

    for (let i = 0; i < dirList.length; i++) {
      const d = dirList[i]!;
      d.cx = 0;
      d.cy = 0;
      d.count = 0;
    }
    for (let i = 0; i < activeNodes.length; i++) {
      const n = activeNodes[i]!;
      const d = dirs[n.dir]!;
      d.cx += n.x;
      d.cy += n.y;
      d.count++;
    }
    for (let i = 0; i < activeNodes.length; i++) {
      const n = activeNodes[i]!;
      const d = dirs[n.dir]!;
      n.vx += (d.cx / d.count - n.x) * DIR_PULL * alpha - n.x * DIR_PULL * alpha;
      n.vy += (d.cy / d.count - n.y) * DIR_PULL * alpha - n.y * DIR_PULL * alpha;
      if (n.pinned) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      n.x += n.vx;
      n.y += n.vy;
    }

    alpha *= ALPHA_DECAY;
    ticks++;
  }

  const roundCoord = (v: number): number => {
    const r = Math.round(v * 10) / 10;
    return Object.is(r, -0) ? 0 : r;
  };

  return {
    x: nodes.map((n) => (shouldRound ? roundCoord(n.x) : n.x)),
    y: nodes.map((n) => (shouldRound ? roundCoord(n.y) : n.y)),
  };
}
