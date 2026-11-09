import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatExplainCommand } from '../commands/explain.js';
import type { MapData } from '../commands/map.js';
import type { Relationship } from '../imports/classify.js';
import {
  GLOSSARY_TERMS,
  buildAnalysisProvenance,
  getGlossaryEntry,
  type AnalysisProvenance,
} from '../report/glossary.js';
import { sanitizeHtmlDisplayText, type StyleMode } from '../style/frame12.js';
import {
  KICKER_MOST_INTERESTING,
  buildRankedFindings,
  computeFeaturedPlateLayout,
  formatBalloonCallout,
  formatCounterexamplesLine,
  formatDirectionMetric,
  formatEmptyStateCopy,
  formatEvidencePanelCopy,
  formatFindingHash,
  resolveStrongerDirection,
  selectFeaturedFinding,
  type EmptyStateCopy,
  type EvidencePanelCopy,
  type FeaturedFinding,
  type FeaturedPlateLayout,
  type RankedFindingItem,
} from './copy.js';
import { computeLayout, computeRichLayout, type LayoutResult } from './layout.js';

let cachedEmbeddedFontCss: string | null = null;

function getEmbeddedFontsCss(): string {
  if (cachedEmbeddedFontCss !== null) return cachedEmbeddedFontCss;
  try {
    const fontsDir = fileURLToPath(new URL('../../assets/fonts', import.meta.url));
    const dela400 = readFileSync(join(fontsDir, 'dela-gothic-one-400.woff2')).toString('base64');
    const mplus500 = readFileSync(join(fontsDir, 'm-plus-1-code-500.woff2')).toString('base64');
    const mplus700 = readFileSync(join(fontsDir, 'm-plus-1-code-700.woff2')).toString('base64');
    const oflHeader = readFileSync(join(fontsDir, 'OFL.txt'), 'utf8')
      .split(/\r?\n/)
      .slice(0, 14)
      .join('\n');
    cachedEmbeddedFontCss = `/*\n${oflHeader}\n*/\n@font-face{font-family:"Dela Gothic One";font-style:normal;font-weight:400 900;font-display:swap;src:url("data:font/woff2;base64,${dela400}") format("woff2");}\n@font-face{font-family:"M PLUS 1 Code";font-style:normal;font-weight:500;font-display:swap;src:url("data:font/woff2;base64,${mplus500}") format("woff2");}\n@font-face{font-family:"M PLUS 1 Code";font-style:normal;font-weight:700 800;font-display:swap;src:url("data:font/woff2;base64,${mplus700}") format("woff2");}\n`;
  } catch {
    cachedEmbeddedFontCss = '';
  }
  return cachedEmbeddedFontCss;
}

export interface RenderMapOptions {
  style?: StyleMode;
}

interface SecondaryCardBriefing {
  cutId: string;
  findingId: string;
  edgeIndex: number;
  relationship: Relationship;
  badge: string;
  pairLabel: string;
  headlinePct: string;
  detailText: string;
  lowPct: number;
  highPct: number;
  pointPct: number;
  reverseLine: string;
  lastTogether: string;
  receiptHash: string;
  receiptDate: string;
  receiptSubject: string;
  hash: string;
}

interface FamilyBriefingPayload {
  familyIndex: number;
  familyId: string;
  findingId: string;
  edgeIndex: number;
  relationship: Relationship;
  relationshipKinds: Relationship[];
  edgeIndices: number[];
  kickerChip: string;
  kickerTag: string;
  lastTogether: string;
  headline: string;
  lede: string;
  plate: FeaturedPlateLayout;
  balloonText: string;
  evidence: EvidencePanelCopy;
  hash: string;
  memberPaths: string[];
}

interface BriefingDataPayload {
  emptyState: (EmptyStateCopy & { suggestedCommand: string; plate: FeaturedPlateLayout }) | null;
  featured: {
    kind: 'family' | 'pair';
    isFamily: boolean;
    edgeIndex: number;
    familyIndex?: number;
    familyId?: string;
    relationship: Relationship;
    kickerChip: string;
    kickerTag: string;
    lastTogether: string;
    headline: string;
    lede: string;
    plate: FeaturedPlateLayout;
    balloonText: string;
    evidence: EvidencePanelCopy;
    hash: string;
  } | null;
  families: FamilyBriefingPayload[];
  secondaryCards: SecondaryCardBriefing[];
  ranked: RankedFindingItem[];
  provenance: AnalysisProvenance;
  stats: {
    ghostCount: number;
    familyCount: number;
    unknownCount: number;
    totalUnchecked: number;
    edgesCount: number;
    commitsAnalyzed: number;
    oldestCommit: string;
    newestCommit: string;
    nodesCount: number;
  };
}

const ALL_KINDS_VISIBLE: Record<Relationship, boolean> = {
  ghost: true,
  unknown: true,
  indirect: true,
  direct: true,
  test: true,
};

function buildBriefingData(data: MapData): BriefingDataPayload {
  const ghostCount = data.edges.filter((e) => e.relationship === 'ghost').length;
  const familyCount = (data.families ?? []).length;
  const unknownCount = data.edges.filter((e) => e.relationship === 'unknown').length;
  const totalUnchecked = Math.max(unknownCount, data.counts?.unknown ?? unknownCount);
  const stats = {
    ghostCount,
    familyCount,
    unknownCount,
    totalUnchecked,
    edgesCount: data.edges.length,
    commitsAnalyzed: data.meta.commitsAnalyzed,
    oldestCommit: data.meta.oldestCommit ?? '',
    newestCommit: data.meta.newestCommit ?? '',
    nodesCount: data.nodes.length,
  };

  const provenance = buildAnalysisProvenance(data);
  const featured = selectFeaturedFinding(data);
  if (featured.kind === 'empty') {
    const emptyCopy = formatEmptyStateCopy(data, {
      nodeCount: featured.contextClusterNodeIndices.length,
      edgeCount: featured.contextClusterEdgeIndices.length,
    });
    const emptyPlate = computeFeaturedPlateLayout(data, featured, {
      width: 760,
      height: 360,
      visible: ALL_KINDS_VISIBLE,
    });
    return {
      emptyState: {
        ...emptyCopy,
        suggestedCommand: emptyCopy.looserCommand,
        plate: emptyPlate,
      },
      featured: null,
      families: [],
      secondaryCards: [],
      ranked: [],
      provenance,
      stats,
    };
  }

  const ranked = buildRankedFindings(data, ALL_KINDS_VISIBLE);
  const evidence = formatEvidencePanelCopy(data, featured);
  const plate = computeFeaturedPlateLayout(data, featured, { width: 760, height: 420 });
  const leadEdge = featured.kind === 'family' ? featured.leadEdge : featured.edge;
  const leadEdgeIndex = featured.kind === 'family' ? featured.leadEdgeIndex : featured.edgeIndex;
  const balloonText = formatBalloonCallout(data, leadEdge);
  const leadDir = resolveStrongerDirection(data, leadEdge);
  const featuredHash = formatFindingHash(leadDir.fromNode.path, leadDir.toNode.path);
  const kickerTag =
    featured.kind === 'family'
      ? `FAMILY · ${featured.family.members.length} FILES · ${featured.family.qualifyingPairs}/${featured.family.possiblePairs} PAIRS`
      : `${leadEdge.relationship === 'ghost' ? 'GHOST WIRE' : leadEdge.relationship.toUpperCase()} · ${leadEdge.shared} SHARED COMMITS`;
  const lastTogether =
    featured.kind === 'family' ? featured.family.lastTogether : leadEdge.lastTogether;

  const familiesPayload: FamilyBriefingPayload[] = [];
  (data.families ?? []).forEach((fam, famIdx) => {
    const validEdgeIndices = fam.edgeIndices
      .filter((ei) => data.edges[ei] !== undefined)
      .sort((a, b) => {
        const ea = data.edges[a]!;
        const eb = data.edges[b]!;
        return (
          eb.overviewPriority - ea.overviewPriority ||
          eb.score - ea.score ||
          eb.shared - ea.shared ||
          a - b
        );
      });
    const famLeadEdgeIdx = validEdgeIndices[0] ?? 0;
    const famLeadEdge = data.edges[famLeadEdgeIdx] ?? leadEdge;
    if (!famLeadEdge) return;
    const famFeatured: FeaturedFinding = {
      kind: 'family',
      familyIndex: famIdx,
      family: fam,
      leadEdgeIndex: famLeadEdgeIdx,
      leadEdge: famLeadEdge,
    };
    const famRank = ranked.find((r) => r.kind === 'family' && r.familyIndex === famIdx);
    const famFindingId = famRank?.findingId ?? `F-${String(famIdx + 1).padStart(2, '0')}`;
    const famEv = formatEvidencePanelCopy(data, famFeatured, famFindingId);
    const famDir = resolveStrongerDirection(data, famLeadEdge);
    if (!famEv.explainCommand) {
      famEv.explainCommand = formatExplainCommand(famDir.fromNode.path, famDir.toNode.path);
    }
    const famPlate = computeFeaturedPlateLayout(data, famFeatured, {
      width: 760,
      height: 420,
      visible: ALL_KINDS_VISIBLE,
    });
    const famHasGhost =
      Array.isArray(fam.relationshipKinds) && fam.relationshipKinds.includes('ghost');
    const famRelKinds: Relationship[] =
      Array.isArray(fam.relationshipKinds) && fam.relationshipKinds.length > 0
        ? [...fam.relationshipKinds]
        : [famLeadEdge.relationship];
    familiesPayload.push({
      familyIndex: famIdx,
      familyId: fam.id,
      findingId: famFindingId,
      edgeIndex: famLeadEdgeIdx,
      relationship: famHasGhost ? 'ghost' : famLeadEdge.relationship,
      relationshipKinds: famRelKinds,
      edgeIndices: [...validEdgeIndices],
      kickerChip:
        featured.kind === 'family' && featured.familyIndex === famIdx
          ? KICKER_MOST_INTERESTING
          : `${famFindingId} · SELECTED FAMILY`,
      kickerTag: `FAMILY · ${fam.members.length} FILES · ${fam.qualifyingPairs}/${fam.possiblePairs} PAIRS`,
      lastTogether: fam.lastTogether,
      headline: famEv.headline,
      lede: famEv.subhead,
      plate: famPlate,
      balloonText: formatBalloonCallout(data, famLeadEdge),
      evidence: famEv,
      hash: formatFindingHash(famDir.fromNode.path, famDir.toNode.path),
      memberPaths: fam.members.map((m) => m.path),
    });
  });

  const excludedPaths = new Set<string>();
  if (featured.kind === 'family') {
    for (const m of featured.family.members) excludedPaths.add(m.path);
  }
  const candidateSecondary = data.edges
    .map((e, idx) => ({ e, idx }))
    .filter(({ e, idx }) => {
      if (idx === leadEdgeIndex) return false;
      const sPath = data.nodes[e.source]?.path ?? '';
      const tPath = data.nodes[e.target]?.path ?? '';
      if (excludedPaths.size > 0 && excludedPaths.has(sPath) && excludedPaths.has(tPath)) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const aGhost = a.e.relationship === 'ghost' ? 1 : 0;
      const bGhost = b.e.relationship === 'ghost' ? 1 : 0;
      if (bGhost !== aGhost) return bGhost - aGhost;
      if (b.e.overviewPriority !== a.e.overviewPriority) return b.e.overviewPriority - a.e.overviewPriority;
      const aLow = Math.max(a.e.interval.low, a.e.reverseInterval.low);
      const bLow = Math.max(b.e.interval.low, b.e.reverseInterval.low);
      if (bLow !== aLow) return bLow - aLow;
      return b.e.shared - a.e.shared;
    })
    .slice(0, 24);

  const secondaryCards: SecondaryCardBriefing[] = candidateSecondary.map(({ e, idx }, cardIdx) => {
    const isWeighted = Boolean(e.weighted);
    const dir = resolveStrongerDirection(data, e);
    const fwd = formatDirectionMetric(
      dir.shortFrom,
      dir.shortTo,
      dir.shared,
      dir.fromChanges,
      dir.confidence,
      dir.interval,
      isWeighted,
    );
    const rev = formatDirectionMetric(
      dir.shortTo,
      dir.shortFrom,
      dir.shared,
      dir.toChanges,
      dir.reverseConfidence,
      dir.reverseInterval,
      isWeighted,
    );
    const standalonePart = `${formatCounterexamplesLine(dir.toOnlyTotal)} (${dir.shortTo})`;
    const hash = formatFindingHash(dir.fromNode.path, dir.toNode.path);
    const rankMatch = ranked.find((r) => r.kind === 'pair' && r.edgeIndex === idx);
    const ev0 = e.evidence?.[0];
    return {
      cutId: `C-0${Math.min(4, cardIdx + 2)}`,
      findingId: rankMatch?.findingId ?? `F-0${cardIdx + 2}`,
      edgeIndex: idx,
      relationship: e.relationship,
      badge: e.relationship === 'ghost' ? 'GHOST WIRE' : e.relationship.toUpperCase(),
      pairLabel: `${dir.shortFrom} → ${dir.shortTo}`,
      headlinePct: fwd.pctText,
      detailText: `${fwd.detailText} · ≥${fwd.rangeLowPct}% lower bound`,
      lowPct: fwd.rangeLowPct,
      highPct: fwd.rangeHighPct,
      pointPct: fwd.pctValue,
      reverseLine: `Reverse (${dir.shortTo} → ${dir.shortFrom}): ${dir.shared} of ${dir.toChanges} (${rev.pctText}) · ${standalonePart}`,
      lastTogether: e.lastTogether,
      receiptHash: ev0 ? ev0.hash.slice(0, 7) : '',
      receiptDate: ev0 ? ev0.date : '',
      receiptSubject: ev0 ? sanitizeHtmlDisplayText(ev0.subject) : '',
      hash,
    };
  });

  // Ensure explainCommand uses formatExplainCommand when missing
  if (!evidence.explainCommand) {
    evidence.explainCommand = formatExplainCommand(leadDir.fromNode.path, leadDir.toNode.path);
  }

  return {
    emptyState: null,
    featured: {
      kind: featured.kind,
      isFamily: featured.kind === 'family',
      edgeIndex: leadEdgeIndex,
      ...(featured.kind === 'family'
        ? { familyIndex: featured.familyIndex, familyId: featured.family.id }
        : {}),
      relationship:
        featured.kind === 'family' &&
        Array.isArray(featured.family.relationshipKinds) &&
        featured.family.relationshipKinds.includes('ghost')
          ? 'ghost'
          : leadEdge.relationship,
      kickerChip: KICKER_MOST_INTERESTING,
      kickerTag,
      lastTogether,
      headline: evidence.headline,
      lede: evidence.subhead,
      plate,
      balloonText,
      evidence,
      hash: featuredHash,
    },
    families: familiesPayload,
    secondaryCards,
    ranked,
    provenance,
    stats,
  };
}

/**
 * Serializes data for embedding inside a <script> element. Escaping `<` keeps a
 * commit subject such as "</script><script>…" from ending the element early.
 */
export function embedJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * A single self-contained HTML file: no network requests, no external fonts or
 * libraries, so it works offline and can be attached to an issue or shared as-is.
 * Visual idea:
 * - `classic` (default): a cyanotype survey sheet of the dig site, with ghost wires marked
 *   in fluorescent pink flagging tape.
 * - `rich` (opt-in `--style rich`): a FRAME/12 contact-sheet ("dig sheet") with one
 *   numbered frame per connected component, ink/paper themes, and a single gold marker.
 */
export function renderMapHtml(
  data: MapData,
  layout?: LayoutResult | null,
  options?: RenderMapOptions,
): string {
  const style: StyleMode = options?.style ?? (layout?.style === 'rich' ? 'rich' : 'classic');
  if (style === 'rich') {
    const richLayout =
      layout === null
        ? null
        : layout && layout.style === 'rich' && Array.isArray(layout.frames)
          ? layout
          : computeRichLayout(data);
    return renderRichMapHtml(data, richLayout);
  }
  const resolvedLayout = layout === undefined ? computeLayout(data) : layout;
  const title = `Ghost wires in ${data.repoName}`;
  const layoutScript = resolvedLayout !== null
    ? `\n<script type="application/json" id="ra-layout">${embedJson(resolvedLayout)}</script>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="ra-style" content="classic">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="app">
  <header class="bar">
    <div class="heading">
      <h1>${escapeHtml(title)}</h1>
      <p id="summary" class="summary"></p>
      ${data.meta.warnings && data.meta.warnings.length > 0 ? `<div class="banner-warning">${data.meta.warnings.map((w) => `! ${escapeHtml(w)}`).join('<br>')}</div>` : ''}
    </div>
    <div class="controls">
      <label class="search"><span class="visually-hidden">Find a file</span>
        <input id="search" type="search" placeholder="Find a file  ( / )" autocomplete="off" spellcheck="false">
      </label>
      <div id="toggles" class="toggles" role="group" aria-label="Relationship types"></div>
    </div>
  </header>
  <main class="stage">
    <canvas id="map" role="img" aria-label="Map of files that change together. The panel lists the same relationships as text."></canvas>
    <div id="tooltip" class="tooltip" hidden></div>
    <div class="stage-overlay">
      <button id="reset-view" class="map-btn" type="button" title="Fit all files in view">Reset view</button>
      <button id="toggle-anim" class="map-btn" type="button" title="Pause or resume line animation">Pause animation</button>
    </div>
    <p class="hint">Drag to pan, scroll to zoom, drag a file to pin it.</p>
  </main>
  <aside id="panel" class="panel" aria-live="polite"></aside>
</div>
<script type="application/json" id="ra-data">${embedJson(data)}</script>${layoutScript}
<script>${CLIENT}</script>
</body>
</html>
`;
}

function renderRichMapHtml(data: MapData, layout: LayoutResult | null): string {
  const safeRepoName = sanitizeHtmlDisplayText(data.repoName);
  const title = `REPO ARCHAEOLOGY / MAP — ${safeRepoName}`;
  const briefing = buildBriefingData(data);
  const prov = briefing.provenance;
  const embeddedFontCss = getEmbeddedFontsCss();
  const layoutScript = layout !== null
    ? `\n<script type="application/json" id="ra-layout">${embedJson(layout)}</script>`
    : '';
  const briefingScript = `\n<script type="application/json" id="ra-briefing">${embedJson(briefing)}</script>`;
  const glossaryHtml = GLOSSARY_TERMS.map(
    (entry) =>
      `<details class="f12-glossary-item" name="f12-glossary" id="glossary-${entry.id}"><summary>${escapeHtml(entry.term)}</summary><div class="f12-glossary-body"><p class="f12-glossary-sum">${escapeHtml(entry.summary)}</p><p>${escapeHtml(entry.detail)}</p></div></details>`,
  ).join('\n              ');
  const provenanceDlHtml = prov.items
    .map(
      (item) =>
        `<div class="f12-prov-row"><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}</dd></div>`,
    )
    .join('\n              ');
  const provWarningsHtml =
    prov.warnings.length > 0
      ? `<div class="f12-prov-warnings">${prov.warnings.map((w) => `! ${escapeHtml(w)}`).join('<br>')}</div>`
      : '';
  const ghostEntry = getGlossaryEntry('ghost-wire');
  const familyEntry = getGlossaryEntry('file-family');
  const uncheckedEntry = getGlossaryEntry('unchecked-link');
  const dirEntry = getGlossaryEntry('directional-cochange');
  const wilsonEntry = getGlossaryEntry('wilson-interval');
  return `<!doctype html>
<html lang="en" data-theme-mode="system">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="text-scale" content="scale">
<meta name="ra-style" content="rich">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${embeddedFontCss}${RICH_STYLES}</style>
</head>
<body>
<span id="fc-probe" class="fc-probe" hidden aria-hidden="true"></span>
<div class="app" data-view="briefing">
  <header class="bar">
    <div class="heading">
      <div class="masthead-row">
        <h1>REPO ARCHAEOLOGY // INVESTIGATION BOARD</h1>
        <span class="repo-tag">${escapeHtml(safeRepoName)}</span>
        <span class="f12-evidence-pill">EVIDENCE · NOT PROOF</span>
        <details class="f12-howto" id="field-guide-details">
          <summary>Field Guide · How to read this map ▸</summary>
          <div class="f12-howto-pop" role="region" aria-label="Repo Archaeology Field Guide">
            <div class="f12-fg-head">
              <span class="f12-fg-kicker">REPO ARCHAEOLOGY // FIELD GUIDE</span>
              <button type="button" id="field-guide-close" class="f12-fg-close" aria-label="Close Field Guide">Close ✕</button>
            </div>
            <div class="f12-fg-section">
              <div class="f12-fg-sec-title">01 · START HERE</div>
              <p class="f12-fg-intro">Repo Archaeology examines Git history to identify files that repeatedly change together. Select a finding, inspect its directional numbers and supporting commits, and decide whether the companion file deserves coordinated review. Historical co-change is a signal to investigate, not proof that a change is required.</p>
            </div>
            <div class="f12-fg-section">
              <div class="f12-fg-sec-title">02 · GLOSSARY (${GLOSSARY_TERMS.length} TERMS)</div>
              <div class="f12-glossary-list">
              ${glossaryHtml}
              </div>
            </div>
            <div class="f12-fg-section">
              <div class="f12-fg-sec-title">03 · ${escapeHtml(prov.title)}</div>
              <p class="f12-fg-sub">${escapeHtml(prov.subtitle)}</p>
              <dl class="f12-provenance-list">
              ${provenanceDlHtml}
              </dl>
              ${provWarningsHtml}
              <div class="f12-fg-footer">
                <span>${escapeHtml(prov.footerText)}</span>
                <a href="${escapeHtml(prov.githubUrl)}" target="_blank" rel="noopener noreferrer">View project on GitHub ↗</a>
              </div>
            </div>
          </div>
        </details>
      </div>
      <div class="masthead-rule" aria-hidden="true"></div>
      <p id="summary" class="summary"></p>
      ${prov.warnings.length > 0 ? `<div class="banner-warning">${prov.warnings.map((w) => `! ${escapeHtml(w)}`).join('<br>')}</div>` : ''}
    </div>
    <div class="controls">
      <label class="search"><span class="visually-hidden">Find a file</span>
        <input id="search" type="search" placeholder="Find a file  ( / )" autocomplete="off" spellcheck="false">
      </label>
      <div class="f12-mode-switch" role="group" aria-label="Map view mode">
        <button id="view-briefing" class="f12-mode-btn" type="button" aria-pressed="true" title="Narrative investigation board (B)">Briefing</button>
        <button id="view-atlas" class="f12-mode-btn" type="button" aria-pressed="false" title="Contact-sheet network atlas (A)">Atlas</button>
      </div>
      <button id="theme-toggle" class="map-btn theme-btn" type="button" data-theme-mode="system" title="Cycle theme: System, Light, Dark">Theme: System</button>
      <div id="toggles" class="toggles" role="group" aria-label="Relationship types"></div>
    </div>
  </header>
  <main id="briefing-view" class="f12-briefing" aria-label="Investigation board briefing"></main>
  <main id="atlas-stage" class="stage" hidden inert>
    <canvas id="map" role="img" aria-label="Contact-sheet dig map of files that change together. The panel lists the same relationships as text."></canvas>
    <img id="print-map-img" class="print-map-img" alt="Contact-sheet map of files that change together" hidden>
    <div id="tooltip" class="tooltip" hidden></div>
    <div class="stage-overlay">
      <button id="reset-view" class="map-btn" type="button" title="Fit whole contact sheet in view">Reset view</button>
      <button id="focus-top" class="map-btn" type="button" title="Zoom to top priority findings">Focus top findings</button>
      <button id="fit-frame" class="map-btn" type="button" title="Zoom to active cut frame">Fit frame</button>
      <button id="toggle-dir-color" class="map-btn" type="button" aria-pressed="false" title="Color file nodes by directory">Color by directory</button>
      <button id="toggle-anim" class="map-btn" type="button" title="Pause or resume line animation">Pause animation</button>
    </div>
    <p class="hint">Drag to pan, scroll to zoom, drag a file inside its frame, or click a card to inspect.</p>
  </main>
  <aside id="panel" class="panel" aria-live="polite" hidden inert></aside>
  <div id="help-ghost-wire" class="f12-help-popover" popover="auto" role="dialog" aria-label="What is a Ghost Wire?">
    <div class="f12-help-title">${escapeHtml(ghostEntry.shortTitle)}</div>
    <p><strong>${escapeHtml(ghostEntry.summary)}</strong> ${escapeHtml(ghostEntry.detail)}</p>
    <button type="button" class="f12-help-more-btn" data-glossary-target="glossary-ghost-wire">Open in Field Guide ▸</button>
  </div>
  <div id="help-family" class="f12-help-popover" popover="auto" role="dialog" aria-label="What is a Finding Family?">
    <div class="f12-help-title">${escapeHtml(familyEntry.shortTitle)}</div>
    <p><strong>${escapeHtml(familyEntry.summary)}</strong> ${escapeHtml(familyEntry.detail)}</p>
    <button type="button" class="f12-help-more-btn" data-glossary-target="glossary-file-family">Open in Field Guide ▸</button>
  </div>
  <div id="help-unchecked" class="f12-help-popover" popover="auto" role="dialog" aria-label="What are Unchecked Links?">
    <div class="f12-help-title">${escapeHtml(uncheckedEntry.shortTitle)}</div>
    <p><strong>${escapeHtml(uncheckedEntry.summary)}</strong> ${escapeHtml(uncheckedEntry.detail)}</p>
    <button type="button" class="f12-help-more-btn" data-glossary-target="glossary-unchecked-link">Open in Field Guide ▸</button>
  </div>
  <div id="help-directional-pct" class="f12-help-popover" popover="auto" role="dialog" aria-label="What is Directional Co-Change Percentage?">
    <div class="f12-help-title">${escapeHtml(dirEntry.shortTitle)}</div>
    <p><strong>${escapeHtml(dirEntry.summary)}</strong> ${escapeHtml(dirEntry.detail)}</p>
    <button type="button" class="f12-help-more-btn" data-glossary-target="glossary-directional-cochange">Open in Field Guide ▸</button>
  </div>
  <div id="help-confidence-range" class="f12-help-popover" popover="auto" role="dialog" aria-label="What is the 95% Wilson Confidence Range?">
    <div class="f12-help-title">${escapeHtml(wilsonEntry.shortTitle)}</div>
    <p><strong>${escapeHtml(wilsonEntry.summary)}</strong> ${escapeHtml(wilsonEntry.detail)}</p>
    <button type="button" class="f12-help-more-btn" data-glossary-target="glossary-wilson-interval">Open in Field Guide ▸</button>
  </div>
</div>
<script type="application/json" id="ra-data">${embedJson(data)}</script>${layoutScript}${briefingScript}
<script>${RICH_CLIENT}</script>
</body>
</html>
`;
}

const STYLES = String.raw`
:root {
  --ground: #13304f;
  --ground-deep: #0e2540;
  --ground-surface: #173b61;
  --ground-card: rgba(14, 37, 64, 0.75);
  --ground-card-hover: rgba(23, 59, 97, 0.9);
  --chalk: #e8eef5;
  --chalk-faded: #9fb4cc;
  --chalk-dim: #7189a5;
  --grid: rgba(159, 180, 204, 0.08);
  --tape: #ff4f9a;
  --tape-glow: rgba(255, 79, 154, 0.35);
  --ochre: #e3b65b;
  --lichen: #7fd1b0;
  --import: rgba(232, 238, 245, 0.55);
  --border-subtle: rgba(159, 180, 204, 0.18);
  --border-active: rgba(159, 180, 204, 0.35);
  --condensed: "Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", "Helvetica Neue", sans-serif;
  --text: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --code: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--ground); color: var(--chalk); font: 15px/1.55 var(--text); }
button, input { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--tape); outline-offset: 2px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

.app { display: grid; grid-template-columns: minmax(0, 1fr) 420px; grid-template-rows: auto minmax(0, 1fr); height: 100vh; }
.bar { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 12px 32px; align-items: flex-end; justify-content: space-between; padding: 18px 24px 14px; border-bottom: 1px solid var(--border-subtle); background: var(--ground); }
h1 { margin: 0; font: 600 30px/1.1 var(--condensed); letter-spacing: 0.01em; font-stretch: condensed; }
.summary { margin: 4px 0 0; color: var(--chalk-faded); font-size: 14px; max-width: 75ch; }
.controls { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; }
.search input { width: 240px; padding: 7px 11px; border: 1px solid var(--border-active); border-radius: 6px; background: var(--ground-deep); font-size: 13.5px; }
.search input::placeholder { color: var(--chalk-faded); }
.banner-warning { display: inline-flex; align-items: center; gap: 8px; margin-top: 8px; padding: 6px 12px; background: rgba(227, 182, 91, 0.12); border: 1px solid rgba(227, 182, 91, 0.35); border-radius: 6px; font-size: 13px; color: var(--ochre); }
.toggles { display: flex; flex-wrap: wrap; gap: 6px; }
.toggle { display: inline-flex; align-items: center; gap: 8px; min-height: 24px; min-width: 24px; padding: 5px 11px; border: 1px solid rgba(159, 180, 204, 0.3); border-radius: 999px; background: transparent; cursor: pointer; font-size: 13px; font-weight: 500; color: var(--chalk); transition: all 0.15s ease; }
.toggle:hover { border-color: var(--chalk); }
.toggle[aria-pressed="false"] { border-style: dashed; border-color: rgba(159, 180, 204, 0.25); background: rgba(14, 37, 64, 0.4); color: var(--chalk-faded); }
.toggle[aria-pressed="false"] .count { color: var(--chalk-dim); }
.toggle[aria-pressed="true"] { background: rgba(23, 59, 97, 0.5); border-color: var(--border-active); color: var(--chalk); }
.toggle .count { color: var(--chalk-faded); font-variant-numeric: tabular-nums; }
.swatch { width: 22px; height: 0; border-top: 2px solid; }
.swatch.ghost { border-top: 2px dashed var(--tape); filter: drop-shadow(0 0 3px var(--tape)); }
.swatch.unknown { border-top: 2px dotted var(--ochre); }
.swatch.indirect { border-top: 2px dashed var(--import); opacity: 0.8; }
.swatch.direct { border-top-color: var(--import); }
.swatch.test { border-top-color: var(--lichen); }

.stage { position: relative; min-height: 0; overflow: hidden; }
canvas { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
canvas.dragging { cursor: grabbing; }
canvas.pointing { cursor: pointer; }
.stage-overlay { position: absolute; top: 14px; left: 14px; display: flex; gap: 8px; z-index: 10; }
.map-btn { display: inline-flex; align-items: center; gap: 6px; min-height: 24px; min-width: 24px; padding: 6px 12px; background: rgba(14, 37, 64, 0.88); backdrop-filter: blur(6px); border: 1px solid var(--border-active); border-radius: 6px; color: var(--chalk); font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s ease; box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
.map-btn:hover { background: rgba(19, 48, 79, 0.98); border-color: var(--chalk); transform: translateY(-1px); }
.hint { position: absolute; left: 16px; bottom: 12px; margin: 0; font-size: 12.5px; color: var(--chalk-faded); pointer-events: none; }
.tooltip { position: absolute; pointer-events: none; max-width: 440px; padding: 7px 11px; border-radius: 6px; background: var(--ground-deep); border: 1px solid var(--border-active); font-size: 13.5px; box-shadow: 0 4px 14px rgba(0,0,0,0.4); z-index: 20; }
.tooltip code { font-family: var(--code); font-size: 13px; word-break: break-all; }

.panel { overflow-y: auto; padding: 22px 24px 36px; background: var(--ground-deep); border-left: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 14px; }
.panel h2 { margin: 0 0 6px; font: 600 22px/1.25 var(--condensed); font-stretch: condensed; }
.panel h3 { margin: 18px 0 8px; font: 600 13px/1.2 var(--text); text-transform: uppercase; letter-spacing: 0.05em; color: var(--chalk-faded); }
.panel p { margin: 0 0 10px; color: var(--chalk-faded); font-size: 14.5px; line-height: 1.55; }
.panel .path { font-family: var(--code); font-size: 13.5px; overflow-wrap: anywhere; color: var(--chalk); }
.panel ol, .panel ul { list-style: none; margin: 0; padding: 0; }

.badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.badge.ghost { background: rgba(255, 79, 154, 0.15); color: var(--tape); border: 1px solid rgba(255, 79, 154, 0.35); }
.badge.parallel { background: rgba(160, 200, 240, 0.12); color: #a0c8f0; border: 1px solid rgba(160, 200, 240, 0.3); }
.badge.family { background: rgba(127, 209, 176, 0.16); color: var(--lichen); border: 1px solid rgba(127, 209, 176, 0.4); }
.badge.unknown { background: rgba(227, 182, 91, 0.15); color: var(--ochre); border: 1px solid rgba(227, 182, 91, 0.35); }
.badge.indirect { background: rgba(160, 200, 240, 0.15); color: #a0c8f0; border: 1px solid rgba(160, 200, 240, 0.3); }
.badge.direct { background: rgba(232, 238, 245, 0.1); color: var(--chalk); border: 1px solid rgba(232, 238, 245, 0.25); }
.badge.test { background: rgba(127, 209, 176, 0.15); color: var(--lichen); border: 1px solid rgba(127, 209, 176, 0.35); }

.tab-group { display: flex; gap: 4px; margin-bottom: 8px; background: rgba(14, 37, 64, 0.7); padding: 3px; border-radius: 8px; border: 1px solid var(--border-subtle); }
.tab-btn { flex: 1; padding: 6px 8px; background: transparent; border: 0; border-radius: 6px; color: var(--chalk-faded); font-size: 12.5px; font-weight: 500; cursor: pointer; text-align: center; transition: all 0.15s ease; }
.tab-btn:hover { color: var(--chalk); }
.tab-btn.active { background: var(--ground-surface); color: var(--chalk); box-shadow: 0 1px 4px rgba(0,0,0,0.3); }

.card-hint { font-size: 12px; color: var(--chalk-dim); margin: -4px 0 8px; }
.card { background: var(--ground-card); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease; display: block; width: 100%; text-align: left; }
.card.interactive { cursor: pointer; font: inherit; }
.card.interactive:hover { border-color: rgba(255, 79, 154, 0.5); background: var(--ground-card-hover); transform: translateY(-1px); }
.card.selected { border-color: var(--tape); box-shadow: 0 0 14px var(--tape-glow); }
.card.family-card { border-left: 3px solid var(--lichen); }
.card.family-card.interactive:hover { border-color: rgba(127, 209, 176, 0.65); }

.card-header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.card-title { font-family: var(--code); font-size: 13.5px; font-weight: 600; color: var(--chalk); overflow-wrap: anywhere; }
.card-sub { font-size: 12.5px; color: var(--chalk-faded); margin-top: 4px; }
.family-variants { display: flex; flex-wrap: wrap; gap: 4px 6px; margin: 6px 0 4px; }
.family-variant-pill { display: inline-block; padding: 1px 6px; border-radius: 4px; background: rgba(23, 59, 97, 0.7); border: 1px solid var(--border-subtle); font: 11.5px/1.4 var(--code); color: var(--chalk); }

.file-link { display: inline-flex; align-items: center; min-height: 24px; min-width: 24px; padding: 0; border: 0; background: none; text-align: left; cursor: pointer; font-family: var(--code); font-size: 13.5px; overflow-wrap: anywhere; text-decoration: underline; text-decoration-color: rgba(159, 180, 204, 0.4); text-underline-offset: 3px; color: var(--chalk); }
.file-link:hover { text-decoration-color: var(--tape); color: #fff; }

.nav-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.back-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; margin-bottom: 8px; background: rgba(14, 37, 64, 0.6); border: 1px solid var(--border-active); border-radius: 6px; color: var(--chalk); font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s ease; width: fit-content; }
.nav-row .back-btn { margin-bottom: 0; }
.back-btn:hover { background: var(--ground-surface); border-color: var(--chalk); }
.back-to-family-btn { border-color: rgba(127, 209, 176, 0.45); color: var(--lichen); }
.back-to-family-btn:hover { border-color: var(--lichen); color: #fff; }

.pair-container { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
.pair-box { background: rgba(14, 37, 64, 0.85); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 10px 12px; }
.pair-box-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 4px; }
.pair-dir { font-size: 12px; color: var(--chalk-dim); }
.pair-wire { display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 12.5px; color: var(--chalk-faded); padding: 2px 0; }

.family-pair-list { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 12px; }
.family-pair-details { background: rgba(14, 37, 64, 0.78); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 8px 12px; }
.family-pair-details[open] { border-color: var(--border-active); background: rgba(14, 37, 64, 0.92); }
.family-pair-summary { cursor: pointer; font: 600 13px/1.4 var(--code); color: var(--chalk); display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 6px; }
.family-pair-meta { font: 500 12px/1.3 var(--text); color: var(--chalk-faded); display: inline-flex; align-items: center; gap: 6px; }
.family-pair-body { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(159, 180, 204, 0.14); font-size: 12.5px; color: var(--chalk-faded); }
.family-pair-stat { margin: 3px 0; }
.btn-inspect-pair { display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; padding: 5px 10px; background: rgba(23, 59, 97, 0.75); border: 1px solid var(--border-active); border-radius: 5px; color: var(--chalk); font-size: 12.5px; font-weight: 500; cursor: pointer; transition: all 0.15s ease; }
.btn-inspect-pair:hover { border-color: var(--tape); color: #fff; background: var(--ground-surface); }
.evidence-scope-tag { display: inline-block; padding: 1px 6px; margin-right: 6px; border-radius: 4px; background: rgba(127, 209, 176, 0.14); border: 1px solid rgba(127, 209, 176, 0.32); font: 600 11px/1.3 var(--text); color: var(--lichen); }

.cochange-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 12px 0; }
.cochange-card { background: rgba(14, 37, 64, 0.65); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 10px 8px; text-align: center; }
.cochange-pct { font-size: 21px; font-weight: 700; color: var(--chalk); font-variant-numeric: tabular-nums; }
.cochange-label { font-size: 12px; color: var(--chalk-faded); margin-top: 4px; line-height: 1.3; }

.callout { background: rgba(19, 48, 79, 0.6); border-left: 3px solid var(--tape); border-radius: 0 6px 6px 0; padding: 12px 14px; margin: 12px 0; font-size: 14px; line-height: 1.55; color: var(--chalk); }
.callout.unknown { border-left-color: var(--ochre); }
.callout.indirect { border-left-color: #a0c8f0; }
.callout.direct { border-left-color: var(--chalk-faded); }
.callout.test { border-left-color: var(--lichen); }
.callout-title { font-weight: 600; font-size: 13.5px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; }

.evidence-wrap { margin: 12px 0 0; color: var(--chalk-faded); font-size: 13px; }
.evidence-wrap summary { width: fit-content; cursor: pointer; color: var(--chalk); font-weight: 500; padding: 4px 0; }
.evidence { margin: 8px 0 0; font-size: 13px; color: var(--chalk-faded); }
.evidence li { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; padding: 6px 0; border-top: 1px solid rgba(159, 180, 204, 0.1); }
.evidence .hash { display: inline-flex; align-items: center; justify-content: center; min-height: 24px; min-width: 24px; padding: 2px 6px; border: 1px solid var(--border-subtle); border-radius: 4px; background: rgba(14, 37, 64, 0.6); cursor: pointer; font-family: var(--code); font-size: 12px; color: var(--chalk); height: fit-content; }
.evidence .hash:hover { border-color: var(--tape); color: var(--tape); }
.evidence-item-body { min-width: 0; }
.evidence-rename { font-family: var(--code); font-size: 11.5px; color: var(--chalk-dim); margin-top: 2px; overflow-wrap: anywhere; }

.patch-details { grid-column: 1 / -1; margin-top: 4px; background: rgba(10, 26, 46, 0.75); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 6px 10px; }
.patch-details summary { font-size: 12px; color: #a0c8f0; cursor: pointer; font-weight: 500; padding: 2px 0; }
.patch-file { margin-top: 8px; border-top: 1px solid rgba(159, 180, 204, 0.12); padding-top: 6px; }
.patch-file-title { font-family: var(--code); font-size: 12px; font-weight: 600; color: var(--chalk); overflow-wrap: anywhere; }
.patch-note { font-size: 12px; color: var(--chalk-dim); margin-top: 3px; }
.patch-hunk { margin: 6px 0 0; padding: 6px 8px; background: rgba(7, 19, 34, 0.85); border-radius: 4px; overflow-x: auto; font: 11.5px/1.45 var(--code); }
.patch-hunk-hdr { color: #a0c8f0; margin-bottom: 2px; white-space: pre; }
.patch-line { white-space: pre; color: var(--chalk-faded); }
.patch-line.add { color: var(--lichen); background: rgba(127, 209, 176, 0.08); }
.patch-line.del { color: #ff8da1; background: rgba(255, 79, 154, 0.08); }

.counterexample-group { margin-top: 8px; }
.counterexample-title { font-size: 12px; font-weight: 600; color: var(--chalk); margin: 6px 0 4px; }

.cli-box { margin-top: 12px; padding: 10px 12px; background: rgba(14, 37, 64, 0.85); border: 1px solid var(--border-subtle); border-radius: 6px; }
.cli-box-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
.cli-box-label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--chalk-faded); }
.btn-cli-copy { padding: 3px 9px; border: 1px solid var(--border-active); border-radius: 4px; background: rgba(23, 59, 97, 0.65); color: var(--chalk); font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.15s ease; }
.btn-cli-copy:hover { border-color: var(--tape); color: #fff; }
.btn-cli-copy.copied { background: rgba(127, 209, 176, 0.22); border-color: var(--lichen); color: var(--lichen); }
.cli-code { display: block; font: 12px/1.45 var(--code); color: var(--chalk); overflow-wrap: anywhere; user-select: all; }
.privacy-note { margin-top: 6px; font-size: 12px; line-height: 1.45; color: var(--chalk-dim); }

.btn-export { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 9px 16px; margin-top: 14px; background: rgba(255, 79, 154, 0.14); border: 1px solid rgba(255, 79, 154, 0.4); border-radius: 6px; color: var(--chalk); font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.15s ease; }
.btn-export:hover { background: rgba(255, 79, 154, 0.25); border-color: var(--tape); }
.btn-export.copied { background: rgba(127, 209, 176, 0.22); border-color: var(--lichen); color: var(--lichen); }

.view-all-btn { display: block; width: 100%; padding: 8px 12px; margin-top: 10px; background: transparent; border: 1px dashed var(--border-active); border-radius: 6px; color: var(--chalk-faded); font-size: 13px; font-weight: 500; cursor: pointer; text-align: center; }
.view-all-btn:hover { color: var(--chalk); border-color: var(--chalk); border-style: solid; }

.folder-legend { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 8px; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--chalk-faded); }
.legend-dot { width: 9px; height: 9px; border-radius: 50%; }

@media (max-width: 960px) {
  .app { grid-template-columns: 1fr; grid-template-rows: auto 55vh auto; height: auto; }
  canvas { touch-action: pan-y; }
  .panel { border-left: 0; border-top: 1px solid var(--border-subtle); }
  .search input { width: 100%; }
  .controls, .search { width: 100%; }
}
`;

const CLIENT = String.raw`
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('ra-data').textContent);
  var KINDS = {
    ghost: { label: 'Ghost wires', color: '#ff4f9a' },
    unknown: { label: 'Unchecked', color: '#e3b65b' },
    indirect: { label: 'Indirect imports', color: 'rgba(160, 200, 240, 0.6)' },
    direct: { label: 'Import links', color: 'rgba(232, 238, 245, 0.55)' },
    test: { label: 'Test links', color: '#7fd1b0' }
  };
  var ORDER = ['ghost', 'unknown', 'indirect', 'direct', 'test'];
  function hasKindInData(kind) {
    if (data.edges.some(function (e) { return e.relationship === kind; })) return true;
    return (data.families || []).some(function (f) {
      return (f.undrawnPairs || []).some(function (up) { return up.relationship === kind; });
    });
  }
  var hasPrimary = data.edges.some(function (e) { return e.relationship !== 'unknown'; });
  var visible = {
    ghost: hasKindInData('ghost'),
    unknown: !hasPrimary && hasKindInData('unknown'),
    indirect: hasKindInData('indirect'),
    direct: hasKindInData('direct'),
    test: hasKindInData('test')
  };
  var motionMedia = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var reduceMotion = Boolean(motionMedia && motionMedia.matches);

  var canvas = document.getElementById('map');
  var ctx = canvas.getContext('2d');
  var tooltip = document.getElementById('tooltip');
  var panel = document.getElementById('panel');
  var search = document.getElementById('search');
  var resetBtn = document.getElementById('reset-view');
  var hintEl = typeof document.querySelector === 'function' ? document.querySelector('.hint') : null;
  function updateTouchHint() {
    if (hintEl) hintEl.textContent = 'Two fingers to pan and zoom';
  }
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
    updateTouchHint();
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function pct(x) { return Math.floor(x * 100 + 1e-9) + '%'; }
  function formatCi(iv, raw) {
    return '(' + (raw ? 'raw ' : '') + '95% CI ' + Math.floor(iv.low * 100 + 1e-9) + '\u2013' + Math.ceil(iv.high * 100 - 1e-9) + '%)';
  }
  function base(p) { var i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
  function distinguishingPaths(a, b) {
    var aParts = a.split('/'), bParts = b.split('/');
    for (var depth = 1; depth <= Math.max(aParts.length, bParts.length); depth++) {
      var aLabel = aParts.slice(-depth).join('/');
      var bLabel = bParts.slice(-depth).join('/');
      if (aLabel !== bLabel) return [aLabel, bLabel];
    }
    return [a, b];
  }
  function plural(n, w) { return n.toLocaleString('en-US') + ' ' + w + (n === 1 ? '' : 's'); }
  function relativeDate(date) {
    var days = Math.max(0, Math.floor((Date.parse(data.generatedAt) - Date.parse(date)) / 86400000));
    if (days < 1) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 45) return days + ' days ago';
    var months = Math.round(days / 30.44);
    if (months < 18) return months + ' ' + (months === 1 ? 'month' : 'months') + ' ago';
    var years = (days / 365.25).toFixed(1).replace(/\.0$/, '');
    return years + ' years ago';
  }
  function capitalize(text) { return text.charAt(0).toUpperCase() + text.slice(1); }

  // Deterministic layout: the same repo produces the same picture every time.
  var seed = 7;
  for (var s = 0; s < data.repoName.length; s++) seed = (seed * 31 + data.repoName.charCodeAt(s)) | 0;
  function random() {
    seed = (seed + 0x6d2b79f5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function pairJitter(i, j) {
    var lo = i < j ? i : j;
    var hi = i < j ? j : i;
    var h1 = (Math.imul(lo + 1, 0x9e3779b1) ^ Math.imul(hi + 1, 0x85ebca6b)) | 0;
    h1 = Math.imul(h1 ^ (h1 >>> 15), 1 | h1);
    h1 = (h1 + Math.imul(h1 ^ (h1 >>> 7), 61 | h1)) ^ h1;
    var jx = ((h1 ^ (h1 >>> 14)) >>> 0) / 4294967296 - 0.5;
    var h2 = (h1 + 0x6d2b79f5) | 0;
    h2 = Math.imul(h2 ^ (h2 >>> 15), 1 | h2);
    h2 = (h2 + Math.imul(h2 ^ (h2 >>> 7), 61 | h2)) ^ h2;
    var jy = ((h2 ^ (h2 >>> 14)) >>> 0) / 4294967296 - 0.5;
    return i < j ? { dx: jx, dy: jy } : { dx: -jx, dy: -jy };
  }
  function hashHue(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return Math.round((h * 137.508) % 360);
  }

  // ---- data ----------------------------------------------------------------
  // Null-prototype object: folders named "constructor" or "__proto__" must not hit Object.prototype.
  var dirs = Object.create(null);
  var dirList = [];
  var nodes = data.nodes.map(function (n, i) {
    if (!dirs[n.dir]) { dirs[n.dir] = { name: n.dir, x: 0, y: 0, count: 0 }; dirList.push(dirs[n.dir]); }
    return {
      i: i, path: n.path, dir: n.dir, changes: n.changes, author: n.topAuthor, share: n.topAuthorShare,
      r: 4 + Math.min(14, Math.sqrt(n.changes) * 1.25),
      color: 'hsl(' + hashHue(n.dir) + ', 58%, 72%)',
      x: 0, y: 0, vx: 0, vy: 0, pinned: false, edges: []
    };
  });
  var edges = data.edges.map(function (e) {
    var edge = { s: nodes[e.source], t: nodes[e.target], d: e };
    edge.s.edges.push(edge);
    edge.t.edges.push(edge);
    return edge;
  });

  function edgeKey(a, b) {
    return a < b ? a + '\0' + b : b + '\0' + a;
  }
  var nodeByPath = Object.create(null);
  nodes.forEach(function (n) { nodeByPath[n.path] = n; });
  var edgeByPairKey = Object.create(null);
  edges.forEach(function (e) { edgeByPairKey[edgeKey(e.s.path, e.t.path)] = e; });
  var families = (data.families || []).map(function (f) {
    var famEdges = [];
    (f.edgeIndices || []).forEach(function (idx) {
      if (edges[idx]) famEdges.push(edges[idx]);
    });
    var relList = f.relationships || f.pairs;
    if (famEdges.length === 0 && relList) {
      relList.forEach(function (p) {
        var found = edgeByPairKey[edgeKey(p.from, p.to)];
        if (found) famEdges.push(found);
      });
    }
    var famNodes = [];
    (f.members || []).forEach(function (m) {
      var n = typeof m.nodeIndex === 'number' && nodes[m.nodeIndex] ? nodes[m.nodeIndex] : nodeByPath[m.path];
      if (n) famNodes.push(n);
    });
    return { d: f, members: f.members || [], edges: famEdges, undrawnPairs: f.undrawnPairs || [], nodes: famNodes };
  });

  // Disambiguate duplicate basenames (e.g. multiple page.tsx or route.ts)
  var baseCounts = Object.create(null);
  nodes.forEach(function (n) {
    var b = base(n.path);
    baseCounts[b] = (baseCounts[b] || 0) + 1;
  });
  function getNodeLabel(n) {
    var b = base(n.path);
    if (baseCounts[b] <= 1) return b;
    var parts = n.path.split('/');
    if (parts.length >= 2) return parts.slice(-2).join('/');
    return n.path;
  }

  var overviewGhosts = edges.filter(function (e) { return e.d.relationship === 'ghost'; }).sort(function (a, b) {
    return b.d.overviewPriority - a.d.overviewPriority || b.d.score - a.d.score || b.d.shared - a.d.shared;
  });
  var overviewLabelNodes = {};
  overviewGhosts.slice(0, 3).forEach(function (e) {
    var labels = distinguishingPaths(e.s.path, e.t.path);
    overviewLabelNodes[e.s.i] = labels[0];
    overviewLabelNodes[e.t.i] = labels[1];
  });
  dirList.forEach(function (d, i) {
    var angle = (i / Math.max(1, dirList.length)) * Math.PI * 2;
    var radius = 120 + 40 * Math.sqrt(dirList.length);
    d.x = Math.cos(angle) * radius;
    d.y = Math.sin(angle) * radius;
  });
  nodes.forEach(function (n) {
    var d = dirs[n.dir];
    n.x = d.x + (random() - 0.5) * 80;
    n.y = d.y + (random() - 0.5) * 80;
  });
  var layoutEl = document.getElementById('ra-layout');
  var precomputed = null;
  if (layoutEl && layoutEl.textContent) {
    try { precomputed = JSON.parse(layoutEl.textContent); } catch (_) { precomputed = null; }
  }
  var hasPrecomputed = Boolean(
    precomputed &&
    Array.isArray(precomputed.x) &&
    Array.isArray(precomputed.y) &&
    precomputed.x.length === nodes.length &&
    precomputed.y.length === nodes.length &&
    precomputed.x.every(function (v) { return typeof v === 'number' && Number.isFinite(v); }) &&
    precomputed.y.every(function (v) { return typeof v === 'number' && Number.isFinite(v); })
  );
  if (hasPrecomputed) {
    for (var li = 0; li < nodes.length; li++) {
      nodes[li].x = precomputed.x[li];
      nodes[li].y = precomputed.y[li];
    }
  }

  // ---- header --------------------------------------------------------------
  var m = data.meta;
  var span = m.oldestCommit && m.newestCommit ? ' between ' + m.oldestCommit + ' and ' + m.newestCommit : '';
  function updateSummary() {
    var shown = edges.filter(function (e) { return visible[e.d.relationship]; }).length;
    document.getElementById('summary').textContent =
      'Analyzed ' + plural(m.commitsAnalyzed, 'commit') + span + '. Loaded ' + plural(edges.length, 'relationship') +
      ' and showing ' + shown.toLocaleString('en-US') + ' (each at least ' + m.settings.minShared +
      ' shared commits and ' + pct(m.settings.minConfidence) + ' confidence).';
  }
  updateSummary();

  var alpha = hasPrecomputed ? 0 : 1;
  var tickCount = 0;
  var fitPendingAfterSettle = !hasPrecomputed;
  var deferSimOneFrame = false;
  var activeNodesList = [];
  var visibleEdgesList = [];
  var edgesByKind = { test: [], direct: [], indirect: [], unknown: [], ghost: [] };
  edges.forEach(function (e) {
    if (edgesByKind[e.d.relationship]) edgesByKind[e.d.relationship].push(e);
  });
  var xOrder = new Int32Array(nodes.length);
  var cellX = new Int32Array(nodes.length);
  var cellY = new Int32Array(nodes.length);
  var nodeCell = new Int32Array(nodes.length);
  var sortedNode = new Int32Array(nodes.length);
  var gridCounts = new Int32Array(1024);
  var gridStarts = new Int32Array(1024);
  var gridWrite = new Int32Array(1024);
  var nonEmptyCells = new Int32Array(1024);
  var xOrderNeedsInit = true;
  function syncActiveNodes() {
    activeNodesList = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var act = false;
      for (var k = 0; k < n.edges.length; k++) {
        if (visible[n.edges[k].d.relationship]) { act = true; break; }
      }
      n.active = act;
      if (act) activeNodesList.push(n);
      else { n.vx = 0; n.vy = 0; }
    }
    visibleEdgesList = [];
    for (var ei = 0; ei < edges.length; ei++) {
      if (visible[edges[ei].d.relationship]) visibleEdgesList.push(edges[ei]);
    }
    xOrderNeedsInit = true;
  }
  syncActiveNodes();

  var toggles = document.getElementById('toggles');
  ORDER.forEach(function (kind) {
    var shown = edges.filter(function (e) { return e.d.relationship === kind; }).length;
    if (shown === 0 && !hasKindInData(kind)) return;
    var b = el('button', 'toggle');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(visible[kind]));
    if (kind === 'unknown') b.title = 'Hidden by default when other links exist: import status could not be verified';
    b.appendChild(el('span', 'swatch ' + kind));
    b.appendChild(el('span', '', KINDS[kind].label));
    b.appendChild(el('span', 'count', String(shown)));
    b.addEventListener('click', function () {
      visible[kind] = !visible[kind];
      b.setAttribute('aria-pressed', String(visible[kind]));
      syncActiveNodes();
      if (selectedEdge && !visible[selectedEdge.d.relationship]) selectedEdge = null;
      if (selectedFamily && !resolveActiveFamilyView(selectedFamily)) selectedFamily = null;
      if (returnToFamily && !resolveActiveFamilyView(returnToFamily)) returnToFamily = null;
      alpha = Math.max(alpha, 0.6);
      tickCount = 0;
      deferSimOneFrame = true;
      fitPendingAfterSettle = !selectedNode && !selectedEdge && !selectedFamily && !userMoved;
      if (fitPendingAfterSettle) {
        flight = null;
        if (!reduceMotion) fit();
      }
      updateSummary();
      renderPanel();
      requestDraw();
    });
    toggles.appendChild(b);
  });

  // ---- layout simulation ---------------------------------------------------
  function tick() {
    var i, j, a, b, dx, dy, d2, f;
    var activeNodes = activeNodesList;
    var mLen = activeNodes.length;
    if (mLen > 1) {
      if (xOrderNeedsInit) {
        for (i = 0; i < mLen; i++) xOrder[i] = i;
        xOrder.subarray(0, mLen).sort(function (ia, ib) { return activeNodes[ia].x - activeNodes[ib].x; });
        xOrderNeedsInit = false;
      } else {
        for (i = 1; i < mLen; i++) {
          var idx = xOrder[i];
          var xVal = activeNodes[idx].x;
          j = i - 1;
          while (j >= 0 && activeNodes[xOrder[j]].x > xVal) {
            xOrder[j + 1] = xOrder[j];
            j--;
          }
          xOrder[j + 1] = idx;
        }
      }
      var minCellX = 2147483647, maxCellX = -2147483648;
      var minCellY = 2147483647, maxCellY = -2147483648;
      for (i = 0; i < mLen; i++) {
        a = activeNodes[i];
        var cx0 = Math.floor(a.x / 300) | 0;
        var cy0 = Math.floor(a.y / 300) | 0;
        cellX[i] = cx0;
        cellY[i] = cy0;
        if (cx0 < minCellX) minCellX = cx0;
        if (cx0 > maxCellX) maxCellX = cx0;
        if (cy0 < minCellY) minCellY = cy0;
        if (cy0 > maxCellY) maxCellY = cy0;
      }
      var cols = maxCellX - minCellX + 3;
      var rows = maxCellY - minCellY + 3;
      var totalCells = cols * rows;
      var repAlpha = 1400 * alpha;
      if (totalCells <= 65536) {
        if (gridCounts.length < totalCells + 1) {
          gridCounts = new Int32Array(totalCells + 1);
          gridStarts = new Int32Array(totalCells + 1);
          gridWrite = new Int32Array(totalCells + 1);
          nonEmptyCells = new Int32Array(totalCells + 1);
        } else {
          gridCounts.fill(0, 0, totalCells + 1);
        }
        for (i = 0; i < mLen; i++) {
          var cIdx = (cellY[i] - minCellY + 1) * cols + (cellX[i] - minCellX + 1);
          nodeCell[i] = cIdx;
          gridCounts[cIdx]++;
        }
        var sum = 0, nonEmptyCount = 0;
        for (var c = 0; c < totalCells; c++) {
          gridStarts[c] = sum;
          gridWrite[c] = sum;
          var cnt = gridCounts[c];
          if (cnt > 0) nonEmptyCells[nonEmptyCount++] = c;
          sum += cnt;
        }
        gridStarts[totalCells] = sum;
        for (var k = 0; k < mLen; k++) {
          var nIdx = xOrder[k];
          var cell = nodeCell[nIdx];
          sortedNode[gridWrite[cell]++] = nIdx;
        }
        for (var nc = 0; nc < nonEmptyCount; nc++) {
          var cCell = nonEmptyCells[nc];
          var startA = gridStarts[cCell];
          var endA = gridStarts[cCell + 1];
          var endARight = gridStarts[cCell + 2];
          var startBottom = gridStarts[cCell + cols - 1];
          var endBottom = gridStarts[cCell + cols + 2];
          var jStartBottom = startBottom;
          for (i = startA; i < endA; i++) {
            a = activeNodes[sortedNode[i]];
            var maxX = a.x + 300;
            for (j = i + 1; j < endARight; j++) {
              b = activeNodes[sortedNode[j]];
              if (b.x > maxX) break;
              dx = b.x - a.x; dy = b.y - a.y;
              d2 = dx * dx + dy * dy;
              if (d2 > 90000) continue;
              if (d2 < 1) { var jit = pairJitter(a.i, b.i); dx = jit.dx; dy = jit.dy; d2 = 1; }
              f = repAlpha / d2;
              a.vx -= dx * f; a.vy -= dy * f;
              b.vx += dx * f; b.vy += dy * f;
            }
            if (jStartBottom < endBottom) {
              var minX = a.x - 300;
              while (jStartBottom < endBottom && activeNodes[sortedNode[jStartBottom]].x < minX) jStartBottom++;
              for (j = jStartBottom; j < endBottom; j++) {
                b = activeNodes[sortedNode[j]];
                if (b.x > maxX) break;
                dx = b.x - a.x; dy = b.y - a.y;
                d2 = dx * dx + dy * dy;
                if (d2 > 90000) continue;
                if (d2 < 1) { var jit2 = pairJitter(a.i, b.i); dx = jit2.dx; dy = jit2.dy; d2 = 1; }
                f = repAlpha / d2;
                a.vx -= dx * f; a.vy -= dy * f;
                b.vx += dx * f; b.vy += dy * f;
              }
            }
          }
        }
      } else {
        for (i = 0; i < mLen; i++) {
          a = activeNodes[xOrder[i]];
          var maxSweepX = a.x + 300;
          for (j = i + 1; j < mLen; j++) {
            b = activeNodes[xOrder[j]];
            if (b.x > maxSweepX) break;
            dx = b.x - a.x; dy = b.y - a.y;
            d2 = dx * dx + dy * dy;
            if (d2 > 90000) continue;
            if (d2 < 1) { var jit3 = pairJitter(a.i, b.i); dx = jit3.dx; dy = jit3.dy; d2 = 1; }
            f = repAlpha / d2;
            a.vx -= dx * f; a.vy -= dy * f;
            b.vx += dx * f; b.vy += dy * f;
          }
        }
      }
    }
    for (i = 0; i < visibleEdgesList.length; i++) {
      var e = visibleEdgesList[i];
      dx = e.t.x - e.s.x; dy = e.t.y - e.s.y;
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      var strength = Math.max(e.d.confidence, e.d.reverseConfidence);
      var rest = 50 + (1 - strength) * 90 + e.s.r + e.t.r;
      f = ((d - rest) / d) * 0.05 * alpha * (0.4 + strength);
      e.s.vx += dx * f; e.s.vy += dy * f;
      e.t.vx -= dx * f; e.t.vy -= dy * f;
    }
    dirList.forEach(function (d) { d.cx = 0; d.cy = 0; d.count = 0; });
    activeNodes.forEach(function (n) { var d = dirs[n.dir]; d.cx += n.x; d.cy += n.y; d.count++; });
    activeNodes.forEach(function (n) {
      var d = dirs[n.dir];
      n.vx += (d.cx / d.count - n.x) * 0.012 * alpha - n.x * 0.012 * alpha;
      n.vy += (d.cy / d.count - n.y) * 0.012 * alpha - n.y * 0.012 * alpha;
      if (n.pinned) { n.vx = 0; n.vy = 0; return; }
      n.vx *= 0.62; n.vy *= 0.62;
      n.x += n.vx; n.y += n.vy;
    });
    alpha *= 0.985;
    tickCount++;
    if (tickCount >= 400) alpha = 0;
  }

  // ---- camera --------------------------------------------------------------
  var cam = { x: 0, y: 0, scale: 1 };
  var size = { w: 0, h: 0, dpr: 1 };
  function resizeNow() {
    var rect = canvas.getBoundingClientRect();
    var rw = rect.width > 0 ? rect.width : (canvas.clientWidth || 800);
    var rh = rect.height > 0 ? rect.height : (canvas.clientHeight || 600);
    var maxScale = Math.sqrt(16000000 / Math.max(1, rw * rh));
    var dpr = Math.min(window.devicePixelRatio || 1, 2, maxScale);
    size.dpr = dpr;
    size.w = rw; size.h = rh;
    canvas.width = Math.round(rw * dpr);
    canvas.height = Math.round(rh * dpr);
    requestDraw();
  }
  function bounds(list) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    list.forEach(function (n) {
      minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r);
      minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r);
    });
    var w = Math.max(1, size.w);
    var h = Math.max(1, size.h);
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale: Math.max(0.2, Math.min(2.2, Math.min(w / Math.max(1, maxX - minX + 160), h / Math.max(1, maxY - minY + 160)))) };
  }
  function fit() {
    var list = activeNodesList;
    if (list.length === 0) return;
    var b = bounds(list);
    cam.x = b.x; cam.y = b.y; cam.scale = b.scale;
  }
  var flight = null;
  function flyTo(list) {
    if (list.length === 0) return;
    var b = bounds(list);
    b.scale = Math.min(b.scale, 2);
    if (reduceMotion) { cam.x = b.x; cam.y = b.y; cam.scale = b.scale; requestDraw(); return; }
    flight = { from: { x: cam.x, y: cam.y, scale: cam.scale }, to: b, start: performance.now() };
    requestDraw();
  }
  function stepFlight(now) {
    if (!flight) return false;
    var t = Math.min(1, (now - flight.start) / 450);
    var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    cam.x = flight.from.x + (flight.to.x - flight.from.x) * e;
    cam.y = flight.from.y + (flight.to.y - flight.from.y) * e;
    cam.scale = flight.from.scale + (flight.to.scale - flight.from.scale) * e;
    if (t >= 1) flight = null;
    return true;
  }
  var userMoved = false;
  function toWorld(px, py) {
    return { x: (px - size.w / 2) / cam.scale + cam.x, y: (py - size.h / 2) / cam.scale + cam.y };
  }

  // ---- selection -----------------------------------------------------------
  var selectedNode = null, selectedEdge = null, selectedFamily = null, hoverNode = null, hoverEdge = null, hoverFamily = null, matches = null;
  var returnToFamily = null, expandedFamilyPairKey = null;
  var overviewTab = 'ghost';
  var overviewExpanded = false;
  var animPaused = false;

  function isVisible(e) { return visible[e.d.relationship]; }
  function isActive(n) { return Boolean(n.active); }

  function getActiveFamilyViews(fam) {
    if (!fam) return [];
    var activeEdges = fam.edges.filter(isVisible);
    var activeUndrawn = (fam.undrawnPairs || []).filter(function (up) {
      return Boolean(visible[up.relationship]);
    });
    if (activeEdges.length + activeUndrawn.length < 2) return [];
    var adj = Object.create(null);
    fam.members.forEach(function (m) { adj[m.path] = []; });
    activeEdges.forEach(function (e) {
      if (adj[e.s.path] && adj[e.t.path]) {
        adj[e.s.path].push(e.t.path);
        adj[e.t.path].push(e.s.path);
      }
    });
    activeUndrawn.forEach(function (up) {
      if (adj[up.from] && adj[up.to]) {
        adj[up.from].push(up.to);
        adj[up.to].push(up.from);
      }
    });
    var memberIdxByPath = Object.create(null);
    fam.members.forEach(function (m, idx) { memberIdxByPath[m.path] = idx; });

    var visited = Object.create(null);
    var views = [];
    fam.members.forEach(function (m) {
      if (visited[m.path] || !adj[m.path] || adj[m.path].length === 0) return;
      var compPaths = Object.create(null);
      var queue = [m.path];
      visited[m.path] = true;
      compPaths[m.path] = true;
      for (var q = 0; q < queue.length; q++) {
        var cur = queue[q];
        var nbrs = adj[cur] || [];
        for (var k = 0; k < nbrs.length; k++) {
          var nxt = nbrs[k];
          if (!visited[nxt]) {
            visited[nxt] = true;
            compPaths[nxt] = true;
            queue.push(nxt);
          }
        }
      }
      var compMembers = fam.members.filter(function (mem) { return Boolean(compPaths[mem.path]); });
      if (compMembers.length < 3) return;
      var compEdges = activeEdges.filter(function (e) { return Boolean(compPaths[e.s.path] && compPaths[e.t.path]); });
      var compUndrawn = activeUndrawn.filter(function (up) { return Boolean(compPaths[up.from] && compPaths[up.to]); });
      var qualifyingPairs = compEdges.length + compUndrawn.length;
      if (qualifyingPairs < 2) return;
      var possiblePairs = (compMembers.length * (compMembers.length - 1)) / 2;
      var isSubset = compMembers.length < fam.members.length || qualifyingPairs < fam.d.qualifyingPairs;

      var compNodes = [];
      compMembers.forEach(function (mem) {
        var n = typeof mem.nodeIndex === 'number' && nodes[mem.nodeIndex] ? nodes[mem.nodeIndex] : nodeByPath[mem.path];
        if (n) compNodes.push(n);
      });

      var commitsTouchingTwoOrMore = fam.d.commitsTouchingTwoOrMore;
      var commitsTouchingAll = fam.d.commitsTouchingAll;
      var lastTogether = fam.d.lastTogether;
      var activeEvidence = fam.d.evidence || [];

      if (isSubset) {
        var compIdxSet = Object.create(null);
        compMembers.forEach(function (mem) {
          var mi = memberIdxByPath[mem.path];
          if (typeof mi === 'number') compIdxSet[mi] = true;
        });
        var activePairIdxSet = Object.create(null);
        var activePairPathSet = Object.create(null);
        function addActivePair(pA, pB) {
          activePairPathSet[edgeKey(pA, pB)] = true;
          var ia = memberIdxByPath[pA];
          var ib = memberIdxByPath[pB];
          if (typeof ia === 'number' && typeof ib === 'number') {
            var lo = ia < ib ? ia : ib;
            var hi = ia < ib ? ib : ia;
            activePairIdxSet[lo + ':' + hi] = true;
          }
        }
        compEdges.forEach(function (e) { addActivePair(e.s.path, e.t.path); });
        compUndrawn.forEach(function (up) { addActivePair(up.from, up.to); });

        var evByHash = Object.create(null);
        var evOrder = [];
        function collectEv(ev, extraPaths) {
          if (!ev || !ev.hash) return;
          var rec = evByHash[ev.hash];
          if (!rec) {
            rec = { hash: ev.hash, date: ev.date || '', author: ev.author || '', subject: ev.subject || '', pathMap: Object.create(null) };
            evByHash[ev.hash] = rec;
            evOrder.push(rec);
          }
          (ev.memberPaths || []).forEach(function (p) {
            if (compPaths[p]) rec.pathMap[p] = true;
          });
          (extraPaths || []).forEach(function (p) {
            if (compPaths[p]) rec.pathMap[p] = true;
          });
        }
        (fam.d.evidence || []).forEach(function (ev) { collectEv(ev); });
        (fam.d.allMemberEvidence || []).forEach(function (ev) { collectEv(ev); });
        compEdges.forEach(function (e) {
          (e.d.evidence || []).forEach(function (ev) { collectEv(ev, [e.s.path, e.t.path]); });
        });
        compUndrawn.forEach(function (up) {
          (up.evidence || []).forEach(function (ev) { collectEv(ev, [up.from, up.to]); });
        });

        var filteredEv = [];
        evOrder.forEach(function (rec) {
          var paths = compMembers.map(function (mem) { return mem.path; }).filter(function (p) { return Boolean(rec.pathMap[p]); });
          if (paths.length < 2) return;
          var hasActivePair = false;
          for (var a = 0; a < paths.length && !hasActivePair; a++) {
            for (var b = a + 1; b < paths.length; b++) {
              if (activePairPathSet[edgeKey(paths[a], paths[b])]) {
                hasActivePair = true;
                break;
              }
            }
          }
          if (!hasActivePair) return;
          filteredEv.push({
            hash: rec.hash,
            date: rec.date,
            author: rec.author,
            subject: rec.subject,
            membersTouched: paths.length,
            totalMembers: compMembers.length,
            touchesAllMembers: paths.length === compMembers.length,
            memberPaths: paths
          });
        });
        filteredEv.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
        activeEvidence = filteredEv.slice(0, 5);

        if (fam.d.commitMemberIndices && fam.d.commitMemberIndices.length > 0) {
          commitsTouchingTwoOrMore = 0;
          commitsTouchingAll = 0;
          fam.d.commitMemberIndices.forEach(function (mIndices) {
            var activeIdxs = (mIndices || []).filter(function (idx) { return Boolean(compIdxSet[idx]); });
            if (activeIdxs.length < 2) return;
            var hasPair = false;
            for (var i = 0; i < activeIdxs.length && !hasPair; i++) {
              for (var j = i + 1; j < activeIdxs.length; j++) {
                var lo = activeIdxs[i] < activeIdxs[j] ? activeIdxs[i] : activeIdxs[j];
                var hi = activeIdxs[i] < activeIdxs[j] ? activeIdxs[j] : activeIdxs[i];
                if (activePairIdxSet[lo + ':' + hi]) {
                  hasPair = true;
                  break;
                }
              }
            }
            if (!hasPair) return;
            commitsTouchingTwoOrMore++;
            if (activeIdxs.length === compMembers.length) commitsTouchingAll++;
          });
        } else {
          commitsTouchingTwoOrMore = filteredEv.length;
          commitsTouchingAll = filteredEv.filter(function (ev) { return ev.touchesAllMembers; }).length;
        }
        if (activeEvidence.length > 0 && activeEvidence[0].date) {
          lastTogether = activeEvidence[0].date;
        }
      }

      views.push({
        id: fam.d.id + ':' + compMembers.map(function (mem) { return mem.path; }).join(','),
        d: fam.d,
        family: fam,
        members: compMembers,
        nodes: compNodes,
        nodeSet: new Set(compNodes),
        edges: compEdges,
        edgeSet: new Set(compEdges),
        undrawnPairs: compUndrawn,
        qualifyingPairs: qualifyingPairs,
        possiblePairs: possiblePairs,
        commitsTouchingTwoOrMore: commitsTouchingTwoOrMore,
        commitsTouchingAll: commitsTouchingAll,
        lastTogether: lastTogether,
        evidence: activeEvidence,
        isSubset: isSubset
      });
    });
    return views;
  }

  function resolveActiveFamilyView(sel) {
    if (!sel) return null;
    if (sel._isFallbackView) return sel;
    var baseFam = sel.family || sel;
    var views = getActiveFamilyViews(baseFam);
    if (views.length === 0) return null;
    if (sel.id) {
      for (var i = 0; i < views.length; i++) {
        if (views[i].id === sel.id) return views[i];
      }
      if (sel.members && sel.members.length > 0) {
        var targetPath = sel.members[0].path;
        for (var j = 0; j < views.length; j++) {
          if (views[j].members.some(function (m) { return m.path === targetPath; })) return views[j];
        }
      }
    }
    return views[0];
  }

  function focusEdge(e, activeFam) {
    if (selectedEdge) return e === selectedEdge;
    if (hoverEdge) return e === hoverEdge;
    var fam = activeFam !== undefined ? activeFam : resolveActiveFamilyView(hoverFamily || selectedFamily);
    if (fam) return fam.edgeSet ? fam.edgeSet.has(e) : fam.edges.indexOf(e) >= 0;
    if (selectedNode) return e.s === selectedNode || e.t === selectedNode;
    return true;
  }
  function focusNode(n, activeFam) {
    if (selectedEdge) return n === selectedEdge.s || n === selectedEdge.t;
    if (hoverEdge) return n === hoverEdge.s || n === hoverEdge.t;
    var fam = activeFam !== undefined ? activeFam : resolveActiveFamilyView(hoverFamily || selectedFamily);
    if (fam) return fam.nodeSet ? fam.nodeSet.has(n) : fam.nodes.indexOf(n) >= 0;
    if (selectedNode) return n === selectedNode || n.edges.some(function (e) { return isVisible(e) && (e.s === selectedNode || e.t === selectedNode); });
    if (matches) return matches.indexOf(n) >= 0;
    return true;
  }
  function isGhostFocused(e, activeFam) {
    if (e.d.relationship !== 'ghost' || !visible.ghost) return false;
    if (selectedEdge) return e === selectedEdge;
    if (hoverEdge) return e === hoverEdge;
    var fam = activeFam !== undefined ? activeFam : resolveActiveFamilyView(hoverFamily || selectedFamily);
    if (fam) return fam.edgeSet ? fam.edgeSet.has(e) : fam.edges.indexOf(e) >= 0;
    if (selectedNode) return e.s === selectedNode || e.t === selectedNode;
    if (hoverNode) return e.s === hoverNode || e.t === hoverNode;
    return false;
  }
  function hasFocusedGhostWire() {
    if (!visible.ghost) return false;
    var activeFam = resolveActiveFamilyView(hoverFamily || selectedFamily);
    var ghostEdges = edgesByKind.ghost || [];
    for (var i = 0; i < ghostEdges.length; i++) {
      if (isGhostFocused(ghostEdges[i], activeFam)) return true;
    }
    return false;
  }

  // ---- drawing -------------------------------------------------------------
  var dashPhase = 0, drawQueued = false, dirty = true, lastMarch = 0, marchTimer = null;
  var labelWidthCache = new Map();
  var lastZoomBucket = '';
  function measureLabelWidth(label, zoomBucket) {
    if (zoomBucket !== lastZoomBucket) {
      labelWidthCache.clear();
      lastZoomBucket = zoomBucket;
    }
    var w = labelWidthCache.get(label);
    if (w === undefined) {
      w = ctx.measureText(label).width;
      labelWidthCache.set(label, w);
    }
    return w;
  }
  function cancelMarchTimer() {
    if (marchTimer !== null) {
      clearTimeout(marchTimer);
      marchTimer = null;
    }
  }
  function scheduleMarch(now) {
    if (marchTimer !== null || drawQueued) return;
    var elapsed = now - lastMarch;
    var delay = Math.max(4, Math.ceil(83.34 - elapsed));
    marchTimer = setTimeout(function () {
      marchTimer = null;
      if (drawQueued) return;
      drawQueued = true;
      requestAnimationFrame(frame);
    }, delay);
  }
  function requestDraw() {
    dirty = true;
    if (drawQueued) return;
    cancelMarchTimer();
    drawQueued = true;
    requestAnimationFrame(frame);
  }
  function frame() {
    drawQueued = false;
    var ts = performance.now();
    var didSimStep = false;
    var isDraggingNode = Boolean(drag && drag.node && drag.moved);
    if (alpha > 0.02) {
      if (deferSimOneFrame && !isDraggingNode) {
        deferSimOneFrame = false;
        requestDraw();
        return;
      } else {
        deferSimOneFrame = false;
        var sliceStart = ts;
        var steps = 0;
        var maxSteps = (reduceMotion && !isDraggingNode) ? 400 : 6;
        var budgetMs = 8;
        while (alpha > 0.02 && steps < maxSteps && (steps === 0 || performance.now() - sliceStart < budgetMs)) {
          tick();
          steps++;
        }
        didSimStep = steps > 0;
        if (alpha <= 0.02 && fitPendingAfterSettle) {
          fitPendingAfterSettle = false;
          if (!userMoved && !selectedNode && !selectedEdge && !selectedFamily) fit();
        }
        if (reduceMotion && didSimStep && !(drag && drag.node && drag.moved)) {
          requestDraw();
          return;
        }
      }
    }
    var flying = stepFlight(ts);
    var marching = !animPaused && !reduceMotion && !document.hidden && hasFocusedGhostWire();
    if (!marching) cancelMarchTimer();
    var marched = false;
    if (marching && ts - lastMarch >= 83.33) {
      dashPhase = (dashPhase + 1.75) % 1100;
      lastMarch = ts;
      marched = true;
    }
    if (dirty || didSimStep || flying || marched) {
      dirty = false;
      draw();
    }
    if (alpha > 0.02 || flying) {
      cancelMarchTimer();
      requestDraw();
    } else if (marching) {
      scheduleMarch(performance.now());
    }
  }

  function draw() {
    var dpr = size.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#13304f';
    ctx.fillRect(0, 0, size.w, size.h);

    var step = 80 * cam.scale;
    if (step > 14) {
      var origin = { x: size.w / 2 - cam.x * cam.scale, y: size.h / 2 - cam.y * cam.scale };
      ctx.strokeStyle = 'rgba(159, 180, 204, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var gx = ((origin.x % step) + step) % step; gx < size.w; gx += step) { ctx.moveTo(Math.round(gx) + 0.5, 0); ctx.lineTo(Math.round(gx) + 0.5, size.h); }
      for (var gy = ((origin.y % step) + step) % step; gy < size.h; gy += step) { ctx.moveTo(0, Math.round(gy) + 0.5); ctx.lineTo(size.w, Math.round(gy) + 0.5); }
      ctx.stroke();
    }

    var k = cam.scale;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (size.w / 2 - cam.x * k), dpr * (size.h / 2 - cam.y * k));

    var activeFam = resolveActiveFamilyView(hoverFamily || selectedFamily);
    ['test', 'direct', 'indirect', 'unknown', 'ghost'].forEach(function (kind) {
      if (!visible[kind]) return;
      var kindEdges = edgesByKind[kind] || [];
      for (var ei = 0; ei < kindEdges.length; ei++) {
        var e = kindEdges[ei];
        var focused = focusEdge(e, activeFam);
        var baseWidth = (0.8 + Math.max(e.d.confidence, e.d.reverseConfidence) * 2.2) / k;
        ctx.beginPath();
        ctx.moveTo(e.s.x, e.s.y);
        ctx.lineTo(e.t.x, e.t.y);
        if (kind === 'ghost') {
          var ghostFocused = isGhostFocused(e, activeFam);
          if (ghostFocused) {
            ctx.setLineDash([]);
            ctx.lineDashOffset = 0;
            ctx.strokeStyle = '#ff4f9a';
            ctx.globalAlpha = 0.25;
            ctx.lineWidth = baseWidth + 5 / k;
            ctx.stroke();
          }
          ctx.globalAlpha = focused ? 1 : 0.06;
          ctx.strokeStyle = KINDS[kind].color;
          ctx.lineWidth = baseWidth;
          ctx.setLineDash([7 / k, 6 / k]);
          ctx.lineDashOffset = ghostFocused ? -dashPhase / k : 0;
        } else {
          ctx.globalAlpha = focused ? 1 : 0.06;
          ctx.strokeStyle = KINDS[kind].color;
          ctx.lineWidth = baseWidth;
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;
          if (kind === 'unknown') {
            ctx.setLineDash([2 / k, 5 / k]);
          } else if (kind === 'indirect') {
            ctx.setLineDash([10 / k, 4 / k]);
          } else if (kind === 'test') {
            ctx.globalAlpha *= 0.7;
          }
        }
        ctx.stroke();
      }
    });
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    activeNodesList.forEach(function (n) {
      var focused = focusNode(n, activeFam);
      ctx.globalAlpha = focused ? 1 : 0.14;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.lineWidth = Math.max(1 / k, 1.2);
      var isTargetEndpoint = (selectedEdge && (n === selectedEdge.s || n === selectedEdge.t)) ||
                             (hoverEdge && (n === hoverEdge.s || n === hoverEdge.t)) ||
                             (activeFam && (activeFam.nodeSet ? activeFam.nodeSet.has(n) : activeFam.nodes.indexOf(n) >= 0));
      ctx.strokeStyle = n === selectedNode ? '#ff4f9a' : (isTargetEndpoint ? '#ff4f9a' : 'rgba(14, 37, 64, 0.9)');
      if (n === selectedNode || isTargetEndpoint) ctx.lineWidth = 3 / Math.sqrt(k);
      ctx.stroke();
    });

    ctx.globalAlpha = 1;
    ctx.font = (12.5 / k) + 'px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    var zoomBucket = k.toFixed(3);
    var labelBoxes = [];
    nodes.forEach(function (n) {
      var overview = !selectedNode && !selectedEdge && !selectedFamily && !hoverEdge && !hoverFamily && !matches;
      var wanted = n === hoverNode || n === selectedNode || (matches && matches.indexOf(n) >= 0) ||
        ((selectedNode || selectedEdge || selectedFamily || hoverEdge || hoverFamily) && focusNode(n, activeFam)) ||
        (overview && (n.r * k > 9 || (visible.ghost && overviewLabelNodes[n.i])));
      if (!wanted || !isActive(n)) return;
      var label = overviewLabelNodes[n.i] || getNodeLabel(n);
      var x = n.x + n.r + 5 / k;
      var labelW = measureLabelWidth(label, zoomBucket);
      var labelBox = { left: x - 2 / k, right: x + labelW + 2 / k, top: n.y - 8 / k, bottom: n.y + 8 / k };
      if (overview && labelBoxes.some(function (box) {
        return labelBox.left < box.right && labelBox.right > box.left && labelBox.top < box.bottom && labelBox.bottom > box.top;
      })) return;
      labelBoxes.push(labelBox);
      ctx.lineWidth = 4 / k;
      ctx.strokeStyle = 'rgba(19, 48, 79, 0.94)';
      ctx.strokeText(label, x, n.y);
      ctx.fillStyle = '#e8eef5';
      ctx.fillText(label, x, n.y);
    });

    if (nodes.length === 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#9fb4cc';
      ctx.font = '15px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Nothing passed the thresholds yet. Re-run with --min-shared 2 to see weaker links.', size.w / 2, size.h / 2);
      ctx.textAlign = 'start';
    }
  }

  // ---- hit testing ---------------------------------------------------------
  function nodeAt(p) {
    for (var i = nodes.length - 1; i >= 0; i--) {
      var n = nodes[i];
      if (!isActive(n)) continue;
      var dx = p.x - n.x, dy = p.y - n.y, r = n.r + 3 / cam.scale;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }
  function edgeAt(p) {
    var best = null, bestD = 6 / cam.scale;
    edges.forEach(function (e) {
      if (!isVisible(e)) return;
      var ax = e.s.x, ay = e.s.y, bx = e.t.x, by = e.t.y;
      var vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy || 1;
      var t = Math.max(0, Math.min(1, ((p.x - ax) * vx + (p.y - ay) * vy) / len2));
      var dx = p.x - (ax + t * vx), dy = p.y - (ay + t * vy), d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestD) { bestD = d; best = e; }
    });
    return best;
  }

  // ---- pointer interaction -------------------------------------------------
  var drag = null;
  var activeTouches = new Map();
  var pinchState = null;
  var pinchMoved = false;
  function isStackedTouch(ev) {
    return ev.pointerType === 'touch' && window.innerWidth <= 960;
  }
  canvas.addEventListener('pointerdown', function (ev) {
    var rect = canvas.getBoundingClientRect();
    var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    if (ev.pointerType === 'touch') {
      updateTouchHint();
      activeTouches.set(ev.pointerId, {
        x: px, y: py, clientX: ev.clientX, clientY: ev.clientY, startX: px, startY: py
      });
      if (activeTouches.size === 2) {
        drag = null;
        pinchMoved = true;
        canvas.classList.remove('dragging');
        activeTouches.forEach(function (_, pid) {
          try { canvas.setPointerCapture(pid); } catch (_) {}
        });
        var pts = Array.from(activeTouches.values());
        pinchState = {
          midX: (pts[0].x + pts[1].x) / 2,
          midY: (pts[0].y + pts[1].y) / 2,
          dist: Math.max(1, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y))
        };
        return;
      }
      if (activeTouches.size > 2) return;
      if (isStackedTouch(ev)) {
        var tn = nodeAt(toWorld(px, py));
        drag = { node: tn, startX: px, startY: py, lastX: px, lastY: py, moved: false, stackedSingleTouch: true };
        return;
      }
    }
    var n = nodeAt(toWorld(px, py));
    drag = { node: n, startX: px, startY: py, lastX: px, lastY: py, moved: false, stackedSingleTouch: false };
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', function (ev) {
    var rect = canvas.getBoundingClientRect();
    var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    if (ev.pointerType === 'touch' && activeTouches.has(ev.pointerId)) {
      var prevTouch = activeTouches.get(ev.pointerId);
      prevTouch.x = px; prevTouch.y = py;
      prevTouch.clientX = ev.clientX; prevTouch.clientY = ev.clientY;
      if (activeTouches.size === 2 && pinchState) {
        var pts = Array.from(activeTouches.values());
        var newMidX = (pts[0].x + pts[1].x) / 2;
        var newMidY = (pts[0].y + pts[1].y) / 2;
        var newDist = Math.max(1, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
        userMoved = true; flight = null;
        var before = toWorld(newMidX, newMidY);
        cam.scale = Math.max(0.15, Math.min(6, cam.scale * (newDist / pinchState.dist)));
        var after = toWorld(newMidX, newMidY);
        cam.x += before.x - after.x - (newMidX - pinchState.midX) / cam.scale;
        cam.y += before.y - after.y - (newMidY - pinchState.midY) / cam.scale;
        pinchState.midX = newMidX;
        pinchState.midY = newMidY;
        pinchState.dist = newDist;
        tooltip.hidden = true;
        requestDraw();
        return;
      }
      if (drag && drag.stackedSingleTouch) {
        if (Math.abs(px - drag.startX) + Math.abs(py - drag.startY) > 6) {
          drag.moved = true;
        }
        drag.lastX = px; drag.lastY = py;
        return;
      }
    }
    if (drag) {
      if (Math.abs(px - drag.startX) + Math.abs(py - drag.startY) > 4) drag.moved = true;
      if (drag.node && drag.moved) {
        var w = toWorld(px, py);
        drag.node.x = w.x; drag.node.y = w.y; drag.node.pinned = true;
        alpha = Math.max(alpha, 0.25);
        tickCount = 0;
      } else if (drag.moved) {
        userMoved = true; flight = null;
        cam.x -= (px - drag.lastX) / cam.scale;
        cam.y -= (py - drag.lastY) / cam.scale;
      }
      drag.lastX = px; drag.lastY = py;
      tooltip.hidden = true;
      requestDraw();
      return;
    }
    var p = toWorld(px, py);
    var n = nodeAt(p);
    var e = n ? null : edgeAt(p);
    canvas.classList.toggle('pointing', Boolean(n || e));
    if (n !== hoverNode) { hoverNode = n; requestDraw(); }
    if (n || e) {
      tooltip.textContent = '';
      if (n) {
        tooltip.appendChild(el('code', '', n.path));
        tooltip.appendChild(el('div', '', 'Folder: ' + n.dir));
        tooltip.appendChild(el('div', '', 'Changed in ' + plural(n.changes, 'commit')));
      } else {
        var labels = distinguishingPaths(e.s.path, e.t.path);
        tooltip.appendChild(el('div', '', KINDS[e.d.relationship].label.replace(/s$/, '') + ': ' + labels[0] + ' and ' + labels[1]));
        tooltip.appendChild(el('div', '', directionEvidence(e, true)));
      }
      tooltip.hidden = false;
      var left = Math.min(px + 14, size.w - tooltip.offsetWidth - 8);
      tooltip.style.left = Math.max(8, left) + 'px';
      tooltip.style.top = (py + 14) + 'px';
    } else {
      tooltip.hidden = true;
    }
  });
  function endDrag(ev) {
    if (ev.pointerType === 'touch') {
      activeTouches.delete(ev.pointerId);
      if (activeTouches.size < 2) pinchState = null;
      if (pinchMoved) {
        if (activeTouches.size === 0) pinchMoved = false;
        drag = null;
        return;
      }
    }
    if (!drag) return;
    canvas.classList.remove('dragging');
    if (!drag.moved) {
      var rect = canvas.getBoundingClientRect();
      var p = toWorld(ev.clientX - rect.left, ev.clientY - rect.top);
      var n = nodeAt(p);
      if (n) selectNode(n);
      else {
        var e = edgeAt(p);
        if (e) selectEdge(e); else clearSelection();
      }
    }
    drag = null;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', function (ev) {
    if (ev.pointerType === 'touch') {
      activeTouches.delete(ev.pointerId);
      if (activeTouches.size < 2) pinchState = null;
      if (activeTouches.size === 0) pinchMoved = false;
    }
    drag = null;
    canvas.classList.remove('dragging');
  });
  canvas.addEventListener('pointerleave', function () { if (!drag) { tooltip.hidden = true; if (hoverNode) { hoverNode = null; requestDraw(); } } });
  window.addEventListener('blur', function () {
    activeTouches.clear();
    pinchState = null;
    pinchMoved = false;
    drag = null;
    canvas.classList.remove('dragging');
  });
  canvas.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    userMoved = true; flight = null;
    var rect = canvas.getBoundingClientRect();
    var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    var before = toWorld(px, py);
    cam.scale = Math.max(0.15, Math.min(6, cam.scale * Math.exp(-ev.deltaY * 0.0015)));
    var after = toWorld(px, py);
    cam.x += before.x - after.x; cam.y += before.y - after.y;
    requestDraw();
  }, { passive: false });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      if ((selectedEdge || selectedNode) && returnToFamily && resolveActiveFamilyView(returnToFamily)) {
        selectFamily(returnToFamily, true);
      } else {
        if (search.value || matches) {
          search.value = '';
          matches = null;
        }
        clearSelection();
        search.blur();
      }
    }
    if (ev.key === '/' && document.activeElement !== search) { ev.preventDefault(); search.focus(); }
  });
  search.addEventListener('input', function () {
    var q = search.value.trim().toLowerCase();
    matches = q ? nodes.filter(function (n) { return n.path.toLowerCase().indexOf(q) >= 0; }) : null;
    requestDraw();
  });
  search.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && matches && matches.length > 0) { selectNode(matches[0]); }
  });

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      userMoved = false; flight = null;
      clearSelection();
      fit(); requestDraw();
    });
  }
  var toggleAnimBtn = document.getElementById('toggle-anim');
  if (toggleAnimBtn) {
    toggleAnimBtn.addEventListener('click', function () {
      animPaused = !animPaused;
      toggleAnimBtn.textContent = animPaused ? 'Resume animation' : 'Pause animation';
      requestDraw();
    });
  }

  function selectNode(n, fromFamily) {
    if (fromFamily !== undefined) {
      returnToFamily = fromFamily;
    } else if (selectedFamily) {
      var activeView = resolveActiveFamilyView(selectedFamily);
      returnToFamily = activeView && activeView.nodes.indexOf(n) >= 0 ? activeView : null;
    } else if (returnToFamily) {
      var prevView = resolveActiveFamilyView(returnToFamily);
      returnToFamily = prevView && prevView.nodes.indexOf(n) >= 0 ? prevView : null;
    }
    selectedNode = n; selectedEdge = null; selectedFamily = null; hoverEdge = null; hoverFamily = null; matches = null; search.value = '';
    var group = [n];
    n.edges.forEach(function (e) { if (isVisible(e)) group.push(e.s === n ? e.t : e.s); });
    flyTo(group);
    renderPanel(); requestDraw();
  }
  function selectEdge(e, fromFamily) {
    if (fromFamily !== undefined) {
      returnToFamily = fromFamily;
    } else if (selectedFamily) {
      var activeView = resolveActiveFamilyView(selectedFamily);
      returnToFamily = activeView && activeView.edges.indexOf(e) >= 0 ? activeView : null;
    } else if (returnToFamily) {
      var prevView = resolveActiveFamilyView(returnToFamily);
      returnToFamily = prevView && prevView.edges.indexOf(e) >= 0 ? prevView : null;
    }
    selectedEdge = e; selectedNode = null; selectedFamily = null; hoverEdge = null; hoverFamily = null; matches = null; search.value = '';
    flyTo([e.s, e.t]);
    renderPanel(); requestDraw();
  }
  function selectFamily(fam, keepExpandedPair) {
    var view = resolveActiveFamilyView(fam);
    if (!view) return;
    selectedFamily = view; selectedNode = null; selectedEdge = null; returnToFamily = null; hoverEdge = null; hoverFamily = null; matches = null; search.value = '';
    if (!keepExpandedPair) expandedFamilyPairKey = null;
    flyTo(view.nodes);
    renderPanel();
    if (keepExpandedPair) {
      var targetFocus = panel._expandedPairSummary || panel._familyHeading;
      if (targetFocus && typeof targetFocus.focus === 'function') targetFocus.focus();
    }
    requestDraw();
  }
  function clearSelection() {
    selectedNode = null; selectedEdge = null; selectedFamily = null; hoverEdge = null; hoverFamily = null; returnToFamily = null; expandedFamilyPairKey = null;
    renderPanel(); requestDraw();
  }

  // ---- copy & clipboard helpers --------------------------------------------
  function copyText(text, button, successMsg) {
    var label = successMsg || 'Copied';
    function copied() {
      var original = button.dataset.origLabel || button.textContent;
      button.dataset.origLabel = original;
      if (button._copyTimer) clearTimeout(button._copyTimer);
      button.textContent = label;
      button.classList.add('copied');
      button._copyTimer = setTimeout(function () {
        button.textContent = original;
        button.classList.remove('copied');
        button._copyTimer = null;
      }, 1500);
    }
    function fallback() {
      var input = el('textarea');
      input.value = text; input.style.position = 'fixed'; input.style.opacity = '0';
      document.body.appendChild(input); input.select();
      try { if (document.execCommand('copy')) copied(); } catch (_) {}
      input.remove();
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(copied, fallback);
      return;
    }
    fallback();
  }

  function defuseMentions(text) {
    return String(text)
      .replace(/@([a-zA-Z0-9_-]+)/g, '@\u200B$1')
      .replace(/#([0-9]+)/g, '#\u200B$1');
  }

  function sanitizeMarkdown(text) {
    return defuseMentions(text)
      .replace(/[\r\n]+/g, ' ')
      .replace(/([\\<>[\]()*_~\x60])/g, '\\$1');
  }

  function shellQuoteArg(arg) {
    var s = String(arg == null ? '' : arg);
    if (/^[A-Za-z0-9_./-]+$/.test(s) && s.charAt(0) !== '-') return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  function fallbackExplainCommand(a, b) {
    return 'npx repo-archaeology explain ' + shellQuoteArg(a) + ' ' + shellQuoteArg(b);
  }

  function mdCode(text) {
    var q = String.fromCharCode(96);
    var s = defuseMentions(text).replace(/[\r\n]+/g, ' ');
    var fence = q;
    while (s.indexOf(fence) !== -1) fence += q;
    var needsPad = s.charAt(0) === q || s.charAt(s.length - 1) === q || s.charAt(0) === ' ' || s.charAt(s.length - 1) === ' ';
    var pad = needsPad ? ' ' : '';
    return fence + pad + s + pad + fence;
  }

  function formatFindingMarkdown(e) {
    var labels = distinguishingPaths(e.s.path, e.t.path);
    var kindName = findingLabel(e);
    var scope = e.d.crossesDirectories && !(e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation')
      ? ' Connects different parts of the project (' + mdCode(e.s.dir) + ' and ' + mdCode(e.t.dir) + ').'
      : '';
    var lines = [
      '### 🔍 Repo Archaeology: File Relationship Finding',
      '',
      '**Files:** ' + mdCode(e.s.path) + ' ↔ ' + mdCode(e.t.path) + '  ',
      '**Relationship:** ' + kindName + ' (' + plural(e.d.shared, 'shared commit') + ')  ',
      '**Last Together:** ' + relativeDate(e.d.lastTogether) + '  ',
      '',
      '**Directional Co-Change:**',
      '- ' + mdCode(labels[0]) + ' → ' + mdCode(labels[1]) + ': ' + directionEvidence(e, true),
      '- ' + mdCode(labels[1]) + ' → ' + mdCode(labels[0]) + ': ' + directionEvidence(e, false),
      '',
      '**Why It Matters:**',
      '- ' + sanitizeMarkdown(capitalize(e.d.why)) + '.' + scope,
      (e.d.relationship === 'ghost' ? '- No direct or supported indirect import relationship found in current code.' : '')
    ];
    if (e.d.verdict) {
      var vHead = e.d.verdict.kind === 'confirmed' ? 'Confirmed dependency' : 'Expected relationship';
      lines.push('- **' + vHead + ':** ' + sanitizeMarkdown(e.d.verdict.reason));
    }
    if (e.d.evidence && e.d.evidence.length > 0) {
      lines.push('', '**Supporting Commits:**');
      e.d.evidence.slice(0, 5).forEach(function (ev) {
        lines.push('- ' + mdCode(ev.hash.slice(0, 7)) + ' (' + ev.date + '): ' + sanitizeMarkdown(ev.subject));
      });
    }
    var cliCmd = e.d.explainCommand || fallbackExplainCommand(e.s.path, e.t.path);
    lines.push('', '**Inspect Diff Evidence:** ' + mdCode(cliCmd));
    return lines.filter(function (l) { return l !== undefined; }).join('\n');
  }

  function formatFamilyMarkdown(view) {
    var lines = [
      '### 🔍 Repo Archaeology: Related Implementation Family',
      '',
      '**Pattern:** ' + mdCode(view.d.label || view.d.id) + '  ',
      '**Members (' + view.members.length + ' files):** ' + view.members.map(function (m) { return mdCode(m.path); }).join(', ') + '  ',
      '**Pairwise Links:** ' + view.qualifyingPairs + ' of ' + view.possiblePairs + ' possible pairs passed thresholds  ',
      '**Family-Wide Commits:** ' + plural(view.commitsTouchingTwoOrMore, 'supporting commit') + ' (2+ members via a qualifying pair; ' + plural(view.commitsTouchingAll, 'commit') + ' touched all ' + view.members.length + ')  ',
      '**Last Together:** ' + relativeDate(view.lastTogether) + '  ',
      '',
      '**Qualifying Pairwise Relationships:**'
    ];
    view.edges.forEach(function (e) {
      var labels = distinguishingPaths(e.s.path, e.t.path);
      lines.push('- ' + mdCode(labels[0]) + ' ↔ ' + mdCode(labels[1]) + ': ' + plural(e.d.shared, 'shared commit') + ' (' + directionEvidence(e, true) + '; reverse ' + directionEvidence(e, false) + ')');
    });
    (view.undrawnPairs || []).forEach(function (up) {
      var labels = distinguishingPaths(up.from, up.to);
      lines.push('- ' + mdCode(labels[0]) + ' ↔ ' + mdCode(labels[1]) + ': ' + plural(up.shared, 'shared commit') + ' (qualifies, not drawn)');
    });
    if (view.evidence && view.evidence.length > 0) {
      lines.push('', '**Family-Wide Supporting Commits (2+ members via a qualifying pair):**');
      view.evidence.slice(0, 5).forEach(function (ev) {
        var scopeTag = ev.touchesAllMembers ? 'all ' + ev.totalMembers + ' members' : ev.membersTouched + ' of ' + ev.totalMembers + ' members';
        lines.push('- ' + mdCode(ev.hash.slice(0, 7)) + ' (' + ev.date + ', ' + scopeTag + '): ' + sanitizeMarkdown(ev.subject));
      });
    }
    return lines.join('\n');
  }

  function edgeWeightingLabel(d) {
    if (!d.weighted) return '';
    if (d.weighting === 'origin') return 'origin-weighted';
    if (d.weighting === 'recency+origin') return 'recency+origin-weighted';
    return 'recency-weighted';
  }
  function directionEvidence(e, fromSource) {
    var total = fromSource ? e.d.fromChanges : e.d.toChanges;
    var confidence = fromSource ? e.d.confidence : e.d.reverseConfidence;
    var iv = fromSource ? e.d.interval : e.d.reverseInterval;
    if (e.d.weighted) return e.d.shared + ' of ' + total + ' commits ' + formatCi(iv, true) + ' (' + pct(confidence) + ' ' + edgeWeightingLabel(e.d) + ')';
    return e.d.shared + ' of ' + total + ' commits (' + pct(confidence) + ') ' + formatCi(iv, false);
  }
  function findingLabel(e) {
    if (e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation') return 'Related implementations';
    return KINDS[e.d.relationship].label.replace(/s$/, '');
  }

  // ---- panel rendering -----------------------------------------------------
  function buildOverviewItems(listData) {
    var edgeToFamilyView = new Map();
    var allActiveViews = [];
    families.forEach(function (fam) {
      var views = getActiveFamilyViews(fam);
      views.forEach(function (view) {
        allActiveViews.push(view);
        view.edges.forEach(function (e) {
          edgeToFamilyView.set(e, view);
        });
      });
    });
    var items = [];
    var emittedViews = new Set();
    for (var i = 0; i < listData.length; i++) {
      var e = listData[i];
      var famView = edgeToFamilyView.get(e);
      if (famView) {
        if (!emittedViews.has(famView.id)) {
          emittedViews.add(famView.id);
          items.push({ kind: 'family', view: famView });
        }
      } else {
        items.push({ kind: 'edge', edge: e });
      }
    }
    if (overviewTab !== 'surprising') {
      allActiveViews.forEach(function (view) {
        if (emittedViews.has(view.id)) return;
        var matchesTab = overviewTab === 'all'
          || view.edges.length === 0
          || view.edges.some(function (e) { return e.d.relationship === 'ghost'; })
          || (view.undrawnPairs || []).some(function (up) { return up.relationship === 'ghost'; });
        if (!matchesTab) return;
        emittedViews.add(view.id);
        items.push({ kind: 'family', view: view });
      });
    }
    return items;
  }

  function getTopFindings(items, maxCount) {
    var top = items.slice(0, maxCount);
    for (var i = maxCount; i < items.length; i++) {
      if (items[i].kind === 'family') top.push(items[i]);
    }
    return top;
  }

  function renderOverview() {
    var header = el('div');
    header.appendChild(el('h2', '', 'Explore file relationships'));
    header.appendChild(el('p', '', 'Each dot represents a file sized by commit frequency and colored by directory. Lines connect files that change together. Pink dashed lines are ghost wires: files with no direct or supported indirect import relationship in current code that repeatedly move together in git history.'));
    panel.appendChild(header);

    var visibleEdges = edges.filter(isVisible);
    var ghosts = visibleEdges.filter(function (e) { return e.d.relationship === 'ghost'; }).sort(function (a, b) {
      return b.d.overviewPriority - a.d.overviewPriority || b.d.score - a.d.score || b.d.shared - a.d.shared;
    });
    var surprising = ghosts.filter(function (e) {
      var isParallel = e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation';
      if (isParallel) return false;
      var fromDir = e.s.dir, toDir = e.t.dir;
      var independent = fromDir !== toDir && fromDir !== '.' && toDir !== '.'
        && !fromDir.startsWith(toDir + '/') && !toDir.startsWith(fromDir + '/');
      return independent || e.d.overviewPriority >= 2;
    });
    var strongest = visibleEdges.slice().sort(function (a, b) { return b.d.shared - a.d.shared || b.d.score - a.d.score; });

    // Tabs
    var tabGroup = el('div', 'tab-group');
    var tabDefs = [
      { id: 'ghost', label: 'Ghost wires (' + ghosts.length + ')' },
      { id: 'surprising', label: 'Surprising (' + surprising.length + ')' },
      { id: 'all', label: 'All links (' + visibleEdges.length + ')' }
    ];
    tabDefs.forEach(function (t) {
      var btn = el('button', 'tab-btn' + (overviewTab === t.id ? ' active' : ''), t.label);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        overviewTab = t.id;
        overviewExpanded = false;
        renderPanel();
      });
      tabGroup.appendChild(btn);
    });
    panel.appendChild(tabGroup);

    var listData = overviewTab === 'surprising' ? surprising : (overviewTab === 'all' ? strongest : ghosts);
    var titleText = overviewTab === 'surprising' ? 'Cross-folder connections worth exploring' : (overviewTab === 'all' ? 'Strongest co-changing files' : 'Connections worth exploring');

    panel.appendChild(el('h3', '', titleText));

    var overviewItems = buildOverviewItems(listData);
    if (overviewItems.length === 0) {
      panel.appendChild(el('p', '', 'No relationships found for this filter.'));
    } else {
      panel.appendChild(el('p', 'card-hint', 'Select a card or line to inspect directional stats & commits'));
      var displayItems = overviewExpanded ? overviewItems : getTopFindings(overviewItems, 3);
      var cardsContainer = el('div');
      for (var idx = 0; idx < displayItems.length; idx++) {
        var item = displayItems[idx];
        if (item.kind === 'family') {
          cardsContainer.appendChild(familyCard(item.view));
        } else {
          cardsContainer.appendChild(relationshipCard(item.edge));
        }
      }
      panel.appendChild(cardsContainer);

      if (overviewItems.length > displayItems.length || (overviewExpanded && overviewItems.length > 3)) {
        var viewAllBtn = el('button', 'view-all-btn', overviewExpanded ? 'Show top 3 findings' : 'View all ' + overviewItems.length + ' findings');
        viewAllBtn.type = 'button';
        viewAllBtn.addEventListener('click', function () {
          overviewExpanded = !overviewExpanded;
          renderPanel();
        });
        panel.appendChild(viewAllBtn);
      }
    }

    // Folder Color Legend
    renderFolderLegend();
  }

  function renderFolderLegend() {
    var activeNodes = nodes.filter(isActive);
    var dirCounts = Object.create(null);
    activeNodes.forEach(function (n) {
      dirCounts[n.dir] = (dirCounts[n.dir] || 0) + 1;
    });
    var sortedDirs = Object.keys(dirCounts)
      .map(function (name) { return { name: name, count: dirCounts[name] }; })
      .sort(function (a, b) { return b.count - a.count; });
    if (sortedDirs.length === 0) return;
    var title = sortedDirs.length > 8
      ? 'Directory color legend (' + sortedDirs.slice(0, 8).length + ' of ' + sortedDirs.length + ' folders)'
      : 'Directory color legend';
    panel.appendChild(el('h3', '', title));
    var legend = el('div', 'folder-legend');
    sortedDirs.slice(0, 8).forEach(function (d) {
      var item = el('div', 'legend-item');
      var dot = el('span', 'legend-dot');
      dot.style.background = 'hsl(' + hashHue(d.name) + ', 58%, 72%)';
      item.appendChild(dot);
      item.appendChild(el('span', '', d.name + ' (' + d.count + ')'));
      legend.appendChild(item);
    });
    panel.appendChild(legend);
  }

  function familyCard(view) {
    var card = el('button', 'card interactive family-card');
    card.type = 'button';
    var head = el('div', 'card-header');
    head.appendChild(el('span', 'badge family', 'Related family · ' + view.members.length + ' files'));
    head.appendChild(el('span', 'card-sub', plural(view.commitsTouchingTwoOrMore, 'commit') + ' (2+ files) · ' + view.qualifyingPairs + ' of ' + view.possiblePairs + ' pairs'));
    card.appendChild(head);

    var title = el('div', 'card-title', view.d.label || view.d.id);
    card.appendChild(title);

    var variants = el('div', 'family-variants');
    view.members.forEach(function (m) {
      variants.appendChild(el('span', 'family-variant-pill', m.variant));
    });
    card.appendChild(variants);

    var note = el('div', 'card-sub');
    var pairSummary = view.qualifyingPairs === view.possiblePairs
      ? 'All ' + view.possiblePairs + ' pairwise links across ' + view.members.length + ' sibling directories passed thresholds.'
      : view.qualifyingPairs + ' of ' + view.possiblePairs + ' possible pairwise links passed thresholds across ' + view.members.length + ' sibling directories.';
    note.textContent = pairSummary + ' ' + plural(view.commitsTouchingTwoOrMore, 'supporting commit') + ' (2+ members via a qualifying pair; ' + plural(view.commitsTouchingAll, 'commit') + ' touched all ' + view.members.length + ').';
    card.appendChild(note);

    card.addEventListener('pointerenter', function () {
      hoverFamily = view;
      requestDraw();
    });
    card.addEventListener('pointerleave', function () {
      if (hoverFamily === view) {
        hoverFamily = null;
        requestDraw();
      }
    });
    card.addEventListener('click', function () {
      selectFamily(view);
    });
    return card;
  }

  function relationshipCard(e) {
    var card = el('button', 'card interactive');
    card.type = 'button';
    var head = el('div', 'card-header');
    var isParallel = e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation';
    var badgeClass = isParallel ? 'badge parallel' : 'badge ' + e.d.relationship;
    head.appendChild(el('span', badgeClass, findingLabel(e)));
    var peakPct = pct(Math.max(e.d.confidence, e.d.reverseConfidence));
    head.appendChild(el('span', 'card-sub', plural(e.d.shared, 'shared commit') + ' · ' + peakPct));
    card.appendChild(head);

    var pair = el('div', 'card-title');
    var labels = distinguishingPaths(e.s.path, e.t.path);
    pair.textContent = labels[0] + ' ↔ ' + labels[1];
    card.appendChild(pair);

    var note = el('div', 'card-sub');
    if (isParallel) {
      note.textContent = 'These files support related functionality across sibling directories and have been updated together in ' + plural(e.d.shared, 'commit') + '.';
    } else {
      var scope = e.d.crossesDirectories
        ? 'Connects different parts of the project (' + e.s.dir + ' and ' + e.t.dir + '). '
        : '';
      note.textContent = scope + capitalize(e.d.why) + '.';
    }
    card.appendChild(note);

    card.addEventListener('pointerenter', function () {
      hoverEdge = e;
      requestDraw();
    });
    card.addEventListener('pointerleave', function () {
      if (hoverEdge === e) {
        hoverEdge = null;
        requestDraw();
      }
    });
    card.addEventListener('click', function () {
      selectEdge(e);
    });
    return card;
  }

  function renderSelectedFamily(sel) {
    var view = resolveActiveFamilyView(sel);
    if (!view) {
      clearSelection();
      return;
    }

    var backBtn = el('button', 'back-btn', '← Back to overview');
    backBtn.type = 'button';
    backBtn.addEventListener('click', clearSelection);
    panel.appendChild(backBtn);

    var head = el('div');
    head.appendChild(el('span', 'badge family', 'Related implementation family'));
    var familyHeading = el('h2', '', view.d.label || view.d.id);
    familyHeading.tabIndex = -1;
    head.appendChild(familyHeading);
    panel._familyHeading = familyHeading;
    panel._expandedPairSummary = null;
    var subsetNote = view.isSubset && view.members.length < view.d.members.length
      ? ' (filtered from ' + view.d.members.length + ' family members)'
      : '';
    head.appendChild(el('p', 'card-sub', view.members.length + ' sibling files' + subsetNote + ' · ' + view.qualifyingPairs + ' of ' + view.possiblePairs + ' qualifying pairs · Last together ' + relativeDate(view.lastTogether)));
    panel.appendChild(head);

    var grid = el('div', 'cochange-grid');
    var card1 = el('div', 'cochange-card');
    card1.appendChild(el('div', 'cochange-pct', String(view.commitsTouchingTwoOrMore)));
    card1.appendChild(el('div', 'cochange-label', 'Supporting commits (2+ members via a qualifying pair)'));
    grid.appendChild(card1);

    var card2 = el('div', 'cochange-card');
    card2.appendChild(el('div', 'cochange-pct', String(view.commitsTouchingAll)));
    card2.appendChild(el('div', 'cochange-label', 'Commits touching all ' + view.members.length + ' family members together'));
    grid.appendChild(card2);
    panel.appendChild(grid);

    var callout = el('div', 'callout indirect');
    callout.appendChild(el('div', 'callout-title', 'Why these files are grouped'));
    var p1 = el('p');
    var parentDesc = view.d.parentDir === '.' ? 'the repository root' : view.d.parentDir;
    p1.textContent = 'These ' + view.members.length + ' files share the same stem (' + view.d.stem + ') in sibling directories under ' + parentDesc + ' and are connected by qualifying parallel-implementation relationships.';
    callout.appendChild(p1);

    var p2 = el('p');
    if (view.qualifyingPairs < view.possiblePairs) {
      p2.textContent = 'Incomplete relationship graph: ' + view.qualifyingPairs + ' of ' + view.possiblePairs + ' possible pairs passed the current thresholds. Only qualifying pairwise links are drawn on the map and listed below; missing pairs are never fabricated.';
    } else {
      p2.textContent = 'Complete relationship graph: all ' + view.possiblePairs + ' possible pairs across the ' + view.members.length + ' files passed the current thresholds.';
    }
    callout.appendChild(p2);
    panel.appendChild(callout);

    panel.appendChild(el('h3', '', 'Member files (' + view.members.length + ')'));
    var memberContainer = el('div', 'pair-container');
    view.members.forEach(function (m) {
      var mNode = typeof m.nodeIndex === 'number' && nodes[m.nodeIndex] ? nodes[m.nodeIndex] : nodeByPath[m.path];
      var box = el('div', 'pair-box');
      var boxHead = el('div', 'pair-box-head');
      var link = el('button', 'file-link', m.path);
      link.type = 'button';
      if (mNode) {
        link.addEventListener('click', function () { selectNode(mNode, view); });
      }
      boxHead.appendChild(link);
      boxHead.appendChild(el('span', 'family-variant-pill', m.variant));
      box.appendChild(boxHead);
      box.appendChild(el('div', 'pair-dir', 'Folder: ' + (m.dir || m.directory || '') + ' · Changed in ' + plural(m.changes, 'commit') + (m.topAuthor ? ' · Top author: ' + m.topAuthor : '')));
      memberContainer.appendChild(box);
    });
    panel.appendChild(memberContainer);

    panel.appendChild(el('h3', '', 'Qualifying pairwise relationships (' + view.qualifyingPairs + ' of ' + view.possiblePairs + ' possible)'));
    var pairList = el('div', 'family-pair-list');
    view.edges.forEach(function (e, idx) {
      var pKey = edgeKey(e.s.path, e.t.path);
      var details = el('details', 'family-pair-details');
      if (expandedFamilyPairKey ? expandedFamilyPairKey === pKey : idx === 0) {
        details.open = true;
      }
      details.addEventListener('toggle', function () {
        if (details.open) expandedFamilyPairKey = pKey;
      });
      details.addEventListener('pointerenter', function () {
        hoverEdge = e;
        requestDraw();
      });
      details.addEventListener('pointerleave', function () {
        if (hoverEdge === e) {
          hoverEdge = null;
          requestDraw();
        }
      });

      var summary = el('summary', 'family-pair-summary');
      var labels = distinguishingPaths(e.s.path, e.t.path);
      summary.appendChild(el('span', '', labels[0] + ' ↔ ' + labels[1]));
      var meta = el('span', 'family-pair-meta');
      meta.appendChild(el('span', 'badge ' + e.d.relationship, KINDS[e.d.relationship].label.replace(/s$/, '')));
      var peakPct = pct(Math.max(e.d.confidence, e.d.reverseConfidence));
      meta.appendChild(el('span', '', plural(e.d.shared, 'shared commit') + ' · ' + peakPct));
      summary.appendChild(meta);
      details.appendChild(summary);
      if (details.open && !panel._expandedPairSummary) panel._expandedPairSummary = summary;

      var body = el('div', 'family-pair-body');
      body.appendChild(el('div', 'family-pair-stat', e.s.path + ' ↔ ' + e.t.path));
      body.appendChild(el('div', 'family-pair-stat', labels[0] + ' → ' + labels[1] + ': ' + directionEvidence(e, true)));
      body.appendChild(el('div', 'family-pair-stat', labels[1] + ' → ' + labels[0] + ': ' + directionEvidence(e, false)));

      if (e.d.evidence && e.d.evidence.length > 0) {
        var evList = el('ul', 'evidence');
        e.d.evidence.slice(0, 3).forEach(function (ev) {
          var li = el('li');
          var hash = el('button', 'hash', ev.hash.slice(0, 7));
          hash.type = 'button'; hash.title = 'Copy full commit hash';
          hash.addEventListener('click', function () { copyText(ev.hash, hash, 'Copied'); });
          li.appendChild(hash);
          li.appendChild(el('span', '', ev.date + '  ' + ev.subject));
          evList.appendChild(li);
        });
        body.appendChild(evList);
      }

      var inspectBtn = el('button', 'btn-inspect-pair', 'Inspect paired diff & evidence →');
      inspectBtn.type = 'button';
      inspectBtn.addEventListener('click', function () {
        expandedFamilyPairKey = pKey;
        selectEdge(e, view);
      });
      body.appendChild(inspectBtn);
      details.appendChild(body);
      pairList.appendChild(details);
    });
    (view.undrawnPairs || []).forEach(function (up, uIdx) {
      var pKey = edgeKey(up.from, up.to);
      var details = el('details', 'family-pair-details');
      if (expandedFamilyPairKey ? expandedFamilyPairKey === pKey : (view.edges.length === 0 && uIdx === 0)) {
        details.open = true;
      }
      details.addEventListener('toggle', function () {
        if (details.open) expandedFamilyPairKey = pKey;
      });
      var summary = el('summary', 'family-pair-summary');
      var labels = distinguishingPaths(up.from, up.to);
      summary.appendChild(el('span', '', labels[0] + ' ↔ ' + labels[1]));
      var meta = el('span', 'family-pair-meta');
      meta.appendChild(el('span', 'badge ' + up.relationship, KINDS[up.relationship].label.replace(/s$/, '')));
      meta.appendChild(el('span', 'badge unknown', 'qualifies (not drawn)'));
      var peakPct = pct(Math.max(up.confidence, up.reverseConfidence));
      meta.appendChild(el('span', '', plural(up.shared, 'shared commit') + ' · ' + peakPct));
      summary.appendChild(meta);
      details.appendChild(summary);
      if (details.open && !panel._expandedPairSummary) panel._expandedPairSummary = summary;

      var body = el('div', 'family-pair-body');
      body.appendChild(el('div', 'family-pair-stat', up.from + ' ↔ ' + up.to));
      var pseudoEdge = { d: up };
      body.appendChild(el('div', 'family-pair-stat', labels[0] + ' → ' + labels[1] + ': ' + directionEvidence(pseudoEdge, true)));
      body.appendChild(el('div', 'family-pair-stat', labels[1] + ' → ' + labels[0] + ': ' + directionEvidence(pseudoEdge, false)));
      body.appendChild(el('div', 'family-pair-stat', 'Qualifies (not drawn on canvas due to map display cap).'));
      if (up.evidence && up.evidence.length > 0) {
        var evList = el('ul', 'evidence');
        up.evidence.slice(0, 3).forEach(function (ev) {
          var li = el('li');
          var hash = el('button', 'hash', ev.hash.slice(0, 7));
          hash.type = 'button'; hash.title = 'Copy full commit hash';
          hash.addEventListener('click', function () { copyText(ev.hash, hash, 'Copied'); });
          li.appendChild(hash);
          li.appendChild(el('span', '', ev.date + '  ' + ev.subject));
          evList.appendChild(li);
        });
        body.appendChild(evList);
      }
      if (up.explainCommand) {
        var cmdBtn = el('button', 'btn-inspect-pair', 'Copy CLI command: ' + up.explainCommand);
        cmdBtn.type = 'button';
        cmdBtn.addEventListener('click', function () { copyText(up.explainCommand, cmdBtn, 'Copied command'); });
        body.appendChild(cmdBtn);
      }
      details.appendChild(body);
      pairList.appendChild(details);
    });
    panel.appendChild(pairList);

    if (view.evidence && view.evidence.length > 0) {
      var evDetails = el('details', 'evidence-wrap');
      evDetails.open = true;
      evDetails.appendChild(el('summary', '', 'Family-wide supporting commits (' + view.evidence.length + ' of ' + view.commitsTouchingTwoOrMore + ' touching 2+ members via a qualifying pair)'));
      var list = el('ul', 'evidence');
      view.evidence.forEach(function (ev) {
        var li = el('li');
        var hash = el('button', 'hash', ev.hash.slice(0, 7));
        hash.type = 'button'; hash.title = 'Copy full commit hash';
        hash.addEventListener('click', function () { copyText(ev.hash, hash, 'Copied'); });
        li.appendChild(hash);

        var body = el('div', 'evidence-item-body');
        var topLine = el('div');
        var tagText = ev.touchesAllMembers
          ? 'All ' + ev.totalMembers + ' members'
          : ev.membersTouched + ' of ' + ev.totalMembers + ' members';
        topLine.appendChild(el('span', 'evidence-scope-tag', tagText));
        topLine.appendChild(el('span', '', ev.date + '  ' + ev.subject));
        body.appendChild(topLine);
        if (ev.memberPaths && ev.memberPaths.length > 0 && !ev.touchesAllMembers) {
          body.appendChild(el('div', 'evidence-rename', 'Touched: ' + ev.memberPaths.join(', ')));
        }
        li.appendChild(body);
        list.appendChild(li);
      });
      evDetails.appendChild(list);
      panel.appendChild(evDetails);
    }

    var exportBtn = el('button', 'btn-export', '📋 Copy finding for PR / discussion');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', function () {
      var markdown = formatFamilyMarkdown(view);
      copyText(markdown, exportBtn, '✓ Copied finding to clipboard');
    });
    panel.appendChild(exportBtn);
  }

  function renderSelectedEdge(e) {
    var activeReturnFam = resolveActiveFamilyView(returnToFamily);
    if (activeReturnFam) {
      var navRow = el('div', 'nav-row');
      var backFamBtn = el('button', 'back-btn back-to-family-btn', '← Back to family (' + (activeReturnFam.d.label || activeReturnFam.d.id) + ')');
      backFamBtn.type = 'button';
      backFamBtn.addEventListener('click', function () { selectFamily(activeReturnFam, true); });
      navRow.appendChild(backFamBtn);
      var backOverviewBtn = el('button', 'back-btn', 'Overview');
      backOverviewBtn.type = 'button';
      backOverviewBtn.addEventListener('click', clearSelection);
      navRow.appendChild(backOverviewBtn);
      panel.appendChild(navRow);
    } else {
      var backBtn = el('button', 'back-btn', '← Back to overview');
      backBtn.type = 'button';
      backBtn.addEventListener('click', clearSelection);
      panel.appendChild(backBtn);
    }

    var head = el('div');
    var isParallel = e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation';
    var badgeClass = isParallel ? 'badge parallel' : 'badge ' + e.d.relationship;
    head.appendChild(el('span', badgeClass, findingLabel(e)));
    head.appendChild(el('h2', '', 'Connection worth checking'));
    head.appendChild(el('p', 'card-sub', 'Changed together in ' + plural(e.d.shared, 'commit') + ' · Last together ' + relativeDate(e.d.lastTogether)));
    panel.appendChild(head);

    var labels = distinguishingPaths(e.s.path, e.t.path);

    // Pair Boxes
    var pairContainer = el('div', 'pair-container');

    var boxA = el('div', 'pair-box');
    var boxAHead = el('div', 'pair-box-head');
    var linkA = el('button', 'file-link', e.s.path);
    linkA.type = 'button';
    linkA.addEventListener('click', function () { selectNode(e.s, activeReturnFam || undefined); });
    boxAHead.appendChild(linkA);
    boxA.appendChild(boxAHead);
    var subA = el('div', 'pair-dir', 'Folder: ' + e.s.dir + ' · Changed in ' + plural(e.s.changes, 'commit') + (e.s.author ? ' · Top author: ' + e.s.author : ''));
    boxA.appendChild(subA);
    pairContainer.appendChild(boxA);

    var wire = el('div', 'pair-wire');
    wire.appendChild(el('span', 'swatch ' + e.d.relationship));
    wire.appendChild(el('span', '', plural(e.d.shared, 'shared commit')));
    wire.appendChild(el('span', 'swatch ' + e.d.relationship));
    pairContainer.appendChild(wire);

    var boxB = el('div', 'pair-box');
    var boxBHead = el('div', 'pair-box-head');
    var linkB = el('button', 'file-link', e.t.path);
    linkB.type = 'button';
    linkB.addEventListener('click', function () { selectNode(e.t, activeReturnFam || undefined); });
    boxBHead.appendChild(linkB);
    boxB.appendChild(boxBHead);
    var subB = el('div', 'pair-dir', 'Folder: ' + e.t.dir + ' · Changed in ' + plural(e.t.changes, 'commit') + (e.t.author ? ' · Top author: ' + e.t.author : ''));
    boxB.appendChild(subB);
    pairContainer.appendChild(boxB);

    panel.appendChild(pairContainer);

    // Directional Co-Change Cards
    var grid = el('div', 'cochange-grid');
    var card1 = el('div', 'cochange-card');
    card1.appendChild(el('div', 'cochange-pct', pct(e.d.confidence)));
    var wLabel = edgeWeightingLabel(e.d);
    var desc1 = (wLabel ? '(' + wLabel + ') ' : '') + labels[0] + ' changes also modified ' + labels[1] + ' (' + e.d.shared + ' of ' + e.d.fromChanges + ' commits) ' + formatCi(e.d.interval, e.d.weighted);
    card1.appendChild(el('div', 'cochange-label', desc1));
    grid.appendChild(card1);

    var card2 = el('div', 'cochange-card');
    card2.appendChild(el('div', 'cochange-pct', pct(e.d.reverseConfidence)));
    var desc2 = (wLabel ? '(' + wLabel + ') ' : '') + labels[1] + ' changes also modified ' + labels[0] + ' (' + e.d.shared + ' of ' + e.d.toChanges + ' commits) ' + formatCi(e.d.reverseInterval, e.d.weighted);
    card2.appendChild(el('div', 'cochange-label', desc2));
    grid.appendChild(card2);
    panel.appendChild(grid);

    // Why it matters
    var callout = el('div', 'callout ' + e.d.relationship);
    callout.appendChild(el('div', 'callout-title', 'Why it matters'));
    var p1 = el('p');
    p1.textContent = 'These files have been updated together before. If you\'re making changes to one, consider reviewing both.';
    callout.appendChild(p1);

    var p2 = el('p');
    if (e.d.relationship === 'ghost') {
      p2.textContent = 'No direct or one-step-removed import relationship found in the current code. Based on ' + plural(e.d.shared, 'shared commit') + ', so this is an investigative clue rather than a confirmed compile-time dependency.';
    } else if (e.d.relationship === 'indirect') {
      p2.textContent = 'Connected indirectly (one step removed through an intermediate file) in the dependency tree.';
    } else if (e.d.relationship === 'direct') {
      p2.textContent = 'Connected by a direct import link in the current codebase.';
    } else if (e.d.relationship === 'test') {
      p2.textContent = String(e.d.why || '').trim().toLowerCase() === 'both are tests'
        ? 'Both files are test files that have moved together in ' + plural(e.d.shared, 'shared commit') + '.'
        : 'Test file that repeatedly changes alongside this code (' + plural(e.d.shared, 'shared commit') + ').';
    } else {
      p2.textContent = 'Import relationship status could not be fully verified from static imports.';
    }
    callout.appendChild(p2);

    if (e.d.crossesDirectories && !(e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation')) {
      var p3 = el('p');
      p3.textContent = 'Connects different parts of the project (' + e.s.dir + ' and ' + e.t.dir + ').';
      callout.appendChild(p3);
    }
    if (e.d.verdict) {
      var pv = el('p');
      var vLabel = e.d.verdict.kind === 'confirmed' ? 'Confirmed dependency' : 'Expected relationship (silenced)';
      if (e.d.verdict.by) vLabel += ' by ' + e.d.verdict.by;
      if (e.d.verdict.until) vLabel += ' (until ' + e.d.verdict.until + ')';
      pv.textContent = vLabel + ': ' + e.d.verdict.reason;
      callout.appendChild(pv);
    }
    panel.appendChild(callout);

    function renderFilePatchBlock(patch) {
      var wrap = el('div', 'patch-file');
      var titleText = patch.canonicalPath;
      if (patch.oldPath && patch.oldPath !== patch.path) {
        titleText += ' [' + patch.status + ': ' + patch.oldPath + ' → ' + patch.path + ']';
      } else if (patch.path && patch.path !== patch.canonicalPath) {
        titleText += ' [' + patch.status + ' at ' + patch.path + ']';
      } else if (patch.status) {
        titleText += ' [' + patch.status + ']';
      }
      wrap.appendChild(el('div', 'patch-file-title', titleText));
      if (!patch.hunks || patch.hunks.length === 0) {
        wrap.appendChild(el('div', 'patch-note', patch.statusNote || 'No textual diff hunks'));
        return wrap;
      }
      var hasUnexplainedHunkTruncation = false;
      patch.hunks.forEach(function (hunk) {
        var box = el('div', 'patch-hunk');
        box.appendChild(el('div', 'patch-hunk-hdr', hunk.header));
        hunk.lines.forEach(function (line) {
          var cls = 'patch-line';
          if (line.charAt(0) === '+') cls += ' add';
          else if (line.charAt(0) === '-') cls += ' del';
          box.appendChild(el('div', cls, line));
        });
        if (hunk.omittedLines > 0) {
          box.appendChild(el('div', 'patch-note', '… (' + plural(hunk.omittedLines, 'line') + ' omitted in hunk)'));
        } else if (hunk.truncated) {
          hasUnexplainedHunkTruncation = true;
        }
        wrap.appendChild(box);
      });
      if (patch.omittedHunks > 0) {
        var hunkCountStr = patch.rawTruncated
          ? patch.omittedHunks.toLocaleString('en-US') + '+ additional hunk' + (patch.omittedHunks === 1 ? '' : 's')
          : plural(patch.omittedHunks, 'additional hunk');
        wrap.appendChild(el('div', 'patch-note', '… (' + hunkCountStr + ' omitted)'));
      }
      var unexplained = patch.timedOut || patch.rawTruncated || (patch.truncated && !patch.omittedHunks && (!patch.omittedLines || hasUnexplainedHunkTruncation));
      if (unexplained) {
        var reason = patch.timedOut ? 'time limit' : 'byte/time limit';
        wrap.appendChild(el('div', 'patch-note', '… (patch truncated due to ' + reason + ')'));
      }
      return wrap;
    }

    // Supporting Commits
    if (e.d.evidence && e.d.evidence.length > 0) {
      var details = el('details', 'evidence-wrap');
      details.open = true;
      details.appendChild(el('summary', '', 'View ' + e.d.evidence.length + ' supporting commit' + (e.d.evidence.length === 1 ? '' : 's')));
      var list = el('ul', 'evidence');
      e.d.evidence.forEach(function (ev) {
        var li = el('li');
        var hash = el('button', 'hash', ev.hash.slice(0, 7));
        hash.type = 'button'; hash.title = 'Copy full commit hash';
        hash.addEventListener('click', function () { copyText(ev.hash, hash, 'Copied'); });
        li.appendChild(hash);

        var body = el('div', 'evidence-item-body');
        body.appendChild(el('div', '', ev.date + '  ' + ev.subject));
        var renameParts = [];
        if (ev.sourcePath && ev.sourcePath !== e.s.path) renameParts.push(labels[0] + ' was ' + ev.sourcePath);
        if (ev.targetPath && ev.targetPath !== e.t.path) renameParts.push(labels[1] + ' was ' + ev.targetPath);
        if (renameParts.length > 0) {
          body.appendChild(el('div', 'evidence-rename', 'Historical path: ' + renameParts.join(' · ')));
        }
        li.appendChild(body);

        if (ev.patches && ev.patches.source && ev.patches.target) {
          var patchDetails = el('details', 'patch-details');
          patchDetails.appendChild(el('summary', '', 'Inspect bounded patch hunks'));
          patchDetails.appendChild(renderFilePatchBlock(ev.patches.source));
          patchDetails.appendChild(renderFilePatchBlock(ev.patches.target));
          patchDetails.appendChild(el('div', 'patch-note', 'Historical patches show what changed in the same commit, not proof of why the files changed together.'));
          li.appendChild(patchDetails);
        }
        list.appendChild(li);
      });
      details.appendChild(list);
      panel.appendChild(details);
    }

    // Counterexamples ("When one changed without the other")
    var cx = e.d.counterexamples;
    if (cx && ((cx.fromOnly && cx.fromOnly.length > 0) || (cx.toOnly && cx.toOnly.length > 0))) {
      var cxDetails = el('details', 'evidence-wrap');
      cxDetails.appendChild(el('summary', '', 'When one changed without the other'));
      var appendCounterSide = function (titleText, items, total) {
        if (!items || items.length === 0) return;
        var countNum = typeof total === 'number' && total >= items.length ? total : items.length;
        var suffix = countNum > items.length
          ? ' (showing ' + items.length + ' of ' + countNum + ')'
          : ' (' + plural(countNum, 'commit') + ')';
        var grp = el('div', 'counterexample-group');
        grp.appendChild(el('div', 'counterexample-title', titleText + suffix));
        var ul = el('ul', 'evidence');
        items.forEach(function (item) {
          var li = el('li');
          var hash = el('button', 'hash', item.hash.slice(0, 7));
          hash.type = 'button'; hash.title = 'Copy full commit hash';
          hash.addEventListener('click', function () { copyText(item.hash, hash, 'Copied'); });
          li.appendChild(hash);
          li.appendChild(el('span', '', item.date + '  ' + item.subject));
          ul.appendChild(li);
        });
        grp.appendChild(ul);
        cxDetails.appendChild(grp);
      };
      appendCounterSide(labels[0] + ' without ' + labels[1], cx.fromOnly, cx.fromOnlyTotal);
      appendCounterSide(labels[1] + ' without ' + labels[0], cx.toOnly, cx.toOnlyTotal);
      panel.appendChild(cxDetails);
    }

    // Copyable CLI explain command + privacy note
    var cliCmd = e.d.explainCommand || fallbackExplainCommand(e.s.path, e.t.path);
    var cliBox = el('div', 'cli-box');
    var cliHead = el('div', 'cli-box-head');
    cliHead.appendChild(el('span', 'cli-box-label', 'Inspect paired diffs locally'));
    var copyCliBtn = el('button', 'btn-cli-copy', 'Copy CLI command');
    copyCliBtn.type = 'button';
    copyCliBtn.addEventListener('click', function () {
      copyText(cliCmd, copyCliBtn, '✓ Copied');
    });
    cliHead.appendChild(copyCliBtn);
    cliBox.appendChild(cliHead);
    cliBox.appendChild(el('code', 'cli-code', cliCmd));
    var privacyText = data.patchesIncluded
      ? 'Historical patches show what changed in the same commit, not proof of why the files changed together.'
      : 'Source-code patches are omitted by default. This file still contains file paths, commit subjects and author names. Run the CLI command above locally, or pass --include-patches when generating the map.';
    cliBox.appendChild(el('div', 'privacy-note', privacyText));
    panel.appendChild(cliBox);

    // Export button
    var exportBtn = el('button', 'btn-export', '📋 Copy finding for PR / discussion');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', function () {
      var markdown = formatFindingMarkdown(e);
      copyText(markdown, exportBtn, '✓ Copied finding to clipboard');
    });
    panel.appendChild(exportBtn);
  }

  function renderSelectedNode(n) {
    var activeReturnFam = resolveActiveFamilyView(returnToFamily);
    if (activeReturnFam) {
      var navRow = el('div', 'nav-row');
      var backFamBtn = el('button', 'back-btn back-to-family-btn', '← Back to family (' + (activeReturnFam.d.label || activeReturnFam.d.id) + ')');
      backFamBtn.type = 'button';
      backFamBtn.addEventListener('click', function () { selectFamily(activeReturnFam, true); });
      navRow.appendChild(backFamBtn);
      var backOverviewBtn = el('button', 'back-btn', 'Overview');
      backOverviewBtn.type = 'button';
      backOverviewBtn.addEventListener('click', clearSelection);
      navRow.appendChild(backOverviewBtn);
      panel.appendChild(navRow);
    } else {
      var backBtn = el('button', 'back-btn', '← Back to overview');
      backBtn.type = 'button';
      backBtn.addEventListener('click', clearSelection);
      panel.appendChild(backBtn);
    }

    panel.appendChild(el('h2', '', base(n.path)));
    panel.appendChild(el('p', 'path', n.path));
    var who = n.author ? ' Most commits by ' + n.author + ' (' + pct(n.share || 0) + ').' : '';
    panel.appendChild(el('p', '', 'Folder: ' + n.dir + ' · Changed in ' + plural(n.changes, 'commit') + '.' + who));

    var rels = n.edges.filter(isVisible).sort(function (a, b) { return b.d.shared - a.d.shared; });
    panel.appendChild(el('h3', '', 'Connected file relationships (' + rels.length + ')'));

    if (rels.length === 0) {
      panel.appendChild(el('p', '', 'Its relationships are hidden by the filters above.'));
    } else {
      var cardsContainer = el('div');
      rels.forEach(function (e) {
        cardsContainer.appendChild(relationshipCard(e));
      });
      panel.appendChild(cardsContainer);
    }
  }

  function renderPanel() {
    panel.textContent = '';
    if (selectedNode) {
      renderSelectedNode(selectedNode);
    } else if (selectedEdge) {
      renderSelectedEdge(selectedEdge);
    } else if (selectedFamily) {
      renderSelectedFamily(selectedFamily);
    } else {
      renderOverview();
    }
  }

  // ---- start ---------------------------------------------------------------
  if (motionMedia) {
    var onMotionChange = function (ev) {
      reduceMotion = Boolean(ev.matches);
      if (reduceMotion) {
        cancelMarchTimer();
        if (flight) {
          cam.x = flight.to.x; cam.y = flight.to.y; cam.scale = flight.to.scale;
          flight = null;
        }
      }
      requestDraw();
    };
    if (typeof motionMedia.addEventListener === 'function') {
      motionMedia.addEventListener('change', onMotionChange);
    } else if (typeof motionMedia.addListener === 'function') {
      motionMedia.addListener(onMotionChange);
    }
  }
  var resizeTimer = null;
  function scheduleResize() {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      var rect = canvas.getBoundingClientRect();
      if (Math.round(rect.width) === Math.round(size.w) && Math.round(rect.height) === Math.round(size.h)) return;
      resizeNow();
    }, 50);
  }
  if (typeof ResizeObserver !== 'undefined') {
    var roInitialized = false;
    var ro = new ResizeObserver(function () {
      if (!roInitialized) { roInitialized = true; return; }
      scheduleResize();
    });
    ro.observe(canvas);
  } else {
    window.addEventListener('resize', scheduleResize);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) cancelMarchTimer();
    else requestDraw();
  });
  resizeNow();
  fit();
  renderPanel();
  requestDraw();
})();
`;

const RICH_STYLES = String.raw`
:root, :root[data-theme="light"] {
  --f-desk: #e2e3e5;
  --f-sheet: #ffffff;
  --f-panel: #ffffff;
  --f-ink: #121212;
  --f-ink-2: #4b4b4b;
  --f-rule: #121212;
  --f-tone: #121212;
  --f-grid: #e3e3e3;
  --f-marker: #ffd60a;
  --f-marker-ink: #121212;
  --f-hole: #e2e3e5;
  --f-backdrop: rgba(12, 12, 12, 0.78);
  --f-diff: #ffffff;
  --f-gutter-pair: 12px;
  --f-gutter-scene: 20px;
  --f-gutter-change: 32px;
  --f-stroke-ink: 2.5px;
  --f-shadow-sheet: 0 1px 0 rgba(0, 0, 0, 0.05), 0 18px 40px -26px rgba(0, 0, 0, 0.5);
  --f-font-display: "Dela Gothic One", "Arial Black", "Helvetica Neue", sans-serif;
  --f-font-body: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --f-font-mono: "M PLUS 1 Code", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --f-desk: #000000;
    --f-sheet: #050505;
    --f-panel: #19191a;
    --f-ink: #f1f0ea;
    --f-ink-2: #b9b8b1;
    --f-rule: #f1f0ea;
    --f-tone: #f1f0ea;
    --f-grid: #2c2c2d;
    --f-marker: #ffd60a;
    --f-marker-ink: #121212;
    --f-hole: #000000;
    --f-backdrop: rgba(12, 12, 12, 0.78);
    --f-diff: #ffffff;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --f-desk: #000000;
  --f-sheet: #050505;
  --f-panel: #19191a;
  --f-ink: #f1f0ea;
  --f-ink-2: #b9b8b1;
  --f-rule: #f1f0ea;
  --f-tone: #f1f0ea;
  --f-grid: #2c2c2d;
  --f-marker: #ffd60a;
  --f-marker-ink: #121212;
  --f-hole: #000000;
  --f-backdrop: rgba(12, 12, 12, 0.78);
  --f-diff: #ffffff;
  color-scheme: dark;
}
@media (prefers-contrast: more) {
  :root, :root[data-theme="light"], :root[data-theme="dark"] {
    --f-ink-2: var(--f-ink);
  }
}
* { box-sizing: border-box; border-radius: 0; }
html { margin: 0; height: 100%; max-width: 100%; overflow-x: hidden; background: var(--f-desk); color: var(--f-ink); }
body { margin: 0; height: 100%; max-width: 100%; overflow-x: hidden; background: var(--f-desk); color: var(--f-ink); font: 1rem/1.55 var(--f-font-body); }
button, input { font: inherit; color: inherit; border-radius: 0; min-height: 24px; min-width: 24px; }
[hidden] { display: none !important; }
:focus-visible { outline: var(--f-stroke-ink) solid var(--f-ink); outline-offset: 2px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.fc-probe { position: absolute; width: 0; height: 0; overflow: hidden; pointer-events: none; color: CanvasText; background-color: Canvas; border-color: Highlight; }

.app { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 420px); grid-template-rows: auto minmax(0, 1fr); height: 100vh; max-width: 100%; background: var(--f-sheet); box-shadow: var(--f-shadow-sheet); }
.bar { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: var(--f-gutter-pair) var(--f-gutter-change); align-items: flex-end; justify-content: space-between; padding: var(--f-gutter-scene) var(--f-gutter-change); border-bottom: var(--f-stroke-ink) solid var(--f-rule); background: var(--f-panel); min-width: 0; }
.heading { min-width: 0; flex: 1 1 320px; }
.masthead-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--f-gutter-pair); }
h1 { margin: 0; font: 900 24px/1.08 var(--f-font-display); letter-spacing: 0.02em; text-transform: uppercase; color: var(--f-ink); }
.repo-tag { font: 700 13px/1.2 var(--f-font-mono); padding: 2px 6px; border: 1.5px solid var(--f-rule); color: var(--f-ink); background: var(--f-sheet); }
.masthead-rule { height: var(--f-stroke-ink); width: 100%; max-width: 640px; margin: 8px 0 8px; background: var(--f-rule); transform: skewX(-18deg); }
.summary { margin: 0; color: var(--f-ink-2); font-size: 13.5px; max-width: 78ch; overflow-wrap: anywhere; }
.banner-warning { display: inline-flex; align-items: center; gap: var(--f-gutter-pair); margin-top: var(--f-gutter-pair); padding: 6px 12px; background: var(--f-panel); border: var(--f-stroke-ink) solid var(--f-rule); font: 600 12.5px/1.4 var(--f-font-mono); color: var(--f-ink); }

.controls { display: flex; flex-wrap: wrap; gap: var(--f-gutter-pair); align-items: center; min-width: 0; max-width: 100%; }
.search { min-width: 0; }
.search input { width: 220px; max-width: 100%; padding: 6px 10px; border: var(--f-stroke-ink) solid var(--f-rule); background: var(--f-sheet); color: var(--f-ink); font: 13px/1.3 var(--f-font-mono); }
.search input::placeholder { color: var(--f-ink-2); }
.toggles { display: flex; flex-wrap: wrap; gap: var(--f-gutter-pair); min-width: 0; }
.toggle { display: inline-flex; align-items: center; gap: var(--f-gutter-pair); min-height: 28px; min-width: 28px; padding: 4px 10px; border: 1.5px solid var(--f-rule); background: var(--f-sheet); cursor: pointer; font: 600 12px/1.2 var(--f-font-mono); text-transform: uppercase; letter-spacing: 0.03em; color: var(--f-ink); }
.toggle[aria-pressed="false"] { border-style: dashed; color: var(--f-ink-2); background: var(--f-panel); }
.toggle[aria-pressed="true"] { border-width: var(--f-stroke-ink); background: var(--f-panel); color: var(--f-ink); }
.toggle .count { color: var(--f-ink-2); font-variant-numeric: tabular-nums; }
.swatch-svg { width: 26px; height: 10px; display: inline-block; flex-shrink: 0; overflow: visible; }

.stage { position: relative; min-height: 0; min-width: 0; overflow: hidden; background: var(--f-sheet); }
canvas { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
canvas.dragging { cursor: grabbing; }
canvas.pointing { cursor: pointer; }
.print-map-img { display: none; max-width: 100%; height: auto; }
.stage-overlay { position: absolute; top: var(--f-gutter-pair); left: var(--f-gutter-pair); display: flex; flex-wrap: wrap; gap: var(--f-gutter-pair); z-index: 10; max-width: calc(100% - 24px); }
.map-btn { display: inline-flex; align-items: center; gap: var(--f-gutter-pair); min-height: 28px; min-width: 28px; padding: 5px 10px; background: var(--f-panel); border: 1.5px solid var(--f-rule); color: var(--f-ink); font: 600 12px/1.2 var(--f-font-mono); text-transform: uppercase; letter-spacing: 0.03em; cursor: pointer; }
.map-btn[aria-pressed="true"] { border-width: var(--f-stroke-ink); }
.hint { position: absolute; left: var(--f-gutter-pair); bottom: var(--f-gutter-pair); margin: 0; padding: 2px 6px; background: var(--f-panel); border: 1px solid var(--f-rule); font: 12px/1.3 var(--f-font-mono); color: var(--f-ink-2); pointer-events: none; }
.tooltip { position: absolute; pointer-events: auto; max-width: 440px; padding: 8px 12px; background: var(--f-panel); border: var(--f-stroke-ink) solid var(--f-rule); color: var(--f-ink); font-size: 13px; z-index: 20; }
.tooltip code { font-family: var(--f-font-mono); font-size: 12.5px; word-break: break-all; color: var(--f-ink); }

.panel { overflow-y: auto; overflow-x: hidden; min-width: 0; padding: var(--f-gutter-scene); background: var(--f-panel); border-left: var(--f-stroke-ink) solid var(--f-rule); display: flex; flex-direction: column; gap: var(--f-gutter-pair); }
.cut-section-label { display: inline-block; width: fit-content; padding: 2px 8px; border: 1.5px solid var(--f-rule); background: var(--f-sheet); color: var(--f-ink); font: 700 11.5px/1.3 var(--f-font-mono); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: var(--f-gutter-pair); }
.panel h2 { margin: 0 0 var(--f-gutter-pair); font: 900 20px/1.2 var(--f-font-display); text-transform: uppercase; letter-spacing: 0.02em; color: var(--f-ink); overflow-wrap: anywhere; }
.panel h3 { margin: var(--f-gutter-scene) 0 var(--f-gutter-pair); font: 700 12px/1.2 var(--f-font-mono); text-transform: uppercase; letter-spacing: 0.05em; color: var(--f-ink-2); }
.panel p { margin: 0 0 var(--f-gutter-pair); color: var(--f-ink-2); font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; }
.panel .path { font-family: var(--f-font-mono); font-size: 13px; overflow-wrap: anywhere; color: var(--f-ink); }
.panel ol, .panel ul { list-style: none; margin: 0; padding: 0; }

.badge { display: inline-flex; align-items: center; gap: var(--f-gutter-pair); padding: 2px 7px; border: 1.5px solid var(--f-rule); background: var(--f-sheet); color: var(--f-ink); font: 700 11px/1.3 var(--f-font-mono); text-transform: uppercase; letter-spacing: 0.04em; }
.badge.weak { border-style: dashed; color: var(--f-ink-2); }
.badge.marker-active { background: var(--f-marker); color: var(--f-marker-ink); border-color: var(--f-rule); }
.cut-chip { display: inline-flex; align-items: center; padding: 2px 6px; border: 1.5px solid var(--f-rule); background: var(--f-sheet); color: var(--f-ink); font: 700 11px/1.3 var(--f-font-mono); }

.tab-group { display: flex; flex-wrap: wrap; gap: var(--f-gutter-pair); margin-bottom: var(--f-gutter-pair); }
.tab-btn { flex: 1 1 auto; padding: 6px 8px; background: var(--f-sheet); border: 1.5px solid var(--f-rule); color: var(--f-ink-2); font: 700 11.5px/1.3 var(--f-font-mono); text-transform: uppercase; cursor: pointer; text-align: center; }
.tab-btn.active { border-width: var(--f-stroke-ink); color: var(--f-ink); background: var(--f-panel); }

.card-hint { font: 12px/1.4 var(--f-font-mono); color: var(--f-ink-2); margin: 0 0 var(--f-gutter-pair); }
.cards-list { display: flex; flex-direction: column; gap: var(--f-gutter-pair); }
.card { background-color: var(--f-sheet); border: 1.5px solid var(--f-rule); padding: var(--f-gutter-pair); display: block; width: 100%; text-align: left; color: var(--f-ink); }
.card.interactive { cursor: pointer; font: inherit; }
.card.interactive:hover { border-width: var(--f-stroke-ink); }
.card.selected { border-width: var(--f-stroke-ink); background-color: var(--f-panel); background-image: radial-gradient(circle, var(--f-tone) 0.65px, transparent 0.65px); background-size: 12px 12px; }
.card-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--f-gutter-pair); margin-bottom: var(--f-gutter-pair); }
.card-badges { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--f-gutter-pair); }
.card-title { font: 700 13px/1.4 var(--f-font-mono); color: var(--f-ink); overflow-wrap: anywhere; }
.card-sub { font-size: 12.5px; color: var(--f-ink-2); margin-top: 4px; overflow-wrap: anywhere; }
.family-variants { display: flex; flex-wrap: wrap; gap: var(--f-gutter-pair); margin: var(--f-gutter-pair) 0; }
.family-variant-pill { display: inline-block; padding: 1px 6px; background: var(--f-sheet); border: 1px solid var(--f-rule); font: 11.5px/1.4 var(--f-font-mono); color: var(--f-ink); }

.file-link { display: inline-flex; align-items: center; min-height: 24px; min-width: 24px; padding: 0; border: 0; background: none; text-align: left; cursor: pointer; font: 700 13px/1.4 var(--f-font-mono); overflow-wrap: anywhere; text-decoration: underline; text-underline-offset: 3px; color: var(--f-ink); }
.nav-row { display: flex; flex-wrap: wrap; gap: var(--f-gutter-pair); margin-bottom: var(--f-gutter-pair); }
.back-btn { display: inline-flex; align-items: center; gap: var(--f-gutter-pair); padding: 5px 10px; background: var(--f-sheet); border: 1.5px solid var(--f-rule); color: var(--f-ink); font: 700 12px/1.3 var(--f-font-mono); text-transform: uppercase; cursor: pointer; width: fit-content; }

.pair-container { display: flex; flex-direction: column; gap: var(--f-gutter-pair); margin: var(--f-gutter-pair) 0; }
.pair-box { background: var(--f-sheet); border: 1.5px solid var(--f-rule); padding: var(--f-gutter-pair); }
.pair-box-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--f-gutter-pair); margin-bottom: 4px; }
.pair-dir { font: 12px/1.4 var(--f-font-mono); color: var(--f-ink-2); overflow-wrap: anywhere; }
.pair-wire { display: flex; align-items: center; justify-content: center; gap: var(--f-gutter-pair); font: 700 12px/1.3 var(--f-font-mono); color: var(--f-ink-2); padding: 2px 0; }

.family-pair-list { display: flex; flex-direction: column; gap: var(--f-gutter-pair); margin: var(--f-gutter-pair) 0; }
.family-pair-details { background: var(--f-sheet); border: 1.5px solid var(--f-rule); padding: var(--f-gutter-pair); }
.family-pair-summary { cursor: pointer; font: 700 12.5px/1.4 var(--f-font-mono); color: var(--f-ink); display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--f-gutter-pair); overflow-wrap: anywhere; }
.family-pair-meta { font: 600 11.5px/1.3 var(--f-font-mono); color: var(--f-ink-2); display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--f-gutter-pair); }
.family-pair-body { margin-top: var(--f-gutter-pair); padding-top: var(--f-gutter-pair); border-top: 1px solid var(--f-rule); font-size: 12.5px; color: var(--f-ink-2); overflow-wrap: anywhere; }
.family-pair-stat { margin: 4px 0; }
.btn-inspect-pair { display: inline-flex; align-items: center; gap: var(--f-gutter-pair); margin-top: var(--f-gutter-pair); padding: 5px 10px; background: var(--f-panel); border: 1.5px solid var(--f-rule); color: var(--f-ink); font: 700 12px/1.3 var(--f-font-mono); cursor: pointer; }
.evidence-scope-tag { display: inline-block; padding: 1px 6px; margin-right: 6px; background: var(--f-sheet); border: 1px solid var(--f-rule); font: 700 11px/1.3 var(--f-font-mono); color: var(--f-ink); }

.cochange-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--f-gutter-pair); margin: var(--f-gutter-pair) 0; }
.cochange-card { background: var(--f-sheet); border: 1.5px solid var(--f-rule); padding: var(--f-gutter-pair); text-align: center; }
.cochange-pct { font: 900 20px/1.2 var(--f-font-mono); color: var(--f-ink); font-variant-numeric: tabular-nums; }
.cochange-label { font-size: 12px; color: var(--f-ink-2); margin-top: 4px; line-height: 1.35; overflow-wrap: anywhere; }

.callout { background: var(--f-sheet); border: 1.5px solid var(--f-rule); border-left-width: var(--f-stroke-ink); padding: var(--f-gutter-pair); margin: var(--f-gutter-pair) 0; font-size: 13.5px; line-height: 1.55; color: var(--f-ink); }
.callout-title { font: 700 12px/1.3 var(--f-font-mono); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--f-ink); }

.evidence-wrap { margin: var(--f-gutter-pair) 0 0; color: var(--f-ink-2); font-size: 13px; }
.evidence-wrap summary { width: fit-content; cursor: pointer; color: var(--f-ink); font: 700 12.5px/1.4 var(--f-font-mono); padding: 4px 0; }
.evidence { margin: var(--f-gutter-pair) 0 0; font-size: 13px; color: var(--f-ink-2); }
.evidence li { display: grid; grid-template-columns: auto 1fr; gap: var(--f-gutter-pair); padding: 6px 0; border-top: 1px solid var(--f-rule); }
.evidence .hash { display: inline-flex; align-items: center; justify-content: center; min-height: 24px; min-width: 24px; padding: 2px 6px; border: 1px solid var(--f-rule); background: var(--f-sheet); cursor: pointer; font: 700 12px/1.3 var(--f-font-mono); color: var(--f-ink); height: fit-content; }
.evidence-item-body { min-width: 0; overflow-wrap: anywhere; }
.evidence-rename { font: 11.5px/1.4 var(--f-font-mono); color: var(--f-ink-2); margin-top: 2px; overflow-wrap: anywhere; }

.patch-details { grid-column: 1 / -1; margin-top: 4px; background: var(--f-sheet); border: 1px solid var(--f-rule); padding: var(--f-gutter-pair); }
.patch-details summary { font: 700 12px/1.3 var(--f-font-mono); color: var(--f-ink); cursor: pointer; padding: 2px 0; }
.patch-file { margin-top: var(--f-gutter-pair); border-top: 1px solid var(--f-rule); padding-top: 6px; }
.patch-file-title { font: 700 12px/1.4 var(--f-font-mono); color: var(--f-ink); overflow-wrap: anywhere; }
.patch-note { font-size: 12px; color: var(--f-ink-2); margin-top: 3px; }
.patch-hunk { margin: 6px 0 0; padding: 6px 8px; background: var(--f-panel); border: 1px solid var(--f-rule); overflow-x: auto; font: 11.5px/1.45 var(--f-font-mono); }
.patch-hunk-hdr { color: var(--f-ink-2); margin-bottom: 2px; white-space: pre; }
.patch-line { white-space: pre; color: var(--f-ink-2); }
.patch-line.add { color: var(--f-ink); font-weight: 600; }
.patch-line.del { color: var(--f-ink-2); text-decoration: line-through; }

.counterexample-group { margin-top: var(--f-gutter-pair); }
.counterexample-title { font: 700 12px/1.4 var(--f-font-mono); color: var(--f-ink); margin: 6px 0 4px; }

.cli-box { margin-top: var(--f-gutter-pair); padding: var(--f-gutter-pair); background: var(--f-sheet); border: 1.5px solid var(--f-rule); }
.cli-box-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--f-gutter-pair); margin-bottom: 6px; }
.cli-box-label { font: 700 11.5px/1.3 var(--f-font-mono); text-transform: uppercase; letter-spacing: 0.04em; color: var(--f-ink-2); }
.btn-cli-copy { padding: 3px 9px; border: 1.5px solid var(--f-rule); background: var(--f-panel); color: var(--f-ink); font: 700 11.5px/1.3 var(--f-font-mono); cursor: pointer; }
.cli-code { display: block; font: 12px/1.45 var(--f-font-mono); color: var(--f-ink); overflow-wrap: anywhere; user-select: all; }
.privacy-note { margin-top: 6px; font-size: 12px; line-height: 1.45; color: var(--f-ink-2); }

.btn-export { display: inline-flex; align-items: center; justify-content: center; gap: var(--f-gutter-pair); width: 100%; padding: 8px 14px; margin-top: var(--f-gutter-pair); background: var(--f-sheet); border: var(--f-stroke-ink) solid var(--f-rule); color: var(--f-ink); font: 700 12.5px/1.3 var(--f-font-mono); text-transform: uppercase; cursor: pointer; }
.view-all-btn { display: block; width: 100%; padding: 8px 12px; margin-top: var(--f-gutter-pair); background: var(--f-sheet); border: 1.5px dashed var(--f-rule); color: var(--f-ink-2); font: 700 12px/1.3 var(--f-font-mono); text-transform: uppercase; cursor: pointer; text-align: center; }

.folder-legend { display: flex; flex-wrap: wrap; gap: var(--f-gutter-pair); margin-top: var(--f-gutter-pair); }
.legend-item { display: inline-flex; align-items: center; gap: var(--f-gutter-pair); font: 12px/1.3 var(--f-font-mono); color: var(--f-ink-2); }
.legend-dot { width: 10px; height: 10px; border: 1.5px solid var(--f-rule); }

/* RA-17 Investigation Board (Briefing Mode) */
.app[data-view="briefing"] { display: flex; flex-direction: column; height: auto; min-height: 100vh; max-width: 1440px; width: 100%; margin: 0 auto; overflow-x: hidden; }
.app[data-view="briefing"] > .stage, .app[data-view="briefing"] > .panel { display: none !important; }
.app[data-view="atlas"] > .f12-briefing { display: none !important; }

.f12-evidence-pill { display: inline-flex; align-items: center; padding: 2px 8px; border: 1.5px solid var(--f-rule); background: var(--f-marker); color: var(--f-marker-ink); font: 800 11px/1.3 var(--f-font-mono); letter-spacing: 0.05em; text-transform: uppercase; }
.f12-howto { position: relative; display: inline-block; }
.f12-howto > summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; min-height: 24px; padding: 2px 8px; border: 1.5px dashed var(--f-rule); background: var(--f-sheet); color: var(--f-ink); font: 700 11.5px/1.3 var(--f-font-mono); }
.f12-howto > summary::-webkit-details-marker { display: none; }
.f12-howto-pop { position: fixed; top: 56px; right: 16px; left: auto; z-index: 60; width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 72px); overflow-y: auto; padding: 14px 16px; border: var(--f-stroke-ink) solid var(--f-rule); background: var(--f-panel); color: var(--f-ink); font: 400 12.5px/1.5 var(--f-font-body); box-shadow: var(--f-shadow-sheet); display: flex; flex-direction: column; gap: 12px; }
.f12-fg-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding-bottom: 8px; border-bottom: 1.5px solid var(--f-rule); }
.f12-fg-kicker { font: 800 12px/1.2 var(--f-font-mono); letter-spacing: 0.05em; text-transform: uppercase; color: var(--f-ink); }
.f12-fg-close { min-height: 24px; padding: 2px 8px; border: 1.5px solid var(--f-rule); background: var(--f-sheet); color: var(--f-ink); font: 700 11px/1.2 var(--f-font-mono); text-transform: uppercase; cursor: pointer; }
.f12-fg-close:hover { background: var(--f-ink); color: var(--f-sheet); }
.f12-fg-section { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.f12-fg-sec-title { font: 800 11px/1.2 var(--f-font-mono); letter-spacing: 0.05em; text-transform: uppercase; color: var(--f-ink-2); }
.f12-fg-intro, .f12-fg-sub { margin: 0; font: 400 12.5px/1.5 var(--f-font-body); color: var(--f-ink); overflow-wrap: anywhere; }
.f12-fg-sub { color: var(--f-ink-2); font-size: 12px; }
.f12-glossary-list { display: flex; flex-direction: column; gap: 4px; }
.f12-glossary-item { border: 1px solid var(--f-grid); background: var(--f-sheet); min-width: 0; }
.f12-glossary-item > summary { cursor: pointer; padding: 6px 8px; font: 700 12.5px/1.35 var(--f-font-mono); color: var(--f-ink); overflow-wrap: anywhere; }
.f12-glossary-item[open] > summary { border-bottom: 1px dashed var(--f-ink-2); background: var(--f-panel); }
.f12-glossary-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 5px; font: 400 13px/1.45 var(--f-font-body); color: var(--f-ink-2); overflow-wrap: anywhere; }
.f12-glossary-body p { margin: 0; }
.f12-glossary-sum { font-weight: 600; color: var(--f-ink); }
.f12-provenance-list { margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.f12-prov-row { display: grid; grid-template-columns: minmax(120px, 165px) minmax(0, 1fr); gap: 4px 10px; padding: 5px 8px; border: 1px solid var(--f-grid); background: var(--f-sheet); font-size: 12.5px; line-height: 1.4; }
.f12-prov-row dt { font: 700 11.5px/1.35 var(--f-font-mono); text-transform: uppercase; letter-spacing: 0.03em; color: var(--f-ink-2); overflow-wrap: anywhere; }
.f12-prov-row dd { margin: 0; font: 500 12.5px/1.4 var(--f-font-mono); color: var(--f-ink); min-width: 0; overflow-wrap: anywhere; }
.f12-prov-warnings { padding: 6px 8px; border: 1px dashed var(--f-ink-2); background: var(--f-sheet); font: 600 12px/1.4 var(--f-font-mono); color: var(--f-ink); overflow-wrap: anywhere; }
.f12-fg-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; padding-top: 6px; border-top: 1px dashed var(--f-ink-2); font: 500 12px/1.4 var(--f-font-mono); color: var(--f-ink-2); overflow-wrap: anywhere; }
.f12-fg-footer a, .f12-report-footer a { color: var(--f-ink); font-weight: 700; text-decoration: underline; text-underline-offset: 2px; }
.f12-help-more-btn { margin-top: 8px; padding: 4px 9px; border: 1px solid var(--f-ink-2); background: var(--f-sheet); color: var(--f-ink); font: 700 11.5px/1.2 var(--f-font-mono); text-transform: uppercase; cursor: pointer; }
.f12-help-more-btn:hover { background: var(--f-ink); color: var(--f-sheet); }
.f12-reading-finding { border: 1px solid var(--f-ink-2); background: var(--f-sheet); padding: 8px 10px; min-width: 0; }
.f12-reading-finding > summary { cursor: pointer; font: 700 12.5px/1.4 var(--f-font-mono); letter-spacing: 0.01em; color: var(--f-ink); overflow-wrap: anywhere; }
.f12-reading-body { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; border-top: 1px dashed var(--f-ink-2); padding-top: 7px; }
.f12-reading-item { font: 400 13.5px/1.5 var(--f-font-body); color: var(--f-ink-2); overflow-wrap: anywhere; }
.f12-reading-item strong { display: block; font: 700 12px/1.35 var(--f-font-mono); color: var(--f-ink); margin-bottom: 2px; }
.f12-about-panel { position: relative; border: var(--f-stroke-ink) solid var(--f-rule); background: var(--f-panel); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.f12-about-details > summary { cursor: pointer; font: 800 12.5px/1.3 var(--f-font-mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--f-ink); overflow-wrap: anywhere; }
.f12-about-body { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.f12-report-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 14px; padding-top: 8px; border-top: 1px dashed var(--f-ink-2); font: 500 12px/1.4 var(--f-font-mono); color: var(--f-ink-2); overflow-wrap: anywhere; }
.f12-mode-switch { display: inline-flex; border: var(--f-stroke-ink) solid var(--f-rule); background: var(--f-sheet); }
.f12-mode-btn { min-height: 28px; min-width: 28px; padding: 4px 12px; border: 0; background: var(--f-sheet); color: var(--f-ink); font: 800 12px/1.2 var(--f-font-mono); text-transform: uppercase; letter-spacing: 0.04em; cursor: pointer; }
.f12-mode-btn + .f12-mode-btn { border-left: 1.5px solid var(--f-rule); }
.f12-mode-btn[aria-pressed="true"] { background: var(--f-ink); color: var(--f-sheet); }

.f12-help-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; min-height: 24px; width: 24px; height: 24px; padding: 0; border: 1px solid var(--f-ink-2); background: var(--f-sheet); color: var(--f-ink); font: 800 11.5px/1 var(--f-font-mono); cursor: pointer; flex-shrink: 0; }
.f12-help-btn.f12-help-pill { width: auto; padding: 0 7px; gap: 4px; font-size: 11px; letter-spacing: 0.02em; }
.f12-help-btn:hover { background: var(--f-ink); color: var(--f-sheet); }
.f12-help-popover { display: none; position: fixed; inset: auto; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 80; width: min(440px, 92vw); max-height: 80vh; overflow-y: auto; margin: 0; padding: 14px 16px; border: var(--f-stroke-ink) solid var(--f-rule); background: var(--f-panel); color: var(--f-ink); box-shadow: var(--f-shadow-sheet); }
.f12-help-popover:is(:popover-open, .\:popover-open) { display: block; }
.f12-help-title { font: 800 12px/1.3 var(--f-font-mono); letter-spacing: 0.05em; text-transform: uppercase; color: var(--f-ink); margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1.5px solid var(--f-rule); }
.f12-help-popover p { margin: 0; font: 400 13.5px/1.5 var(--f-font-body); color: var(--f-ink); }
.f12-help-popover code { font: 700 12.5px/1.3 var(--f-font-mono); color: var(--f-ink); }

.f12-beat-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 10px; }
.f12-beat-tag { font: 800 11px/1.2 var(--f-font-mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--f-ink-2); }
.f12-jump-btn { display: inline-flex; align-items: center; gap: 4px; min-height: 24px; padding: 2px 8px; border: 1px solid var(--f-ink-2); background: var(--f-sheet); color: var(--f-ink); font: 700 11.5px/1.2 var(--f-font-mono); text-transform: uppercase; cursor: pointer; }
.f12-jump-btn:hover { background: var(--f-ink); color: var(--f-sheet); }
.f12-next-step { border: 0; border-left: var(--f-stroke-ink) solid var(--f-ink-2); background: var(--f-sheet); padding: 8px 10px; font: 500 13.5px/1.45 var(--f-font-body); color: var(--f-ink); }
.f12-next-step strong { display: block; font: 800 11px/1.2 var(--f-font-mono); letter-spacing: 0.05em; text-transform: uppercase; color: var(--f-ink-2); margin-bottom: 3px; }

.f12-briefing { display: flex; flex-direction: column; gap: var(--f-gutter-scene); padding: var(--f-gutter-scene) var(--f-gutter-change) var(--f-gutter-change); background: var(--f-sheet); min-width: 0; }
.f12-stat-strip { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.f12-stat-pill { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border: 1px solid var(--f-ink-2); background: var(--f-panel); font: 700 12.5px/1.25 var(--f-font-mono); color: var(--f-ink-2); }
.f12-stat-pill strong { font: 900 17px/1 var(--f-font-display); color: var(--f-ink); font-variant-numeric: tabular-nums; }

.f12-board-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--f-gutter-scene); align-items: start; }
.f12-cut-panel { position: relative; border: var(--f-stroke-ink) solid var(--f-rule); background: var(--f-panel); padding: 18px 18px 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.f12-cut-c01 { grid-column: span 7; }
.f12-cut-c05 { grid-column: span 5; gap: 12px; }
.f12-cut-label { position: absolute; top: -10px; left: 12px; padding: 1px 6px; background: var(--f-sheet); border: 1.5px solid var(--f-rule); font: 800 11px/1.2 var(--f-font-mono); letter-spacing: 0.06em; color: var(--f-ink); text-transform: uppercase; }

.f12-kicker-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.f12-kicker-left { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.f12-kicker-chip { display: inline-flex; align-items: center; padding: 3px 8px; background: var(--f-marker); color: var(--f-marker-ink); border: 1.5px solid var(--f-rule); font: 800 11px/1.2 var(--f-font-mono); letter-spacing: 0.04em; text-transform: uppercase; }
.f12-tag { display: inline-flex; align-items: center; padding: 2px 7px; border: 1px solid var(--f-ink-2); background: var(--f-sheet); color: var(--f-ink); font: 700 11.5px/1.2 var(--f-font-mono); letter-spacing: 0.03em; text-transform: uppercase; }
.f12-last-date { font: 600 12px/1.2 var(--f-font-mono); color: var(--f-ink-2); }
.f12-headline { margin: 2px 0 0; font: 900 clamp(21px, 2.2vw, 28px)/1.12 var(--f-font-display); letter-spacing: -0.01em; color: var(--f-ink); overflow-wrap: anywhere; }
.f12-lede { margin: 0; font: 400 15.5px/1.55 var(--f-font-body); color: var(--f-ink-2); max-width: 72ch; overflow-wrap: anywhere; }

.f12-plate-wrap { position: relative; border: var(--f-stroke-ink) solid var(--f-rule); background: #0e2540; overflow: hidden; margin-top: 2px; }
.f12-plate-svg { display: block; width: 100%; height: auto; aspect-ratio: 760 / 420; user-select: none; -webkit-user-select: none; touch-action: none; cursor: grab; }
.f12-plate-svg.is-panning { cursor: grabbing; }
.f12-plate-node { cursor: grab; }
.f12-plate-node.is-dragging { cursor: grabbing; }
.f12-plate-edge-hit { cursor: pointer; }
.f12-plate-balloon { pointer-events: none; }
.f12-plate-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px; padding: 8px 12px; background: #09192c; border-top: 1.5px solid #173b61; color: #fffef9; font: 600 11.5px/1.35 var(--f-font-mono); }
.f12-plate-footer-right { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.f12-plate-reset-btn { min-height: 24px; min-width: 24px; padding: 2px 8px; border: 1px solid #fffef9; background: #13304f; color: #fffef9; font: 700 11px/1.2 var(--f-font-mono); text-transform: uppercase; letter-spacing: 0.04em; cursor: pointer; }
.f12-plate-reset-btn:hover, .f12-plate-reset-btn[aria-pressed="true"] { background: #173b61; }
.f12-plate-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.f12-plate-legend-item { display: inline-flex; align-items: center; gap: 6px; }

.f12-dir-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.f12-dir-box { border: 1px solid var(--f-ink-2); background: var(--f-sheet); padding: 10px; min-width: 0; }
.f12-dir-pair { font: 700 13px/1.35 var(--f-font-mono); color: var(--f-ink); overflow-wrap: anywhere; margin-bottom: 4px; }
.f12-dir-pct { font: 900 24px/1.08 var(--f-font-display); color: var(--f-ink); font-variant-numeric: tabular-nums; }
.f12-dir-sub { font: 500 12.5px/1.4 var(--f-font-mono); color: var(--f-ink-2); margin-top: 4px; overflow-wrap: anywhere; }
.f12-dir-asymmetry { margin: 0; font: 400 13.5px/1.45 var(--f-font-body); color: var(--f-ink-2); overflow-wrap: anywhere; }

.f12-meta-strip { display: flex; flex-wrap: wrap; gap: 6px; }
.f12-meta-pill { display: inline-flex; align-items: center; padding: 3px 8px; border: 1px solid var(--f-grid); background: var(--f-sheet); font: 600 12.5px/1.35 var(--f-font-mono); color: var(--f-ink); overflow-wrap: anywhere; }

.f12-family-pairs { border: 1px solid var(--f-ink-2); background: var(--f-sheet); padding: 8px 10px; }
.f12-family-pairs-hdr { font: 800 11.5px/1.2 var(--f-font-mono); color: var(--f-ink-2); letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 6px; }
.f12-family-pair-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; width: 100%; padding: 5px 6px; border: 0; border-top: 1px dashed var(--f-grid); background: transparent; text-align: left; cursor: pointer; font: 600 12.5px/1.35 var(--f-font-mono); color: var(--f-ink); }
.f12-family-pair-row:first-of-type { border-top: 0; }
.f12-family-pair-row:hover { background: var(--f-panel); }

.f12-counterexamples { border: 1px dashed var(--f-ink-2); background: var(--f-sheet); padding: 7px 10px; font: 600 12.5px/1.4 var(--f-font-mono); color: var(--f-ink); }
.f12-counterexamples summary { cursor: pointer; overflow-wrap: anywhere; }
.f12-cx-list { margin: 8px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; font-weight: 500; color: var(--f-ink-2); }

.f12-receipts-hdr { font: 800 11.5px/1.2 var(--f-font-mono); letter-spacing: 0.05em; text-transform: uppercase; color: var(--f-ink-2); margin-top: 2px; }
.f12-receipts-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.f12-receipt-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: baseline; padding: 5px 8px; border: 1px solid var(--f-grid); background: var(--f-sheet); font: 500 13.5px/1.4 var(--f-font-body); }
.f12-receipt-hash { padding: 2px 6px; border: 1px solid var(--f-ink-2); background: var(--f-panel); font: 700 12px/1.2 var(--f-font-mono); color: var(--f-ink); cursor: pointer; }
.f12-receipt-subj { min-width: 0; overflow-wrap: anywhere; color: var(--f-ink); }
.f12-receipt-date { font: 600 12px/1.2 var(--f-font-mono); color: var(--f-ink-2); white-space: nowrap; }

.f12-cli-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border: 1px solid var(--f-ink-2); background: var(--f-sheet); margin-top: auto; }
.f12-cli-code { flex: 1 1 200px; min-width: 0; font: 600 12.5px/1.4 var(--f-font-mono); color: var(--f-ink); overflow-wrap: anywhere; }
.f12-copy-btn { padding: 4px 10px; border: 1.5px solid var(--f-rule); background: var(--f-ink); color: var(--f-sheet); font: 800 11.5px/1.2 var(--f-font-mono); text-transform: uppercase; letter-spacing: 0.04em; cursor: pointer; }

.f12-secondary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--f-gutter-scene); }
.f12-sec-card { position: relative; display: flex; flex-direction: column; gap: 6px; width: 100%; text-align: left; padding: 16px 14px 14px; border: var(--f-stroke-ink) solid var(--f-rule); background: var(--f-panel); color: var(--f-ink); cursor: pointer; }
.f12-sec-card:hover { background: var(--f-sheet); }
.f12-sec-card.selected { background-image: radial-gradient(circle, var(--f-tone) 0.65px, transparent 0.65px); background-size: 12px 12px; }
.f12-sec-pair { font: 800 14px/1.3 var(--f-font-mono); color: var(--f-ink); overflow-wrap: anywhere; }
.f12-sec-sub { font: 500 13px/1.4 var(--f-font-mono); color: var(--f-ink-2); overflow-wrap: anywhere; }
.f12-ci-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; margin: 2px 0; }
.f12-ci-pct { font: 900 19px/1 var(--f-font-display); color: var(--f-ink); font-variant-numeric: tabular-nums; }
.f12-ci-track { position: relative; height: 14px; border: 1px solid var(--f-ink-2); background: var(--f-sheet); overflow: hidden; }
.f12-ci-fill { position: absolute; top: 0; bottom: 0; border-left: 1px solid var(--f-rule); border-right: 1px solid var(--f-rule); background-image: repeating-linear-gradient(-45deg, var(--f-tone) 0, var(--f-tone) 2px, transparent 2px, transparent 5px); opacity: 0.72; }
.f12-ci-tick { position: absolute; top: -1px; bottom: -1px; width: 2.5px; background: var(--f-ink); }
.f12-ci-bounds { font: 700 12px/1.2 var(--f-font-mono); color: var(--f-ink-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.f12-sec-rev { font: 500 13px/1.4 var(--f-font-mono); color: var(--f-ink-2); overflow-wrap: anywhere; }
.f12-sec-receipt { font: 500 13px/1.4 var(--f-font-mono); color: var(--f-ink-2); padding-top: 4px; border-top: 1px dashed var(--f-grid); overflow-wrap: anywhere; }

.f12-ranked-panel { position: relative; border: var(--f-stroke-ink) solid var(--f-rule); background: var(--f-panel); padding: 18px 18px 14px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.f12-ranked-hdr { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.f12-ranked-title { margin: 0; font: 900 18px/1.15 var(--f-font-display); text-transform: uppercase; letter-spacing: 0.02em; color: var(--f-ink); }
.f12-ranked-list { display: flex; flex-direction: column; gap: 6px; }
.f12-rank-row { display: grid; grid-template-columns: auto minmax(0, 1.5fr) auto auto minmax(120px, 1.2fr) auto auto; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 7px 10px; border: 1px solid var(--f-ink-2); background: var(--f-sheet); color: var(--f-ink); cursor: pointer; font: 600 13.5px/1.35 var(--f-font-mono); }
.f12-rank-row:hover { background: var(--f-panel); }
.f12-rank-row.active { border: var(--f-stroke-ink) solid var(--f-rule); background-image: repeating-linear-gradient(-45deg, var(--f-grid) 0, var(--f-grid) 2px, transparent 2px, transparent 6px); }
.f12-rank-id { padding: 2px 6px; border: 1px solid var(--f-ink-2); background: var(--f-panel); font: 800 11.5px/1.2 var(--f-font-mono); color: var(--f-ink); }
.f12-rank-row.active .f12-rank-id { background: var(--f-ink); color: var(--f-sheet); border-color: var(--f-rule); }
.f12-rank-pair { min-width: 0; overflow-wrap: anywhere; font-weight: 700; color: var(--f-ink); }
.f12-rank-ratio { font-variant-numeric: tabular-nums; color: var(--f-ink); }
.f12-toggle-all-btn { width: 100%; padding: 8px 12px; border: 1px dashed var(--f-ink-2); background: var(--f-sheet); color: var(--f-ink); font: 800 12.5px/1.35 var(--f-font-mono); text-transform: uppercase; letter-spacing: 0.04em; cursor: pointer; text-align: center; }

@media (forced-colors: active) {
  html, body, .app, .bar, .panel, .card, .pair-box, .cli-box, .map-btn, .toggle, .tab-btn, .badge, .cut-chip, .cut-section-label, .f12-cut-panel, .f12-sec-card, .f12-ranked-panel, .f12-rank-row, .f12-help-btn, .f12-help-popover {
    forced-color-adjust: auto;
    background-color: Canvas;
    color: CanvasText;
    border-color: CanvasText;
  }
  .badge.marker-active, .card.selected, .f12-kicker-chip.marker-active {
    background-color: Highlight;
    color: HighlightText;
    border-color: Highlight;
  }
}

@media (max-width: 960px) {
  html, body { height: auto; overflow-x: hidden; }
  .app, .app[data-view="briefing"], .app[data-view="atlas"] { display: flex; flex-direction: column; height: auto; min-height: 100vh; width: 100%; max-width: 100vw; overflow-x: hidden; }
  .bar { order: 1; padding: 10px 12px; gap: 8px; }
  .f12-briefing { order: 2; padding: 12px; gap: 14px; }
  .panel { order: 2; border-left: 0; border-bottom: var(--f-stroke-ink) solid var(--f-rule); padding: var(--f-gutter-pair); overflow-y: visible; }
  .stage { order: 3; height: 70vh; min-height: 360px; width: 100%; }
  canvas { touch-action: pan-y; }
  .search input { width: 100%; }
  .controls, .search { width: 100%; gap: 6px; }
  .cochange-grid, .f12-dir-grid, .f12-secondary-grid { grid-template-columns: 1fr; }
  .f12-board-grid { display: flex; flex-direction: column; gap: 14px; }
  .f12-cut-c05 { clip-path: none; padding-bottom: 16px; }
  .f12-kicker-left .f12-tag, .f12-kicker-chip, .f12-last-date, .f12-ci-bounds { white-space: normal; }
  .f12-rank-row { grid-template-columns: auto minmax(0, 1fr) auto; }
  .f12-rank-row .f12-tag, .f12-rank-row .f12-ci-track, .f12-rank-row .f12-last-date { display: none; }
}

@media (max-width: 640px) {
  h1 { font-size: 16px; line-height: 1.15; }
  .masthead-rule, .summary { display: none; }
  .f12-stat-strip { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
  .f12-stat-pill { padding: 4px 8px; gap: 6px; font-size: 10.5px; min-width: 0; overflow-wrap: anywhere; }
  .f12-stat-pill strong { font-size: 14px; }
  .f12-plate-svg { aspect-ratio: 340 / 240; }
  .f12-cut-panel { padding: 14px 12px 12px; gap: 8px; }
  .f12-howto { width: 100%; }
  .f12-howto-pop { position: static; width: 100%; max-width: 100%; max-height: none; margin-top: 6px; padding: 10px; box-shadow: none; }
  .f12-prov-row { grid-template-columns: 1fr; gap: 2px; }
}

@media (max-width: 400px) {
  .bar { padding: 8px; }
  .f12-briefing { padding: 8px; gap: 10px; }
  .f12-stat-strip { grid-template-columns: 1fr; }
  .f12-cli-code { flex-basis: 100%; }
}

@media print {
  :root, :root[data-theme="dark"], :root[data-theme="light"] {
    --f-desk: #ffffff;
    --f-sheet: #ffffff;
    --f-panel: #ffffff;
    --f-ink: #121212;
    --f-ink-2: #4b4b4b;
    --f-rule: #121212;
    --f-grid: #e3e3e3;
    --f-marker: #ffd60a;
    --f-marker-ink: #121212;
    color-scheme: light;
  }
  html, body { height: auto; background: #ffffff; color: #121212; }
  .app { display: flex; flex-direction: column; height: auto; box-shadow: none; }
  .bar { order: 1; }
  .panel { order: 2; border-left: 0; border-bottom: var(--f-stroke-ink) solid #121212; overflow: visible; padding: var(--f-gutter-pair) 0; }
  .stage { order: 3; height: auto; min-height: 0; margin-top: var(--f-gutter-scene); }
  .controls, .stage-overlay, .hint, canvas, .tab-group, .view-all-btn, .btn-export, .cli-box { display: none !important; }
  .print-map-img { display: block !important; width: 100%; height: auto; border: var(--f-stroke-ink) solid #121212; margin-bottom: var(--f-gutter-scene); }
}
`;

const RICH_CLIENT = String.raw`
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('ra-data').textContent);
  var KINDS = {
    ghost: { label: 'Ghost wires' },
    unknown: { label: 'Unchecked' },
    indirect: { label: 'Indirect imports' },
    direct: { label: 'Import links' },
    test: { label: 'Test links' }
  };
  var ORDER = ['ghost', 'unknown', 'indirect', 'direct', 'test'];

  function sanitizeText(value) {
    return String(value == null ? '' : value).replace(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g,
      function (ch) {
        if (ch === '\n') return '\\n';
        if (ch === '\r') return '\\r';
        if (ch === '\t') return '\\t';
        var code = ch.charCodeAt(0);
        return code <= 255
          ? '\\x' + ('00' + code.toString(16)).slice(-2)
          : '\\u' + ('0000' + code.toString(16)).slice(-4);
      }
    );
  }

  function middleTruncate(str, maxLen) {
    var clean = sanitizeText(str);
    if (clean.length <= maxLen) return clean;
    var keep = Math.max(4, maxLen - 1);
    var head = Math.ceil(keep / 2);
    var tail = Math.floor(keep / 2);
    return clean.slice(0, head) + '\u2026' + clean.slice(clean.length - tail);
  }

  function hasKindInData(kind) {
    if (data.edges.some(function (e) { return e.relationship === kind; })) return true;
    return (data.families || []).some(function (f) {
      return (f.undrawnPairs || []).some(function (up) { return up.relationship === kind; });
    });
  }
  var hasPrimary = data.edges.some(function (e) { return e.relationship !== 'unknown'; });
  var visible = {
    ghost: hasKindInData('ghost'),
    unknown: !hasPrimary && hasKindInData('unknown'),
    indirect: hasKindInData('indirect'),
    direct: hasKindInData('direct'),
    test: hasKindInData('test')
  };

  var motionMedia = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var darkMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var contrastMedia = window.matchMedia ? window.matchMedia('(prefers-contrast: more)') : null;
  var forcedColorsMedia = window.matchMedia ? window.matchMedia('(forced-colors: active)') : null;
  var reduceMotion = Boolean(motionMedia && motionMedia.matches);
  var highContrast = Boolean(contrastMedia && contrastMedia.matches);
  var forcedColors = Boolean(forcedColorsMedia && forcedColorsMedia.matches);

  var themeMode = 'system';
  try {
    var savedTheme = window.localStorage ? window.localStorage.getItem('ra-theme') : null;
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
      themeMode = savedTheme;
    }
  } catch (_) {}

  var themeToggleBtn = document.getElementById('theme-toggle');
  var dirColorBtn = document.getElementById('toggle-dir-color');
  var fcProbe = document.getElementById('fc-probe');
  var colorByDir = false;
  var themeColors = null;

  function effectiveTheme() {
    if (themeMode === 'light' || themeMode === 'dark') return themeMode;
    return darkMedia && darkMedia.matches ? 'dark' : 'light';
  }

  function invalidateThemeColors() {
    themeColors = null;
  }

  function applyThemeMode(mode, persist) {
    themeMode = mode;
    var root = document.documentElement;
    root.setAttribute('data-theme-mode', mode);
    if (mode === 'light' || mode === 'dark') {
      root.setAttribute('data-theme', mode);
    } else {
      root.removeAttribute('data-theme');
    }
    if (themeToggleBtn) {
      var label = mode === 'system' ? 'Theme: System' : (mode === 'light' ? 'Theme: Light' : 'Theme: Dark');
      themeToggleBtn.textContent = label;
      themeToggleBtn.setAttribute('data-theme-mode', mode);
    }
    if (persist) {
      try {
        if (window.localStorage) window.localStorage.setItem('ra-theme', mode);
      } catch (_) {}
    }
    invalidateThemeColors();
  }
  applyThemeMode(themeMode, false);

  function getThemeColors() {
    if (themeColors) return themeColors;
    var style = window.getComputedStyle ? window.getComputedStyle(document.documentElement) : null;
    function readVar(name, fallback) {
      if (!style) return fallback;
      var v = style.getPropertyValue(name);
      return v && v.trim() ? v.trim() : fallback;
    }
    var isDark = effectiveTheme() === 'dark';
    var colors = {
      desk: readVar('--f-desk', isDark ? '#000000' : '#e2e3e5'),
      sheet: readVar('--f-sheet', isDark ? '#050505' : '#ffffff'),
      panel: readVar('--f-panel', isDark ? '#19191a' : '#ffffff'),
      ink: readVar('--f-ink', isDark ? '#f1f0ea' : '#121212'),
      ink2: readVar('--f-ink-2', isDark ? '#b9b8b1' : '#4b4b4b'),
      rule: readVar('--f-rule', isDark ? '#f1f0ea' : '#121212'),
      grid: readVar('--f-grid', isDark ? '#2c2c2d' : '#e3e3e3'),
      marker: readVar('--f-marker', '#ffd60a'),
      markerInk: readVar('--f-marker-ink', '#121212'),
      fontDisplay: readVar('--f-font-display', '"Arial Black", "Helvetica Neue", sans-serif'),
      fontMono: readVar('--f-font-mono', 'ui-monospace, "SF Mono", Menlo, Consolas, monospace')
    };
    if (highContrast) {
      colors.ink2 = colors.ink;
    }
    if (forcedColors && fcProbe && window.getComputedStyle) {
      var probeStyle = window.getComputedStyle(fcProbe);
      var fg = probeStyle.color && probeStyle.color.trim() ? probeStyle.color.trim() : colors.ink;
      var bg = probeStyle.backgroundColor && probeStyle.backgroundColor.trim() ? probeStyle.backgroundColor.trim() : colors.sheet;
      var hi = probeStyle.borderColor && probeStyle.borderColor.trim() ? probeStyle.borderColor.trim() : colors.marker;
      colors.sheet = bg;
      colors.panel = bg;
      colors.ink = fg;
      colors.ink2 = fg;
      colors.rule = fg;
      colors.marker = hi;
    }
    themeColors = colors;
    return colors;
  }

  var canvas = document.getElementById('map');
  var printImg = document.getElementById('print-map-img');
  var ctx = canvas.getContext('2d');
  var tooltip = document.getElementById('tooltip');
  var panel = document.getElementById('panel');
  var search = document.getElementById('search');
  var resetBtn = document.getElementById('reset-view');
  var hintEl = typeof document.querySelector === 'function' ? document.querySelector('.hint') : null;
  function updateTouchHint() {
    if (hintEl) hintEl.textContent = 'Two fingers to pan and zoom';
  }
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
    updateTouchHint();
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function pct(x) { return Math.floor(x * 100 + 1e-9) + '%'; }
  function formatCi(iv, raw) {
    return '(' + (raw ? 'raw ' : '') + '95% CI ' + Math.floor(iv.low * 100 + 1e-9) + '\u2013' + Math.ceil(iv.high * 100 - 1e-9) + '%)';
  }
  function base(p) { var i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
  function distinguishingPaths(a, b) {
    var aParts = a.split('/'), bParts = b.split('/');
    for (var depth = 1; depth <= Math.max(aParts.length, bParts.length); depth++) {
      var aLabel = aParts.slice(-depth).join('/');
      var bLabel = bParts.slice(-depth).join('/');
      if (aLabel !== bLabel) return [aLabel, bLabel];
    }
    return [a, b];
  }
  function plural(n, w) { return n.toLocaleString('en-US') + ' ' + w + (n === 1 ? '' : 's'); }
  function relativeDate(date) {
    var days = Math.max(0, Math.floor((Date.parse(data.generatedAt) - Date.parse(date)) / 86400000));
    if (days < 1) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 45) return days + ' days ago';
    var months = Math.round(days / 30.44);
    if (months < 18) return months + ' ' + (months === 1 ? 'month' : 'months') + ' ago';
    var years = (days / 365.25).toFixed(1).replace(/\.0$/, '');
    return years + ' years ago';
  }
  function capitalize(text) { return text.charAt(0).toUpperCase() + text.slice(1); }

  function hashHue(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h) % 360;
  }
  function directoryColor(dir) {
    var hue = hashHue(dir || '.');
    var lightness = effectiveTheme() === 'dark' ? 68 : 32;
    return 'hsl(' + hue + ', 52%, ' + lightness + '%)';
  }

  function createSwatchSvg(kind) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'swatch-svg swatch ' + kind);
    svg.setAttribute('viewBox', '0 0 26 10');
    svg.setAttribute('aria-hidden', 'true');
    var line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', '1');
    line.setAttribute('y1', '5');
    line.setAttribute('x2', '25');
    line.setAttribute('y2', '5');
    if (kind === 'ghost') {
      line.setAttribute('stroke', 'var(--f-ink)');
      line.setAttribute('stroke-width', '2.5');
      line.setAttribute('stroke-dasharray', '8 5');
    } else if (kind === 'direct') {
      line.setAttribute('stroke', 'var(--f-ink)');
      line.setAttribute('stroke-width', '2.2');
    } else if (kind === 'indirect') {
      line.setAttribute('stroke', 'var(--f-ink-2)');
      line.setAttribute('stroke-width', '1.6');
    } else if (kind === 'unknown') {
      line.setAttribute('stroke', 'var(--f-ink-2)');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-dasharray', '1.5 4');
    } else {
      line.setAttribute('stroke', 'var(--f-ink-2)');
      line.setAttribute('stroke-width', '1.2');
    }
    svg.appendChild(line);
    return svg;
  }

  var nodes = data.nodes.map(function (n, i) {
    return {
      i: i,
      path: n.path,
      safePath: sanitizeText(n.path),
      dir: n.dir,
      safeDir: sanitizeText(n.dir),
      changes: n.changes,
      author: n.topAuthor ? sanitizeText(n.topAuthor) : undefined,
      share: n.topAuthorShare,
      r: 4 + Math.min(14, Math.sqrt(n.changes) * 1.25),
      x: 0,
      y: 0,
      active: true,
      frame: null,
      edges: []
    };
  });
  var edges = data.edges.map(function (e, idx) {
    var low = e.interval && typeof e.interval.low === 'number' ? e.interval.low : 0;
    var revLow = e.reverseInterval && typeof e.reverseInterval.low === 'number' ? e.reverseInterval.low : 0;
    var isWeak = (e.relationship === 'ghost' || e.relationship === 'unknown') && low < 0.3;
    var edge = {
      idx: idx,
      s: nodes[e.source],
      t: nodes[e.target],
      d: e,
      lowBound: Math.max(low, revLow),
      weak: isWeak,
      frame: null
    };
    edge.s.edges.push(edge);
    edge.t.edges.push(edge);
    return edge;
  });

  function edgeKey(a, b) {
    return a < b ? a + '\0' + b : b + '\0' + a;
  }
  var nodeByPath = Object.create(null);
  nodes.forEach(function (n) { nodeByPath[n.path] = n; });
  var edgeByPairKey = Object.create(null);
  edges.forEach(function (e) { edgeByPairKey[edgeKey(e.s.path, e.t.path)] = e; });

  var families = (data.families || []).map(function (f) {
    var famEdges = [];
    (f.edgeIndices || []).forEach(function (idx) {
      if (edges[idx]) famEdges.push(edges[idx]);
    });
    var relList = f.relationships || f.pairs;
    if (famEdges.length === 0 && relList) {
      relList.forEach(function (p) {
        var found = edgeByPairKey[edgeKey(p.from, p.to)];
        if (found) famEdges.push(found);
      });
    }
    var famNodes = [];
    (f.members || []).forEach(function (m) {
      var n = typeof m.nodeIndex === 'number' && nodes[m.nodeIndex] ? nodes[m.nodeIndex] : nodeByPath[m.path];
      if (n) famNodes.push(n);
    });
    return { d: f, members: f.members || [], edges: famEdges, undrawnPairs: f.undrawnPairs || [], nodes: famNodes };
  });

  var baseCounts = Object.create(null);
  nodes.forEach(function (n) {
    var b = base(n.safePath);
    baseCounts[b] = (baseCounts[b] || 0) + 1;
  });
  function getNodeLabel(n) {
    var b = base(n.safePath);
    if (baseCounts[b] <= 1) return middleTruncate(b, 26);
    var parts = n.safePath.split('/');
    if (parts.length >= 2) return middleTruncate(parts.slice(-2).join('/'), 26);
    return middleTruncate(n.safePath, 26);
  }

  var layoutEl = document.getElementById('ra-layout');
  var precomputed = null;
  if (layoutEl && layoutEl.textContent) {
    try { precomputed = JSON.parse(layoutEl.textContent); } catch (_) { precomputed = null; }
  }
  var frames = [];
  if (
    precomputed &&
    Array.isArray(precomputed.x) &&
    Array.isArray(precomputed.y) &&
    precomputed.x.length === nodes.length &&
    precomputed.y.length === nodes.length &&
    precomputed.x.every(function (v) { return typeof v === 'number' && Number.isFinite(v); }) &&
    precomputed.y.every(function (v) { return typeof v === 'number' && Number.isFinite(v); })
  ) {
    for (var li = 0; li < nodes.length; li++) {
      nodes[li].x = precomputed.x[li];
      nodes[li].y = precomputed.y[li];
    }
    if (Array.isArray(precomputed.frames)) {
      frames = precomputed.frames.map(function (f) {
        var fNodes = (f.nodeIndices || []).map(function (ni) { return nodes[ni]; }).filter(Boolean);
        var fEdges = (f.edgeIndices || []).map(function (ei) { return edges[ei]; }).filter(Boolean);
        var frameObj = {
          id: sanitizeText(f.id),
          index: f.index,
          band: f.band,
          caption: sanitizeText(f.caption),
          directionalSummary: f.directionalSummary ? sanitizeText(f.directionalSummary) : '',
          leadFile: f.leadFile ? sanitizeText(f.leadFile) : '',
          bridgedSubgroups: typeof f.bridgedSubgroups === 'number' ? f.bridgedSubgroups : 0,
          weak: Boolean(f.weak),
          cols: f.cols,
          row: f.row,
          x: f.x,
          y: f.y,
          w: f.w,
          h: f.h,
          pad: f.pad,
          nodes: fNodes,
          edges: fEdges,
          leadEdge: typeof f.leadEdgeIndex === 'number' && edges[f.leadEdgeIndex] ? edges[f.leadEdgeIndex] : (fEdges[0] || null)
        };
        fNodes.forEach(function (n) { n.frame = frameObj; });
        fEdges.forEach(function (e) { e.frame = frameObj; });
        return frameObj;
      });
    }
  }

  var m = data.meta;
  var span = m.oldestCommit && m.newestCommit ? ' between ' + m.oldestCommit + ' and ' + m.newestCommit : '';
  function updateSummary() {
    var shown = edges.filter(function (e) { return visible[e.d.relationship]; }).length;
    document.getElementById('summary').textContent =
      'Analyzed ' + plural(m.commitsAnalyzed, 'commit') + span + '. Loaded ' + plural(edges.length, 'relationship') +
      ' across ' + plural(frames.length, 'cut frame') + ' and showing ' + shown.toLocaleString('en-US') +
      ' (each at least ' + m.settings.minShared + ' shared commits and ' + pct(m.settings.minConfidence) + ' confidence).';
  }
  updateSummary();

  var activeNodesList = [];
  var edgesByKind = { test: [], direct: [], indirect: [], unknown: [], ghost: [] };
  edges.forEach(function (e) {
    if (edgesByKind[e.d.relationship]) edgesByKind[e.d.relationship].push(e);
  });
  function syncActiveNodes() {
    activeNodesList = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var act = false;
      for (var k = 0; k < n.edges.length; k++) {
        if (visible[n.edges[k].d.relationship]) { act = true; break; }
      }
      n.active = act;
      if (act) activeNodesList.push(n);
    }
  }
  syncActiveNodes();

  var selectedNode = null, selectedEdge = null, selectedFamily = null, hoverNode = null, hoverEdge = null, hoverFamily = null, matches = null;
  var returnToFamily = null, expandedFamilyPairKey = null;
  var overviewTab = 'ghost';
  var overviewExpanded = false;
  var animPaused = false;

  function isVisible(e) { return Boolean(visible[e.d.relationship]); }
  function isActive(n) { return Boolean(n.active); }

  var toggles = document.getElementById('toggles');
  function ensureRelationshipVisible(rel) {
    if (!rel || visible[rel]) return;
    visible[rel] = true;
    if (toggles) {
      var btns = toggles.querySelectorAll('.toggle[data-kind]');
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].getAttribute('data-kind') === rel) {
          btns[i].classList.remove('off');
          btns[i].setAttribute('aria-pressed', 'true');
        }
      }
    }
    syncActiveNodes();
    updateSummary();
  }
  ORDER.forEach(function (kind) {
    var shown = edges.filter(function (e) { return e.d.relationship === kind; }).length;
    if (shown === 0 && !hasKindInData(kind)) return;
    var b = el('button', 'toggle' + (visible[kind] ? '' : ' off'));
    b.type = 'button';
    b.setAttribute('data-kind', kind);
    b.setAttribute('aria-pressed', String(visible[kind]));
    if (kind === 'unknown') b.title = 'Hidden by default when other links exist: import status could not be verified';
    b.appendChild(createSwatchSvg(kind));
    b.appendChild(el('span', '', KINDS[kind].label));
    b.appendChild(el('span', 'count', String(shown)));
    b.addEventListener('click', function () {
      visible[kind] = !visible[kind];
      b.classList.toggle('off', !visible[kind]);
      b.setAttribute('aria-pressed', String(visible[kind]));
      syncActiveNodes();
      if (selectedEdge && !visible[selectedEdge.d.relationship]) selectedEdge = null;
      if (selectedFamily && !resolveActiveFamilyView(selectedFamily)) selectedFamily = null;
      if (returnToFamily && !resolveActiveFamilyView(returnToFamily)) returnToFamily = null;
      updateSummary();
      renderPanel();
      requestDraw();
    });
    toggles.appendChild(b);
  });

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', function () {
      var next = themeMode === 'system' ? 'light' : (themeMode === 'light' ? 'dark' : 'system');
      applyThemeMode(next, true);
      if (colorByDir) renderPanel();
      requestDraw();
    });
  }
  if (dirColorBtn) {
    dirColorBtn.addEventListener('click', function () {
      colorByDir = !colorByDir;
      dirColorBtn.setAttribute('aria-pressed', String(colorByDir));
      renderPanel();
      requestDraw();
    });
  }

  // ---- camera --------------------------------------------------------------
  var cam = { x: 0, y: 0, scale: 1 };
  var size = { w: 0, h: 0, dpr: 1 };
  function resizeNow() {
    var rect = canvas.getBoundingClientRect();
    var rw = rect.width > 0 ? rect.width : (canvas.clientWidth || 800);
    var rh = rect.height > 0 ? rect.height : (canvas.clientHeight || 600);
    var maxScale = Math.sqrt(16000000 / Math.max(1, rw * rh));
    var dpr = Math.min(window.devicePixelRatio || 1, 2, maxScale);
    size.dpr = dpr;
    size.w = rw; size.h = rh;
    canvas.width = Math.round(rw * dpr);
    canvas.height = Math.round(rh * dpr);
    requestDraw();
  }

  function rectBounds(minX, minY, maxX, maxY, padPx) {
    var w = Math.max(1, size.w);
    var h = Math.max(1, size.h);
    var pad = padPx != null ? padPx : 64;
    var topClearance = 44;
    var availH = Math.max(120, h - topClearance);
    var spanW = Math.max(1, maxX - minX + pad * 2);
    var spanH = Math.max(1, maxY - minY + pad * 2);
    var scale = Math.max(0.15, Math.min(2.0, Math.min(w / spanW, availH / spanH)));
    return {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2 - (topClearance / 2) / scale,
      scale: scale
    };
  }

  function fitSheet() {
    if (frames.length > 0) {
      var initialFrames = frames.slice(0, Math.min(frames.length, 12));
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      initialFrames.forEach(function (f) {
        if (f.x < minX) minX = f.x;
        if (f.y < minY) minY = f.y;
        if (f.x + f.w > maxX) maxX = f.x + f.w;
        if (f.y + f.h > maxY) maxY = f.y + f.h;
      });
      var b = rectBounds(minX, minY, maxX, maxY, 36);
      cam.x = b.x; cam.y = b.y; cam.scale = b.scale;
      return;
    }
    if (activeNodesList.length > 0) {
      var nMinX = Infinity, nMinY = Infinity, nMaxX = -Infinity, nMaxY = -Infinity;
      activeNodesList.forEach(function (n) {
        nMinX = Math.min(nMinX, n.x - n.r); nMaxX = Math.max(nMaxX, n.x + n.r);
        nMinY = Math.min(nMinY, n.y - n.r); nMaxY = Math.max(nMaxY, n.y + n.r);
      });
      var nb = rectBounds(nMinX, nMinY, nMaxX, nMaxY, 80);
      cam.x = nb.x; cam.y = nb.y; cam.scale = nb.scale;
    }
  }

  var flight = null;
  function flyToTarget(targetBounds) {
    if (!targetBounds) return;
    if (reduceMotion) {
      cam.x = targetBounds.x;
      cam.y = targetBounds.y;
      cam.scale = targetBounds.scale;
      requestDraw();
      return;
    }
    flight = {
      from: { x: cam.x, y: cam.y, scale: cam.scale },
      to: targetBounds,
      start: performance.now()
    };
    requestDraw();
  }
  function flyToFrame(frameObj) {
    if (!frameObj) return;
    flyToTarget(rectBounds(frameObj.x, frameObj.y, frameObj.x + frameObj.w, frameObj.y + frameObj.h, 32));
  }
  function flyToNodes(list) {
    if (!list || list.length === 0) return;
    if (list[0] && list[0].frame) {
      var sameFrame = list.every(function (n) { return n.frame === list[0].frame; });
      if (sameFrame) {
        flyToFrame(list[0].frame);
        return;
      }
    }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    list.forEach(function (n) {
      var f = n.frame;
      if (f) {
        minX = Math.min(minX, f.x); maxX = Math.max(maxX, f.x + f.w);
        minY = Math.min(minY, f.y); maxY = Math.max(maxY, f.y + f.h);
      } else {
        minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r);
        minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r);
      }
    });
    flyToTarget(rectBounds(minX, minY, maxX, maxY, 40));
  }
  function stepFlight(now) {
    if (!flight) return false;
    var t = Math.min(1, (now - flight.start) / 420);
    var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    cam.x = flight.from.x + (flight.to.x - flight.from.x) * e;
    cam.y = flight.from.y + (flight.to.y - flight.from.y) * e;
    cam.scale = flight.from.scale + (flight.to.scale - flight.from.scale) * e;
    if (t >= 1) flight = null;
    return true;
  }
  function toWorld(px, py) {
    return { x: (px - size.w / 2) / cam.scale + cam.x, y: (py - size.h / 2) / cam.scale + cam.y };
  }

  // ---- families & marker budget --------------------------------------------
  function getActiveFamilyViews(fam) {
    if (!fam) return [];
    var activeEdges = fam.edges.filter(isVisible);
    var activeUndrawn = (fam.undrawnPairs || []).filter(function (up) {
      return Boolean(visible[up.relationship]);
    });
    if (activeEdges.length + activeUndrawn.length < 2) return [];
    var adj = Object.create(null);
    fam.members.forEach(function (m) { adj[m.path] = []; });
    activeEdges.forEach(function (e) {
      if (adj[e.s.path] && adj[e.t.path]) {
        adj[e.s.path].push(e.t.path);
        adj[e.t.path].push(e.s.path);
      }
    });
    activeUndrawn.forEach(function (up) {
      if (adj[up.from] && adj[up.to]) {
        adj[up.from].push(up.to);
        adj[up.to].push(up.from);
      }
    });
    var visited = Object.create(null);
    var views = [];
    fam.members.forEach(function (m) {
      if (visited[m.path] || !adj[m.path] || adj[m.path].length === 0) return;
      var compPaths = Object.create(null);
      var queue = [m.path];
      visited[m.path] = true;
      compPaths[m.path] = true;
      for (var q = 0; q < queue.length; q++) {
        var cur = queue[q];
        var nbrs = adj[cur] || [];
        for (var k = 0; k < nbrs.length; k++) {
          var nxt = nbrs[k];
          if (!visited[nxt]) {
            visited[nxt] = true;
            compPaths[nxt] = true;
            queue.push(nxt);
          }
        }
      }
      var compMembers = fam.members.filter(function (mem) { return Boolean(compPaths[mem.path]); });
      if (compMembers.length < 3) return;
      var compEdges = activeEdges.filter(function (e) { return Boolean(compPaths[e.s.path] && compPaths[e.t.path]); });
      var compUndrawn = activeUndrawn.filter(function (up) { return Boolean(compPaths[up.from] && compPaths[up.to]); });
      var qualifyingPairs = compEdges.length + compUndrawn.length;
      if (qualifyingPairs < 2) return;
      var possiblePairs = (compMembers.length * (compMembers.length - 1)) / 2;
      var compNodes = [];
      compMembers.forEach(function (mem) {
        var n = typeof mem.nodeIndex === 'number' && nodes[mem.nodeIndex] ? nodes[mem.nodeIndex] : nodeByPath[mem.path];
        if (n) compNodes.push(n);
      });
      views.push({
        id: fam.d.id + ':' + compMembers.map(function (mem) { return mem.path; }).join(','),
        d: fam.d,
        family: fam,
        members: compMembers,
        nodes: compNodes,
        nodeSet: new Set(compNodes),
        edges: compEdges,
        edgeSet: new Set(compEdges),
        undrawnPairs: compUndrawn,
        qualifyingPairs: qualifyingPairs,
        possiblePairs: possiblePairs,
        commitsTouchingTwoOrMore: fam.d.commitsTouchingTwoOrMore,
        commitsTouchingAll: fam.d.commitsTouchingAll,
        lastTogether: fam.d.lastTogether,
        evidence: fam.d.evidence || [],
        isSubset: compMembers.length < fam.members.length || qualifyingPairs < fam.d.qualifyingPairs
      });
    });
    return views;
  }

  function resolveActiveFamilyView(sel) {
    if (!sel) return null;
    if (sel._isFallbackView) return sel;
    var baseFam = sel.family || sel;
    var views = getActiveFamilyViews(baseFam);
    if (views.length === 0) return null;
    if (sel.id) {
      for (var i = 0; i < views.length; i++) {
        if (views[i].id === sel.id) return views[i];
      }
    }
    return views[0];
  }

  function compareEdgesByPriority(a, b) {
    var aGhost = a.d.relationship === 'ghost' ? 1 : 0;
    var bGhost = b.d.relationship === 'ghost' ? 1 : 0;
    return (
      b.d.overviewPriority - a.d.overviewPriority ||
      bGhost - aGhost ||
      b.d.score - a.d.score ||
      b.d.shared - a.d.shared ||
      a.idx - b.idx
    );
  }

  var rankedGhostEdges = edges
    .filter(function (e) { return e.d.relationship === 'ghost'; })
    .sort(compareEdgesByPriority);

  /**
   * Marker budget: returns AT MOST ONE relationship at any time.
   * - On hover or selection: the single focused relationship.
   * - By default: the top-ranked visible ghost wire (in frame C-01).
   */
  function getMarkerEdge() {
    if (hoverEdge && isVisible(hoverEdge)) return hoverEdge;
    if (selectedEdge && isVisible(selectedEdge)) return selectedEdge;
    var activeFam = resolveActiveFamilyView(hoverFamily || selectedFamily);
    if (activeFam && activeFam.edges.length > 0) {
      var famSorted = activeFam.edges.filter(isVisible).sort(compareEdgesByPriority);
      if (famSorted.length > 0) return famSorted[0];
    }
    var focusN = hoverNode || selectedNode;
    if (focusN) {
      var nodeEdges = focusN.edges.filter(isVisible).sort(compareEdgesByPriority);
      if (nodeEdges.length > 0) return nodeEdges[0];
    }
    if (frames.length > 0 && frames[0].leadEdge && isVisible(frames[0].leadEdge) && frames[0].leadEdge.d.relationship === 'ghost') {
      return frames[0].leadEdge;
    }
    for (var i = 0; i < rankedGhostEdges.length; i++) {
      if (isVisible(rankedGhostEdges[i])) return rankedGhostEdges[i];
    }
    return null;
  }

  function syncCardMarkerBadges() {
    var markerEdge = getMarkerEdge();
    var cards = panel.querySelectorAll('[data-edge-idx]');
    for (var i = 0; i < cards.length; i++) {
      var cardEl = cards[i];
      var eIdx = Number(cardEl.getAttribute('data-edge-idx'));
      var badgeEl = cardEl.querySelector('.relationship-kind-badge');
      if (badgeEl) {
        if (markerEdge && markerEdge.idx === eIdx) {
          badgeEl.classList.add('marker-active');
        } else {
          badgeEl.classList.remove('marker-active');
        }
      }
    }
  }

  // ---- drawing -------------------------------------------------------------
  var dashPhase = 0, drawQueued = false, dirty = true, lastMarch = 0, marchTimer = null;
  function cancelMarchTimer() {
    if (marchTimer !== null) {
      clearTimeout(marchTimer);
      marchTimer = null;
    }
  }
  function scheduleMarch(now) {
    if (marchTimer !== null || drawQueued) return;
    var elapsed = now - lastMarch;
    var delay = Math.max(4, Math.ceil(83.34 - elapsed));
    marchTimer = setTimeout(function () {
      marchTimer = null;
      if (drawQueued) return;
      drawQueued = true;
      requestAnimationFrame(frame);
    }, delay);
  }
  function requestDraw() {
    dirty = true;
    if (drawQueued) return;
    cancelMarchTimer();
    drawQueued = true;
    requestAnimationFrame(frame);
  }

  function hasInteractiveFocusedGhost() {
    if (!visible.ghost) return false;
    var marker = getMarkerEdge();
    if (!marker || marker.d.relationship !== 'ghost') return false;
    return Boolean(selectedEdge || hoverEdge || selectedNode || hoverNode || selectedFamily || hoverFamily);
  }

  function frame() {
    drawQueued = false;
    var ts = performance.now();
    var flying = stepFlight(ts);
    var marching = !animPaused && !reduceMotion && !document.hidden && hasInteractiveFocusedGhost();
    if (!marching) cancelMarchTimer();
    var marched = false;
    if (marching && ts - lastMarch >= 83.33) {
      dashPhase = (dashPhase + 1.75) % 1040;
      lastMarch = ts;
      marched = true;
    }
    if (dirty || flying || marched) {
      dirty = false;
      draw();
    }
    if (flying) {
      cancelMarchTimer();
      requestDraw();
    } else if (marching) {
      scheduleMarch(performance.now());
    }
  }

  function draw() {
    var dpr = size.dpr;
    var colors = getThemeColors();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = colors.sheet;
    ctx.fillRect(0, 0, size.w, size.h);

    // Survey grid in --f-grid
    var step = 80 * cam.scale;
    if (step > 14) {
      var origin = { x: size.w / 2 - cam.x * cam.scale, y: size.h / 2 - cam.y * cam.scale };
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var gx = ((origin.x % step) + step) % step; gx < size.w; gx += step) {
        ctx.moveTo(Math.round(gx) + 0.5, 0);
        ctx.lineTo(Math.round(gx) + 0.5, size.h);
      }
      for (var gy = ((origin.y % step) + step) % step; gy < size.h; gy += step) {
        ctx.moveTo(0, Math.round(gy) + 0.5);
        ctx.lineTo(size.w, Math.round(gy) + 0.5);
      }
      ctx.stroke();
    }

    var k = cam.scale;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (size.w / 2 - cam.x * k), dpr * (size.h / 2 - cam.y * k));

    var markerEdge = getMarkerEdge();
    var activeFrame = (selectedEdge && selectedEdge.frame) || (selectedNode && selectedNode.frame) || null;

    // 1. Draw contact-sheet frames (cut-numbered boxes + captions)
    for (var fi = 0; fi < frames.length; fi++) {
      var f = frames[fi];
      var isFrameSelected = activeFrame === f;
      var isMarkerFrame = Boolean(markerEdge && markerEdge.frame === f);
      ctx.fillStyle = colors.panel;
      ctx.fillRect(f.x, f.y, f.w, f.h);

      ctx.strokeStyle = colors.rule;
      ctx.lineWidth = (isFrameSelected ? 3.5 : 2) / k;
      ctx.setLineDash([]);
      ctx.strokeRect(f.x, f.y, f.w, f.h);

      var headerH = 28;
      ctx.beginPath();
      ctx.moveTo(f.x, f.y + headerH);
      ctx.lineTo(f.x + f.w, f.y + headerH);
      ctx.lineWidth = 1.5 / k;
      ctx.stroke();

      // Count hidden edges in this frame when kind toggles filter out relationships
      var hiddenInFrame = 0;
      for (var fei = 0; fei < f.edges.length; fei++) {
        if (!visible[f.edges[fei].d.relationship]) hiddenInFrame++;
      }

      // Cut badge and plain-text directional caption
      ctx.save();
      ctx.beginPath();
      ctx.rect(f.x + 2, f.y + 2, Math.max(0, f.w - 4), headerH - 4);
      ctx.clip();
      var fontPx = Math.min(11, 13 / Math.max(1, k));
      ctx.font = '700 ' + fontPx + 'px ' + colors.fontMono;
      ctx.textBaseline = 'middle';
      var fullCaption = f.caption + (hiddenInFrame > 0 ? ' · +' + hiddenInFrame + ' hidden by filter' : '');
      var charW = fontPx * 0.62;
      var maxChars = Math.max(18, Math.floor((f.w - 18) / charW));
      var displayCaption = middleTruncate(fullCaption, maxChars);

      // Highlight the single active finding's cut identifier chip with --f-marker background + --f-marker-ink text
      if (isMarkerFrame && displayCaption.indexOf(f.id) === 0) {
        var idW = ctx.measureText(f.id).width;
        var chipPadX = 4;
        var chipH = headerH - 8;
        ctx.fillStyle = colors.marker;
        ctx.fillRect(f.x + 6, f.y + 4, idW + chipPadX * 2, chipH);
        ctx.fillStyle = colors.markerInk;
        ctx.fillText(f.id, f.x + 6 + chipPadX, f.y + headerH / 2);
        ctx.fillStyle = colors.ink;
        ctx.fillText(displayCaption.slice(f.id.length), f.x + 6 + chipPadX * 2 + idW, f.y + headerH / 2);
      } else {
        ctx.fillStyle = colors.ink;
        ctx.fillText(displayCaption, f.x + 8, f.y + headerH / 2);
      }
      ctx.restore();
    }

    // 2. Draw edges using line grammar and Wilson interval.low width (never using --f-marker as a stroke)
    ['test', 'direct', 'indirect', 'unknown', 'ghost'].forEach(function (kind) {
      if (!visible[kind]) return;
      var kindEdges = edgesByKind[kind] || [];
      for (var ei = 0; ei < kindEdges.length; ei++) {
        var e = kindEdges[ei];
        var lowWidth = (1.1 + e.lowBound * 3.0) / k;
        var isMarked = e === markerEdge;
        var strokeWidth = isMarked ? lowWidth + (highContrast ? 2.4 : 1.5) / k : lowWidth;

        ctx.beginPath();
        ctx.moveTo(e.s.x, e.s.y);
        ctx.lineTo(e.t.x, e.t.y);

        // Contrast backdrop under the single focused relationship so dashes remain crisp in ink
        if (isMarked) {
          ctx.save();
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;
          ctx.strokeStyle = colors.panel;
          ctx.globalAlpha = 1;
          ctx.lineWidth = strokeWidth + (highContrast ? 5 : 3.5) / k;
          ctx.stroke();
          ctx.restore();
        }

        ctx.globalAlpha = 1;
        if (kind === 'ghost') {
          ctx.strokeStyle = colors.ink;
          ctx.lineWidth = strokeWidth;
          ctx.setLineDash([8 / k, 5 / k]);
          ctx.lineDashOffset = (isMarked && hasInteractiveFocusedGhost()) ? -dashPhase / k : 0;
        } else if (kind === 'direct') {
          ctx.strokeStyle = colors.ink;
          ctx.lineWidth = strokeWidth;
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;
        } else if (kind === 'indirect') {
          ctx.strokeStyle = isMarked ? colors.ink : colors.ink2;
          ctx.lineWidth = strokeWidth * 0.72;
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;
        } else if (kind === 'unknown') {
          ctx.strokeStyle = isMarked ? colors.ink : colors.ink2;
          ctx.lineWidth = strokeWidth;
          ctx.setLineDash([1.5 / k, 4 / k]);
          ctx.lineDashOffset = 0;
        } else {
          // test: thin solid line with >= 3:1 contrast
          ctx.strokeStyle = isMarked ? colors.ink : colors.ink2;
          ctx.lineWidth = Math.max(0.9 / k, strokeWidth * 0.55);
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;
        }
        ctx.stroke();
      }
    });
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // 3. Draw nodes: paper fill (or theme-aware >= 3:1 directory fill) + ink outline; 3px ink ring when selected
    activeNodesList.forEach(function (n) {
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = colorByDir ? directoryColor(n.dir) : colors.panel;
      ctx.fill();

      var isSelectedOrEndpoint =
        n === selectedNode ||
        (selectedEdge && (n === selectedEdge.s || n === selectedEdge.t));
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = (isSelectedOrEndpoint ? 3 : 1.75) / k;
      ctx.stroke();

      if (isSelectedOrEndpoint) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 3.5 / k, 0, Math.PI * 2);
        ctx.strokeStyle = colors.ink;
        ctx.lineWidth = 3 / k;
        ctx.stroke();
      }
    });

    // 4. Draw sanitized mono node labels
    ctx.globalAlpha = 1;
    ctx.font = (11.5 / k) + 'px ' + colors.fontMono;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    var labelBoxes = [];
    activeNodesList.forEach(function (n) {
      var isPriority =
        n === hoverNode ||
        n === selectedNode ||
        (selectedEdge && (n === selectedEdge.s || n === selectedEdge.t)) ||
        (hoverEdge && (n === hoverEdge.s || n === hoverEdge.t)) ||
        (matches && matches.indexOf(n) >= 0);
      if (!isPriority && k < 0.45 && n.frame && n.frame.nodes.length > 6) return;
      var label = getNodeLabel(n);
      var labelW = ctx.measureText(label).width;
      var x = n.x + n.r + 5 / k;
      if (n.frame && x + labelW > n.frame.x + n.frame.w - 6 / k) {
        x = Math.max(n.frame.x + 6 / k, n.x - n.r - 5 / k - labelW);
      }
      var box = { left: x - 2 / k, right: x + labelW + 2 / k, top: n.y - 7 / k, bottom: n.y + 7 / k };
      if (!isPriority && labelBoxes.some(function (b) {
        return box.left < b.right && box.right > b.left && box.top < b.bottom && box.bottom > b.top;
      })) return;
      labelBoxes.push(box);
      ctx.lineWidth = 3.5 / k;
      ctx.strokeStyle = colors.panel;
      ctx.strokeText(label, x, n.y);
      ctx.fillStyle = colors.ink;
      ctx.fillText(label, x, n.y);
    });

    if (nodes.length === 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = colors.ink2;
      ctx.font = '14px ' + colors.fontMono;
      ctx.textAlign = 'center';
      ctx.fillText('Nothing passed the thresholds yet. Re-run with --min-shared 2 to see weaker links.', size.w / 2, size.h / 2);
      ctx.textAlign = 'start';
    }
  }

  // ---- hit testing ---------------------------------------------------------
  function nodeAt(p) {
    for (var i = nodes.length - 1; i >= 0; i--) {
      var n = nodes[i];
      if (!isActive(n)) continue;
      var dx = p.x - n.x, dy = p.y - n.y, r = n.r + 3 / cam.scale;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }
  function edgeAt(p) {
    var best = null, bestD = 6 / cam.scale;
    edges.forEach(function (e) {
      if (!isVisible(e)) return;
      var ax = e.s.x, ay = e.s.y, bx = e.t.x, by = e.t.y;
      var vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy || 1;
      var t = Math.max(0, Math.min(1, ((p.x - ax) * vx + (p.y - ay) * vy) / len2));
      var dx = p.x - (ax + t * vx), dy = p.y - (ay + t * vy), d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestD) { bestD = d; best = e; }
    });
    return best;
  }
  function frameAt(p) {
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      if (p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h) return f;
    }
    return null;
  }

  // ---- pointer interaction -------------------------------------------------
  var drag = null;
  var activeTouches = new Map();
  var pinchState = null;
  var pinchMoved = false;
  function isStackedTouch(ev) {
    return ev.pointerType === 'touch' && window.innerWidth <= 960;
  }
  canvas.addEventListener('pointerdown', function (ev) {
    var rect = canvas.getBoundingClientRect();
    var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    if (ev.pointerType === 'touch') {
      updateTouchHint();
      activeTouches.set(ev.pointerId, {
        x: px, y: py, clientX: ev.clientX, clientY: ev.clientY, startX: px, startY: py
      });
      if (activeTouches.size === 2) {
        drag = null;
        pinchMoved = true;
        canvas.classList.remove('dragging');
        activeTouches.forEach(function (_, pid) {
          try { canvas.setPointerCapture(pid); } catch (_) {}
        });
        var pts = Array.from(activeTouches.values());
        pinchState = {
          midX: (pts[0].x + pts[1].x) / 2,
          midY: (pts[0].y + pts[1].y) / 2,
          dist: Math.max(1, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y))
        };
        return;
      }
      if (activeTouches.size > 2) return;
      if (isStackedTouch(ev)) {
        var tn = nodeAt(toWorld(px, py));
        drag = { node: tn, startX: px, startY: py, lastX: px, lastY: py, moved: false, stackedSingleTouch: true };
        return;
      }
    }
    var n = nodeAt(toWorld(px, py));
    drag = { node: n, startX: px, startY: py, lastX: px, lastY: py, moved: false, stackedSingleTouch: false };
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', function (ev) {
    var rect = canvas.getBoundingClientRect();
    var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    if (ev.pointerType === 'touch' && activeTouches.has(ev.pointerId)) {
      var prevTouch = activeTouches.get(ev.pointerId);
      prevTouch.x = px; prevTouch.y = py;
      prevTouch.clientX = ev.clientX; prevTouch.clientY = ev.clientY;
      if (activeTouches.size === 2 && pinchState) {
        var pts = Array.from(activeTouches.values());
        var newMidX = (pts[0].x + pts[1].x) / 2;
        var newMidY = (pts[0].y + pts[1].y) / 2;
        var newDist = Math.max(1, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
        flight = null;
        var before = toWorld(newMidX, newMidY);
        cam.scale = Math.max(0.15, Math.min(6, cam.scale * (newDist / pinchState.dist)));
        var after = toWorld(newMidX, newMidY);
        cam.x += before.x - after.x - (newMidX - pinchState.midX) / cam.scale;
        cam.y += before.y - after.y - (newMidY - pinchState.midY) / cam.scale;
        pinchState.midX = newMidX;
        pinchState.midY = newMidY;
        pinchState.dist = newDist;
        tooltip.hidden = true;
        requestDraw();
        return;
      }
      if (drag && drag.stackedSingleTouch) {
        if (Math.abs(px - drag.startX) + Math.abs(py - drag.startY) > 6) {
          drag.moved = true;
        }
        drag.lastX = px; drag.lastY = py;
        return;
      }
    }
    if (drag) {
      if (Math.abs(px - drag.startX) + Math.abs(py - drag.startY) > 4) drag.moved = true;
      if (drag.moved) {
        flight = null;
        if (drag.node) {
          var wp = toWorld(px, py);
          var nf = drag.node.frame;
          if (nf) {
            var minX = nf.x + nf.pad.left;
            var maxX = nf.x + nf.w - nf.pad.right;
            var minY = nf.y + nf.pad.top;
            var maxY = nf.y + nf.h - nf.pad.bottom;
            drag.node.x = Math.max(minX, Math.min(maxX, wp.x));
            drag.node.y = Math.max(minY, Math.min(maxY, wp.y));
          } else {
            drag.node.x = wp.x;
            drag.node.y = wp.y;
          }
          drag.node.pinned = true;
        } else {
          cam.x -= (px - drag.lastX) / cam.scale;
          cam.y -= (py - drag.lastY) / cam.scale;
        }
      }
      drag.lastX = px; drag.lastY = py;
      tooltip.hidden = true;
      requestDraw();
      return;
    }
    var p = toWorld(px, py);
    var n = nodeAt(p);
    var e = n ? null : edgeAt(p);
    canvas.classList.toggle('pointing', Boolean(n || e));
    var changedHover = false;
    if (n !== hoverNode) { hoverNode = n; changedHover = true; }
    if (e !== hoverEdge) { hoverEdge = e; changedHover = true; }
    if (changedHover) {
      syncCardMarkerBadges();
      requestDraw();
    }
    if (n || e) {
      if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
      tooltip.textContent = '';
      if (n) {
        if (n.frame) tooltip.appendChild(el('div', '', n.frame.id));
        tooltip.appendChild(el('code', '', n.safePath));
        tooltip.appendChild(el('div', '', 'Folder: ' + n.safeDir));
        tooltip.appendChild(el('div', '', 'Changed in ' + plural(n.changes, 'commit')));
      } else {
        var labels = distinguishingPaths(e.s.safePath, e.t.safePath);
        var headLine = (e.frame ? e.frame.id + ' · ' : '') + KINDS[e.d.relationship].label.replace(/s$/, '') + ': ' + labels[0] + ' and ' + labels[1] + (e.weak ? ' · weak' : '');
        tooltip.appendChild(el('div', '', headLine));
        tooltip.appendChild(el('div', '', directionEvidence(e, true)));
      }
      tooltip.hidden = false;
      var left = Math.min(px + 14, size.w - tooltip.offsetWidth - 8);
      tooltip.style.left = Math.max(8, left) + 'px';
      tooltip.style.top = (py + 14) + 'px';
    } else if (!tooltipHovered && !tooltip.hidden && !tooltipHideTimer) {
      tooltipHideTimer = setTimeout(function () {
        tooltipHideTimer = null;
        if (!tooltipHovered) tooltip.hidden = true;
      }, 150);
    }
  });
  var tooltipHideTimer = null;
  var tooltipHovered = false;
  if (tooltip) {
    tooltip.addEventListener('pointerenter', function () {
      tooltipHovered = true;
      if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
    });
    tooltip.addEventListener('pointerleave', function () {
      tooltipHovered = false;
      tooltip.hidden = true;
    });
  }
  function endDrag(ev) {
    if (ev.pointerType === 'touch') {
      activeTouches.delete(ev.pointerId);
      if (activeTouches.size < 2) pinchState = null;
      if (pinchMoved) {
        if (activeTouches.size === 0) pinchMoved = false;
        drag = null;
        return;
      }
    }
    if (!drag) return;
    canvas.classList.remove('dragging');
    if (!drag.moved) {
      var rect = canvas.getBoundingClientRect();
      var p = toWorld(ev.clientX - rect.left, ev.clientY - rect.top);
      var n = nodeAt(p);
      if (n) selectNode(n);
      else {
        var e = edgeAt(p);
        if (e) selectEdge(e);
        else {
          var f = frameAt(p);
          if (f && f.leadEdge && isVisible(f.leadEdge)) selectEdge(f.leadEdge);
          else clearSelection();
        }
      }
    }
    drag = null;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', function (ev) {
    if (ev.pointerType === 'touch') {
      activeTouches.delete(ev.pointerId);
      if (activeTouches.size < 2) pinchState = null;
      if (activeTouches.size === 0) pinchMoved = false;
    }
    drag = null;
    canvas.classList.remove('dragging');
  });
  canvas.addEventListener('pointerleave', function () {
    if (!drag) {
      if (!tooltip.hidden && !tooltipHideTimer) {
        tooltipHideTimer = setTimeout(function () {
          tooltipHideTimer = null;
          if (!tooltipHovered) tooltip.hidden = true;
        }, 150);
      }
      if (hoverNode || hoverEdge) {
        hoverNode = null;
        hoverEdge = null;
        syncCardMarkerBadges();
        requestDraw();
      }
    }
  });
  window.addEventListener('blur', function () {
    activeTouches.clear();
    pinchState = null;
    pinchMoved = false;
    drag = null;
    canvas.classList.remove('dragging');
  });
  canvas.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    flight = null;
    var rect = canvas.getBoundingClientRect();
    var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    var before = toWorld(px, py);
    cam.scale = Math.max(0.15, Math.min(6, cam.scale * Math.exp(-ev.deltaY * 0.0015)));
    var after = toWorld(px, py);
    cam.x += before.x - after.x; cam.y += before.y - after.y;
    requestDraw();
  }, { passive: false });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      var fgDetails = document.getElementById('field-guide-details');
      if (fgDetails && fgDetails.open) {
        fgDetails.open = false;
        var fgSum = fgDetails.querySelector('summary');
        if (fgSum && typeof fgSum.focus === 'function') fgSum.focus();
        return;
      }
      var openPopovers = document.querySelectorAll('.f12-help-popover.\\:popover-open');
      if (openPopovers.length > 0) {
        for (var pi = 0; pi < openPopovers.length; pi++) {
          openPopovers[pi].classList.remove(':popover-open');
          try { if (typeof openPopovers[pi].hidePopover === 'function') openPopovers[pi].hidePopover(); } catch (_) {}
        }
        return;
      }
      if (tooltip && !tooltip.hidden) {
        tooltip.hidden = true;
        hoverNode = null;
        hoverEdge = null;
        syncCardMarkerBadges();
        requestDraw();
        return;
      }
      if ((selectedEdge || selectedNode) && returnToFamily && resolveActiveFamilyView(returnToFamily)) {
        selectFamily(returnToFamily, true);
      } else {
        if (search.value || matches) {
          search.value = '';
          matches = null;
        }
        clearSelection();
        search.blur();
      }
    }
    if (ev.key === '/' && document.activeElement !== search) { ev.preventDefault(); search.focus(); }
    var tag = document.activeElement && document.activeElement.tagName ? document.activeElement.tagName.toLowerCase() : '';
    if (tag !== 'input' && tag !== 'textarea' && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      if (ev.key === 'b' || ev.key === 'B') setViewMode('briefing');
      if (ev.key === 'a' || ev.key === 'A') setViewMode('atlas');
    }
  });
  search.addEventListener('input', function () {
    var q = search.value.trim().toLowerCase();
    matches = q ? nodes.filter(function (n) { return n.safePath.toLowerCase().indexOf(q) >= 0; }) : null;
    if (typeof renderBriefingBoard === 'function') renderBriefingBoard();
    requestDraw();
  });
  search.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && matches && matches.length > 0) { selectNode(matches[0]); }
  });

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      flight = null;
      clearSelection();
      fitSheet();
      requestDraw();
    });
  }
  var focusTopBtn = document.getElementById('focus-top');
  if (focusTopBtn) {
    focusTopBtn.addEventListener('click', function () {
      var topFrames = frames.slice(0, 3);
      if (topFrames.length === 0) return;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      topFrames.forEach(function (f) {
        if (f.x < minX) minX = f.x;
        if (f.y < minY) minY = f.y;
        if (f.x + f.w > maxX) maxX = f.x + f.w;
        if (f.y + f.h > maxY) maxY = f.y + f.h;
      });
      flyToTarget(rectBounds(minX, minY, maxX, maxY, 32));
    });
  }
  var fitFrameBtn = document.getElementById('fit-frame');
  if (fitFrameBtn) {
    fitFrameBtn.addEventListener('click', function () {
      var targetFrame =
        (selectedEdge && selectedEdge.frame) ||
        (selectedNode && selectedNode.frame) ||
        (getMarkerEdge() && getMarkerEdge().frame) ||
        frames[0] ||
        null;
      if (targetFrame) flyToFrame(targetFrame);
    });
  }
  var toggleAnimBtn = document.getElementById('toggle-anim');
  if (toggleAnimBtn) {
    toggleAnimBtn.addEventListener('click', function () {
      animPaused = !animPaused;
      toggleAnimBtn.textContent = animPaused ? 'Resume animation' : 'Pause animation';
      requestDraw();
    });
  }

  function selectNode(n, fromFamily) {
    if (fromFamily !== undefined) {
      returnToFamily = fromFamily;
    } else if (selectedFamily) {
      var activeView = resolveActiveFamilyView(selectedFamily);
      returnToFamily = activeView && activeView.nodes.indexOf(n) >= 0 ? activeView : null;
    } else if (returnToFamily) {
      var prevView = resolveActiveFamilyView(returnToFamily);
      returnToFamily = prevView && prevView.nodes.indexOf(n) >= 0 ? prevView : null;
    }
    selectedNode = n; selectedEdge = null; selectedFamily = null; hoverEdge = null; hoverFamily = null; matches = null; search.value = '';
    if (n.frame) flyToFrame(n.frame);
    else flyToNodes([n]);
    renderPanel(); requestDraw();
  }
  function selectEdge(e, fromFamily) {
    if (fromFamily !== undefined) {
      returnToFamily = fromFamily;
    } else if (selectedFamily) {
      var activeView = resolveActiveFamilyView(selectedFamily);
      returnToFamily = activeView && activeView.edges.indexOf(e) >= 0 ? activeView : null;
    } else if (returnToFamily) {
      var prevView = resolveActiveFamilyView(returnToFamily);
      returnToFamily = prevView && prevView.edges.indexOf(e) >= 0 ? prevView : null;
    }
    selectedEdge = e; selectedNode = null; selectedFamily = null; hoverEdge = null; hoverFamily = null; matches = null; search.value = '';
    briefingSelectedEdgeIdx = e.idx;
    briefingSelectedFamilyIdx = -1;
    briefingUseDefaultFeatured = false;
    if (e.frame) flyToFrame(e.frame);
    else flyToNodes([e.s, e.t]);
    renderPanel(); requestDraw();
  }
  function selectFamily(fam, keepExpandedPair) {
    var view = resolveActiveFamilyView(fam);
    if (!view) return;
    selectedFamily = view; selectedNode = null; selectedEdge = null; returnToFamily = null; hoverEdge = null; hoverFamily = null; matches = null; search.value = '';
    if (briefingData && briefingData.families && view.d) {
      var matchedFamIdx = -1;
      for (var bfi = 0; bfi < briefingData.families.length; bfi++) {
        if (briefingData.families[bfi].familyId === view.d.id) {
          matchedFamIdx = bfi;
          break;
        }
      }
      if (matchedFamIdx >= 0) {
        briefingSelectedFamilyIdx = matchedFamIdx;
        briefingSelectedEdgeIdx = briefingData.families[matchedFamIdx].edgeIndex;
        briefingUseDefaultFeatured = Boolean(
          briefingData.featured &&
          (briefingData.featured.isFamily || briefingData.featured.kind === 'family') &&
          briefingData.featured.familyIndex === matchedFamIdx
        );
      }
    }
    if (!keepExpandedPair) expandedFamilyPairKey = null;
    flyToNodes(view.nodes);
    renderPanel();
    if (keepExpandedPair) {
      var targetFocus = panel._expandedPairSummary || panel._familyHeading;
      if (targetFocus && typeof targetFocus.focus === 'function') targetFocus.focus();
    }
    requestDraw();
  }
  function clearSelection() {
    selectedNode = null; selectedEdge = null; selectedFamily = null; hoverEdge = null; hoverFamily = null; returnToFamily = null; expandedFamilyPairKey = null;
    briefingUseDefaultFeatured = Boolean(briefingData && briefingData.featured);
    briefingSelectedFamilyIdx = (briefingData && briefingData.featured && (briefingData.featured.isFamily || briefingData.featured.kind === 'family') && typeof briefingData.featured.familyIndex === 'number')
      ? briefingData.featured.familyIndex
      : -1;
    briefingSelectedEdgeIdx = briefingData && briefingData.featured ? briefingData.featured.edgeIndex : (edges[0] ? 0 : -1);
    renderPanel(); requestDraw();
  }

  // ---- copy & Markdown export (byte-identical to classic) ------------------
  function copyText(text, button, successMsg) {
    var label = successMsg || 'Copied';
    function copied() {
      var original = button.dataset.origLabel || button.textContent;
      button.dataset.origLabel = original;
      if (button._copyTimer) clearTimeout(button._copyTimer);
      button.textContent = label;
      button.classList.add('copied');
      button._copyTimer = setTimeout(function () {
        button.textContent = original;
        button.classList.remove('copied');
        button._copyTimer = null;
      }, 1500);
    }
    function fallback() {
      var input = el('textarea');
      input.value = text; input.style.position = 'fixed'; input.style.opacity = '0';
      document.body.appendChild(input); input.select();
      try { if (document.execCommand('copy')) copied(); } catch (_) {}
      input.remove();
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(copied, fallback);
      return;
    }
    fallback();
  }

  function defuseMentions(text) {
    var pound = String.fromCharCode(35);
    return String(text)
      .replace(/@([a-zA-Z0-9_-]+)/g, '@\u200B$1')
      .replace(new RegExp(pound + '([0-9]+)', 'g'), pound + '\u200B$1');
  }

  function sanitizeMarkdown(text) {
    return defuseMentions(text)
      .replace(/[\r\n]+/g, ' ')
      .replace(/([\\<>[\]()*_~\x60])/g, '\\$1');
  }

  function shellQuoteArg(arg) {
    var s = String(arg == null ? '' : arg);
    if (/^[A-Za-z0-9_./-]+$/.test(s) && s.charAt(0) !== '-') return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  function fallbackExplainCommand(a, b) {
    return 'npx repo-archaeology explain ' + shellQuoteArg(a) + ' ' + shellQuoteArg(b);
  }

  function mdCode(text) {
    var q = String.fromCharCode(96);
    var s = defuseMentions(text).replace(/[\r\n]+/g, ' ');
    var fence = q;
    while (s.indexOf(fence) !== -1) fence += q;
    var needsPad = s.charAt(0) === q || s.charAt(s.length - 1) === q || s.charAt(0) === ' ' || s.charAt(s.length - 1) === ' ';
    var pad = needsPad ? ' ' : '';
    return fence + pad + s + pad + fence;
  }

  function edgeWeightingLabel(d) {
    if (!d.weighted) return '';
    if (d.weighting === 'origin') return 'origin-weighted';
    if (d.weighting === 'recency+origin') return 'recency+origin-weighted';
    return 'recency-weighted';
  }
  function directionEvidence(e, fromSource) {
    var total = fromSource ? e.d.fromChanges : e.d.toChanges;
    var confidence = fromSource ? e.d.confidence : e.d.reverseConfidence;
    var iv = fromSource ? e.d.interval : e.d.reverseInterval;
    if (e.d.weighted) return e.d.shared + ' of ' + total + ' commits ' + formatCi(iv, true) + ' (' + pct(confidence) + ' ' + edgeWeightingLabel(e.d) + ')';
    return e.d.shared + ' of ' + total + ' commits (' + pct(confidence) + ') ' + formatCi(iv, false);
  }
  function findingLabel(e) {
    if (e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation') return 'Related implementations';
    return KINDS[e.d.relationship].label.replace(/s$/, '');
  }

  function formatFindingMarkdown(e) {
    var labels = distinguishingPaths(e.s.path, e.t.path);
    var kindName = findingLabel(e);
    var scope = e.d.crossesDirectories && !(e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation')
      ? ' Connects different parts of the project (' + mdCode(e.s.dir) + ' and ' + mdCode(e.t.dir) + ').'
      : '';
    var lines = [
      '### 🔍 Repo Archaeology: File Relationship Finding',
      '',
      '**Files:** ' + mdCode(e.s.path) + ' ↔ ' + mdCode(e.t.path) + '  ',
      '**Relationship:** ' + kindName + ' (' + plural(e.d.shared, 'shared commit') + ')  ',
      '**Last Together:** ' + relativeDate(e.d.lastTogether) + '  ',
      '',
      '**Directional Co-Change:**',
      '- ' + mdCode(labels[0]) + ' → ' + mdCode(labels[1]) + ': ' + directionEvidence(e, true),
      '- ' + mdCode(labels[1]) + ' → ' + mdCode(labels[0]) + ': ' + directionEvidence(e, false),
      '',
      '**Why It Matters:**',
      '- ' + sanitizeMarkdown(capitalize(e.d.why)) + '.' + scope,
      (e.d.relationship === 'ghost' ? '- No direct or supported indirect import relationship found in current code.' : '')
    ];
    if (e.d.verdict) {
      var vHead = e.d.verdict.kind === 'confirmed' ? 'Confirmed dependency' : 'Expected relationship';
      lines.push('- **' + vHead + ':** ' + sanitizeMarkdown(e.d.verdict.reason));
    }
    if (e.d.evidence && e.d.evidence.length > 0) {
      lines.push('', '**Supporting Commits:**');
      e.d.evidence.slice(0, 5).forEach(function (ev) {
        lines.push('- ' + mdCode(ev.hash.slice(0, 7)) + ' (' + ev.date + '): ' + sanitizeMarkdown(ev.subject));
      });
    }
    var cliCmd = e.d.explainCommand || fallbackExplainCommand(e.s.path, e.t.path);
    lines.push('', '**Inspect Diff Evidence:** ' + mdCode(cliCmd));
    return lines.filter(function (l) { return l !== undefined; }).join('\n');
  }

  function formatFamilyMarkdown(view) {
    var lines = [
      '### 🔍 Repo Archaeology: Related Implementation Family',
      '',
      '**Pattern:** ' + mdCode(view.d.label || view.d.id) + '  ',
      '**Members (' + view.members.length + ' files):** ' + view.members.map(function (m) { return mdCode(m.path); }).join(', ') + '  ',
      '**Pairwise Links:** ' + view.qualifyingPairs + ' of ' + view.possiblePairs + ' possible pairs passed thresholds  ',
      '**Family-Wide Commits:** ' + plural(view.commitsTouchingTwoOrMore, 'supporting commit') + ' (2+ members via a qualifying pair; ' + plural(view.commitsTouchingAll, 'commit') + ' touched all ' + view.members.length + ')  ',
      '**Last Together:** ' + relativeDate(view.lastTogether) + '  ',
      '',
      '**Qualifying Pairwise Relationships:**'
    ];
    view.edges.forEach(function (e) {
      var labels = distinguishingPaths(e.s.path, e.t.path);
      lines.push('- ' + mdCode(labels[0]) + ' ↔ ' + mdCode(labels[1]) + ': ' + plural(e.d.shared, 'shared commit') + ' (' + directionEvidence(e, true) + '; reverse ' + directionEvidence(e, false) + ')');
    });
    (view.undrawnPairs || []).forEach(function (up) {
      var labels = distinguishingPaths(up.from, up.to);
      lines.push('- ' + mdCode(labels[0]) + ' ↔ ' + mdCode(labels[1]) + ': ' + plural(up.shared, 'shared commit') + ' (qualifies, not drawn)');
    });
    if (view.evidence && view.evidence.length > 0) {
      lines.push('', '**Family-Wide Supporting Commits (2+ members via a qualifying pair):**');
      view.evidence.slice(0, 5).forEach(function (ev) {
        var scopeTag = ev.touchesAllMembers ? 'all ' + ev.totalMembers + ' members' : ev.membersTouched + ' of ' + ev.totalMembers + ' members';
        lines.push('- ' + mdCode(ev.hash.slice(0, 7)) + ' (' + ev.date + ', ' + scopeTag + '): ' + sanitizeMarkdown(ev.subject));
      });
    }
    return lines.join('\n');
  }

  // ---- panel rendering -----------------------------------------------------
  function buildOverviewItems(listData) {
    var edgeToFamilyView = new Map();
    var allActiveViews = [];
    families.forEach(function (fam) {
      var views = getActiveFamilyViews(fam);
      views.forEach(function (view) {
        allActiveViews.push(view);
        view.edges.forEach(function (e) {
          edgeToFamilyView.set(e, view);
        });
      });
    });
    var items = [];
    var emittedViews = new Set();
    for (var i = 0; i < listData.length; i++) {
      var e = listData[i];
      var famView = edgeToFamilyView.get(e);
      if (famView) {
        if (!emittedViews.has(famView.id)) {
          emittedViews.add(famView.id);
          items.push({ kind: 'family', view: famView });
        }
      } else {
        items.push({ kind: 'edge', edge: e });
      }
    }
    if (overviewTab !== 'surprising') {
      allActiveViews.forEach(function (view) {
        if (emittedViews.has(view.id)) return;
        var matchesTab = overviewTab === 'all'
          || view.edges.length === 0
          || view.edges.some(function (e) { return e.d.relationship === 'ghost'; })
          || (view.undrawnPairs || []).some(function (up) { return up.relationship === 'ghost'; });
        if (!matchesTab) return;
        emittedViews.add(view.id);
        items.push({ kind: 'family', view: view });
      });
    }
    return items;
  }

  function getTopFindings(items, maxCount) {
    var top = items.slice(0, maxCount);
    for (var i = maxCount; i < items.length; i++) {
      if (items[i].kind === 'family') top.push(items[i]);
    }
    return top;
  }

  function renderOverview() {
    var header = el('div');
    header.appendChild(el('div', 'cut-section-label', 'C-01 / OVERVIEW'));
    header.appendChild(el('h2', '', 'Contact-sheet findings'));
    header.appendChild(el('p', '', 'Each numbered cut frame groups a connected component of co-changing files, ranked by priority. Line pattern encodes relationship kind and line width encodes the conservative 95% Wilson confidence lower bound from raw historical counts (which may differ from recency/origin-weighted ranking). Co-change is historical evidence to investigate, not proof of a compile-time dependency. The gold marker chip identifies at most one active finding at a time.'));
    if (m && m.settings && typeof m.settings.maxEdges === 'number' && edges.length >= m.settings.maxEdges) {
      header.appendChild(el('p', 'card-hint', 'Display limit reached: showing top ' + edges.length.toLocaleString('en-US') + ' relationships (--edges ' + m.settings.maxEdges.toLocaleString('en-US') + '). Additional qualifying relationships may be omitted from the sheet.'));
    }
    panel.appendChild(header);

    var visibleEdges = edges.filter(isVisible);
    var ghosts = visibleEdges.filter(function (e) { return e.d.relationship === 'ghost'; }).sort(compareEdgesByPriority);
    var surprising = ghosts.filter(function (e) {
      var isParallel = e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation';
      if (isParallel) return false;
      var fromDir = e.s.dir, toDir = e.t.dir;
      var independent = fromDir !== toDir && fromDir !== '.' && toDir !== '.'
        && !fromDir.startsWith(toDir + '/') && !toDir.startsWith(fromDir + '/');
      return independent || e.d.overviewPriority >= 2;
    });
    var strongest = visibleEdges.slice().sort(function (a, b) { return b.d.shared - a.d.shared || b.d.score - a.d.score; });

    var tabGroup = el('div', 'tab-group');
    var tabDefs = [
      { id: 'ghost', label: 'Ghost wires (' + ghosts.length + ')' },
      { id: 'surprising', label: 'Surprising (' + surprising.length + ')' },
      { id: 'all', label: 'All links (' + visibleEdges.length + ')' }
    ];
    tabDefs.forEach(function (t) {
      var btn = el('button', 'tab-btn' + (overviewTab === t.id ? ' active' : ''), t.label);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        overviewTab = t.id;
        overviewExpanded = false;
        renderPanel();
      });
      tabGroup.appendChild(btn);
    });
    panel.appendChild(tabGroup);

    var listData = overviewTab === 'surprising' ? surprising : (overviewTab === 'all' ? strongest : ghosts);
    var titleText = overviewTab === 'surprising' ? 'Cross-folder connections worth exploring' : (overviewTab === 'all' ? 'Strongest co-changing files' : 'Connections worth exploring');

    panel.appendChild(el('h3', '', titleText));

    var overviewItems = buildOverviewItems(listData);
    if (overviewItems.length === 0) {
      panel.appendChild(el('p', '', 'No relationships found for this filter.'));
    } else {
      panel.appendChild(el('p', 'card-hint', 'Select a card or frame to fly to its cut & inspect commits'));
      var displayItems = overviewExpanded ? overviewItems : getTopFindings(overviewItems, 3);
      var cardsContainer = el('div', 'cards-list');
      for (var idx = 0; idx < displayItems.length; idx++) {
        var item = displayItems[idx];
        if (item.kind === 'family') {
          cardsContainer.appendChild(familyCard(item.view));
        } else {
          cardsContainer.appendChild(relationshipCard(item.edge));
        }
      }
      panel.appendChild(cardsContainer);

      if (overviewItems.length > displayItems.length || (overviewExpanded && overviewItems.length > 3)) {
        var viewAllBtn = el('button', 'view-all-btn', overviewExpanded ? 'Show top 3 findings' : 'View all ' + overviewItems.length + ' findings');
        viewAllBtn.type = 'button';
        viewAllBtn.addEventListener('click', function () {
          overviewExpanded = !overviewExpanded;
          renderPanel();
        });
        panel.appendChild(viewAllBtn);
      }
    }

    if (colorByDir) {
      renderFolderLegend();
    }
  }

  function renderFolderLegend() {
    var activeNodes = nodes.filter(isActive);
    var dirCounts = Object.create(null);
    activeNodes.forEach(function (n) {
      dirCounts[n.dir] = (dirCounts[n.dir] || 0) + 1;
    });
    var sortedDirs = Object.keys(dirCounts)
      .map(function (name) { return { name: name, count: dirCounts[name] }; })
      .sort(function (a, b) { return b.count - a.count; });
    if (sortedDirs.length === 0) return;
    var title = sortedDirs.length > 8
      ? 'Directory color legend (' + sortedDirs.slice(0, 8).length + ' of ' + sortedDirs.length + ' folders)'
      : 'Directory color legend';
    panel.appendChild(el('h3', '', title));
    var legend = el('div', 'folder-legend');
    sortedDirs.slice(0, 8).forEach(function (d) {
      var item = el('div', 'legend-item');
      var dot = el('span', 'legend-dot');
      dot.style.background = directoryColor(d.name);
      item.appendChild(dot);
      item.appendChild(el('span', '', sanitizeText(d.name) + ' (' + d.count + ')'));
      legend.appendChild(item);
    });
    panel.appendChild(legend);
  }

  function familyCard(view) {
    var card = el('button', 'card interactive family-card');
    card.type = 'button';
    var head = el('div', 'card-header');
    var badges = el('span', 'card-badges');
    if (view.nodes[0] && view.nodes[0].frame) {
      badges.appendChild(el('span', 'cut-chip', view.nodes[0].frame.id));
    }
    badges.appendChild(el('span', 'badge family', 'Related family · ' + view.members.length + ' files'));
    head.appendChild(badges);
    head.appendChild(el('span', 'card-sub', plural(view.commitsTouchingTwoOrMore, 'commit') + ' (2+ files) · ' + view.qualifyingPairs + ' of ' + view.possiblePairs + ' pairs'));
    card.appendChild(head);

    card.appendChild(el('div', 'card-title', sanitizeText(view.d.label || view.d.id)));

    var variants = el('div', 'family-variants');
    view.members.forEach(function (m) {
      variants.appendChild(el('span', 'family-variant-pill', sanitizeText(m.variant)));
    });
    card.appendChild(variants);

    var note = el('div', 'card-sub');
    var pairSummary = view.qualifyingPairs === view.possiblePairs
      ? 'All ' + view.possiblePairs + ' pairwise links across ' + view.members.length + ' sibling directories passed thresholds.'
      : view.qualifyingPairs + ' of ' + view.possiblePairs + ' possible pairwise links passed thresholds across ' + view.members.length + ' sibling directories.';
    note.textContent = pairSummary + ' ' + plural(view.commitsTouchingTwoOrMore, 'supporting commit') + ' (2+ members via a qualifying pair; ' + plural(view.commitsTouchingAll, 'commit') + ' touched all ' + view.members.length + ').';
    card.appendChild(note);

    card.addEventListener('pointerenter', function () {
      hoverFamily = view;
      syncCardMarkerBadges();
      requestDraw();
    });
    card.addEventListener('pointerleave', function () {
      if (hoverFamily === view) {
        hoverFamily = null;
        syncCardMarkerBadges();
        requestDraw();
      }
    });
    card.addEventListener('click', function () {
      selectFamily(view);
    });
    return card;
  }

  function relationshipCard(e) {
    var markerEdge = getMarkerEdge();
    var isMarked = e === markerEdge;
    var isSelected = e === selectedEdge;
    var card = el('button', 'card interactive' + (isSelected ? ' selected' : ''));
    card.type = 'button';
    card.setAttribute('data-edge-idx', String(e.idx));
    var head = el('div', 'card-header');
    var badges = el('span', 'card-badges');
    if (e.frame) {
      badges.appendChild(el('span', 'cut-chip', e.frame.id));
    }
    var isParallel = e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation';
    var badgeClass = 'badge relationship-kind-badge ' + (isParallel ? 'parallel' : e.d.relationship) + (isMarked ? ' marker-active' : '');
    badges.appendChild(el('span', badgeClass, findingLabel(e)));
    if (e.weak) {
      badges.appendChild(el('span', 'badge weak', 'weak'));
    }
    head.appendChild(badges);
    var peakPct = pct(Math.max(e.d.confidence, e.d.reverseConfidence));
    head.appendChild(el('span', 'card-sub', plural(e.d.shared, 'shared commit') + ' · ' + peakPct + ' ' + formatCi(e.d.interval, e.d.weighted)));
    card.appendChild(head);

    var pair = el('div', 'card-title');
    var labels = distinguishingPaths(e.s.safePath, e.t.safePath);
    pair.textContent = labels[0] + ' ↔ ' + labels[1];
    card.appendChild(pair);

    var note = el('div', 'card-sub');
    var bridgeInfo = (e.frame && e.frame.bridgedSubgroups > 1)
      ? ' Frame bridges ' + e.frame.bridgedSubgroups + ' ghost-wire groups via import/test links.'
      : '';
    if (isParallel) {
      note.textContent = 'These files support related functionality across sibling directories and have been updated together in ' + plural(e.d.shared, 'commit') + '.' + bridgeInfo;
    } else {
      var scope = e.d.crossesDirectories
        ? 'Connects different parts of the project (' + e.s.safeDir + ' and ' + e.t.safeDir + '). '
        : '';
      note.textContent = scope + capitalize(sanitizeText(e.d.why)) + ' (' + e.d.shared + ' of ' + e.d.fromChanges + ' changes to ' + base(e.s.safePath) + ').' + bridgeInfo;
    }
    card.appendChild(note);

    card.addEventListener('pointerenter', function () {
      hoverEdge = e;
      syncCardMarkerBadges();
      requestDraw();
    });
    card.addEventListener('pointerleave', function () {
      if (hoverEdge === e) {
        hoverEdge = null;
        syncCardMarkerBadges();
        requestDraw();
      }
    });
    card.addEventListener('click', function () {
      selectEdge(e);
    });
    return card;
  }

  function renderSelectedFamily(sel) {
    var view = resolveActiveFamilyView(sel);
    if (!view) {
      clearSelection();
      return;
    }

    var backBtn = el('button', 'back-btn', '← Back to overview');
    backBtn.type = 'button';
    backBtn.addEventListener('click', clearSelection);
    panel.appendChild(backBtn);

    panel.appendChild(el('div', 'cut-section-label', 'C-02 / EVIDENCE'));

    var head = el('div');
    head.appendChild(el('span', 'badge family', 'Related implementation family'));
    var familyHeading = el('h2', '', sanitizeText(view.d.label || view.d.id));
    familyHeading.tabIndex = -1;
    head.appendChild(familyHeading);
    panel._familyHeading = familyHeading;
    panel._expandedPairSummary = null;
    head.appendChild(el('p', 'card-sub', view.members.length + ' sibling files · ' + view.qualifyingPairs + ' of ' + view.possiblePairs + ' qualifying pairs · Last together ' + relativeDate(view.lastTogether)));
    panel.appendChild(head);

    var grid = el('div', 'cochange-grid');
    var card1 = el('div', 'cochange-card');
    card1.appendChild(el('div', 'cochange-pct', String(view.commitsTouchingTwoOrMore)));
    card1.appendChild(el('div', 'cochange-label', 'Supporting commits (2+ members via a qualifying pair)'));
    grid.appendChild(card1);

    var card2 = el('div', 'cochange-card');
    card2.appendChild(el('div', 'cochange-pct', String(view.commitsTouchingAll)));
    card2.appendChild(el('div', 'cochange-label', 'Commits touching all ' + view.members.length + ' family members together'));
    grid.appendChild(card2);
    panel.appendChild(grid);

    panel.appendChild(el('h3', '', 'Member files (' + view.members.length + ')'));
    var memberContainer = el('div', 'pair-container');
    view.members.forEach(function (m) {
      var mNode = typeof m.nodeIndex === 'number' && nodes[m.nodeIndex] ? nodes[m.nodeIndex] : nodeByPath[m.path];
      var box = el('div', 'pair-box');
      var boxHead = el('div', 'pair-box-head');
      var link = el('button', 'file-link', sanitizeText(m.path));
      link.type = 'button';
      if (mNode) {
        link.addEventListener('click', function () { selectNode(mNode, view); });
      }
      boxHead.appendChild(link);
      boxHead.appendChild(el('span', 'family-variant-pill', sanitizeText(m.variant)));
      box.appendChild(boxHead);
      box.appendChild(el('div', 'pair-dir', 'Folder: ' + sanitizeText(m.dir || m.directory || '') + ' · Changed in ' + plural(m.changes, 'commit')));
      memberContainer.appendChild(box);
    });
    panel.appendChild(memberContainer);

    var exportBtn = el('button', 'btn-export', 'Copy finding for PR / discussion');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', function () {
      var markdown = formatFamilyMarkdown(view);
      copyText(markdown, exportBtn, 'Copied finding to clipboard');
    });
    panel.appendChild(exportBtn);
  }

  function renderSelectedEdge(e) {
    var activeReturnFam = resolveActiveFamilyView(returnToFamily);
    if (activeReturnFam) {
      var navRow = el('div', 'nav-row');
      var backFamBtn = el('button', 'back-btn', '← Back to family (' + sanitizeText(activeReturnFam.d.label || activeReturnFam.d.id) + ')');
      backFamBtn.type = 'button';
      backFamBtn.addEventListener('click', function () { selectFamily(activeReturnFam, true); });
      navRow.appendChild(backFamBtn);
      var backOverviewBtn = el('button', 'back-btn', 'Overview');
      backOverviewBtn.type = 'button';
      backOverviewBtn.addEventListener('click', clearSelection);
      navRow.appendChild(backOverviewBtn);
      panel.appendChild(navRow);
    } else {
      var backBtn = el('button', 'back-btn', '← Back to overview');
      backBtn.type = 'button';
      backBtn.addEventListener('click', clearSelection);
      panel.appendChild(backBtn);
    }

    panel.appendChild(el('div', 'cut-section-label', 'C-02 / EVIDENCE'));

    var head = el('div', 'card selected');
    head.setAttribute('data-edge-idx', String(e.idx));
    var badgeRow = el('div', 'card-badges');
    if (e.frame) badgeRow.appendChild(el('span', 'cut-chip', e.frame.id));
    var isParallel = e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation';
    var isMarked = e === getMarkerEdge();
    var badgeClass = 'badge relationship-kind-badge ' + (isParallel ? 'parallel' : e.d.relationship) + (isMarked ? ' marker-active' : '');
    badgeRow.appendChild(el('span', badgeClass, findingLabel(e)));
    if (e.weak) badgeRow.appendChild(el('span', 'badge weak', 'weak'));
    head.appendChild(badgeRow);
    head.appendChild(el('h2', '', 'Connection worth checking'));
    head.appendChild(el('p', 'card-sub', 'Changed together in ' + plural(e.d.shared, 'commit') + ' · Last together ' + relativeDate(e.d.lastTogether)));
    panel.appendChild(head);

    var labels = distinguishingPaths(e.s.safePath, e.t.safePath);

    var pairContainer = el('div', 'pair-container');
    var boxA = el('div', 'pair-box');
    var boxAHead = el('div', 'pair-box-head');
    var linkA = el('button', 'file-link', e.s.safePath);
    linkA.type = 'button';
    linkA.addEventListener('click', function () { selectNode(e.s, activeReturnFam || undefined); });
    boxAHead.appendChild(linkA);
    boxA.appendChild(boxAHead);
    boxA.appendChild(el('div', 'pair-dir', 'Folder: ' + e.s.safeDir + ' · Changed in ' + plural(e.s.changes, 'commit') + (e.s.author ? ' · Top author: ' + e.s.author : '')));
    pairContainer.appendChild(boxA);

    var wire = el('div', 'pair-wire');
    wire.appendChild(createSwatchSvg(e.d.relationship));
    wire.appendChild(el('span', '', plural(e.d.shared, 'shared commit')));
    wire.appendChild(createSwatchSvg(e.d.relationship));
    pairContainer.appendChild(wire);

    var boxB = el('div', 'pair-box');
    var boxBHead = el('div', 'pair-box-head');
    var linkB = el('button', 'file-link', e.t.safePath);
    linkB.type = 'button';
    linkB.addEventListener('click', function () { selectNode(e.t, activeReturnFam || undefined); });
    boxBHead.appendChild(linkB);
    boxB.appendChild(boxBHead);
    boxB.appendChild(el('div', 'pair-dir', 'Folder: ' + e.t.safeDir + ' · Changed in ' + plural(e.t.changes, 'commit') + (e.t.author ? ' · Top author: ' + e.t.author : '')));
    pairContainer.appendChild(boxB);
    panel.appendChild(pairContainer);

    var grid = el('div', 'cochange-grid');
    var card1 = el('div', 'cochange-card');
    card1.appendChild(el('div', 'cochange-pct', pct(e.d.confidence)));
    var wLabel = edgeWeightingLabel(e.d);
    var desc1 = (wLabel ? '(' + wLabel + ') ' : '') + labels[0] + ' changes also modified ' + labels[1] + ' (' + e.d.shared + ' of ' + e.d.fromChanges + ' commits) ' + formatCi(e.d.interval, e.d.weighted);
    card1.appendChild(el('div', 'cochange-label', desc1));
    grid.appendChild(card1);

    var card2 = el('div', 'cochange-card');
    card2.appendChild(el('div', 'cochange-pct', pct(e.d.reverseConfidence)));
    var desc2 = (wLabel ? '(' + wLabel + ') ' : '') + labels[1] + ' changes also modified ' + labels[0] + ' (' + e.d.shared + ' of ' + e.d.toChanges + ' commits) ' + formatCi(e.d.reverseInterval, e.d.weighted);
    card2.appendChild(el('div', 'cochange-label', desc2));
    grid.appendChild(card2);
    panel.appendChild(grid);

    var atlasForwardFirst = e.d.confidence > e.d.reverseConfidence ||
      (e.d.confidence === e.d.reverseConfidence && e.d.fromChanges <= e.d.toChanges);
    var atlasLabels = distinguishingPaths(
      atlasForwardFirst ? e.s.safePath : e.t.safePath,
      atlasForwardFirst ? e.t.safePath : e.s.safePath
    );
    var atlasReadingGuide = buildClientReadingGuide(e, atlasForwardFirst, atlasLabels, null);
    panel.appendChild(renderReadingFindingDisclosure(atlasReadingGuide, 'atlas-reading-finding'));

    var callout = el('div', 'callout ' + e.d.relationship);
    callout.appendChild(el('div', 'callout-title', 'Why it matters'));
    var p1 = el('p', '', 'These files have been updated together before. If you are making changes to one, consider reviewing both.');
    callout.appendChild(p1);
    var p2 = el('p');
    if (e.d.relationship === 'ghost') {
      p2.textContent = 'No direct or one-step-removed import relationship found in the current code. Based on ' + plural(e.d.shared, 'shared commit') + ', so this is an investigative clue rather than a confirmed compile-time dependency.';
    } else if (e.d.relationship === 'indirect') {
      p2.textContent = 'Connected indirectly (one step removed through an intermediate file) in the dependency tree.';
    } else if (e.d.relationship === 'direct') {
      p2.textContent = 'Connected by a direct import link in the current codebase.';
    } else if (e.d.relationship === 'test') {
      p2.textContent = String(e.d.why || '').trim().toLowerCase() === 'both are tests'
        ? 'Both files are test files that have moved together in ' + plural(e.d.shared, 'shared commit') + '.'
        : 'Test file that repeatedly changes alongside this code (' + plural(e.d.shared, 'shared commit') + ').';
    } else {
      p2.textContent = 'Import relationship status could not be fully verified from static imports.';
    }
    callout.appendChild(p2);
    panel.appendChild(callout);

    if (e.d.evidence && e.d.evidence.length > 0) {
      var details = el('details', 'evidence-wrap');
      details.open = true;
      details.appendChild(el('summary', '', 'View ' + e.d.evidence.length + ' supporting commit' + (e.d.evidence.length === 1 ? '' : 's')));
      var list = el('ul', 'evidence');
      e.d.evidence.forEach(function (ev) {
        var li = el('li');
        var hash = el('button', 'hash', ev.hash.slice(0, 7));
        hash.type = 'button'; hash.title = 'Copy full commit hash';
        hash.addEventListener('click', function () { copyText(ev.hash, hash, 'Copied'); });
        li.appendChild(hash);
        var body = el('div', 'evidence-item-body');
        body.appendChild(el('div', '', ev.date + '  ' + sanitizeText(ev.subject)));
        list.appendChild(li);
        li.appendChild(body);
      });
      details.appendChild(list);
      panel.appendChild(details);
    }

    var cliCmd = e.d.explainCommand || fallbackExplainCommand(e.s.path, e.t.path);
    var cliBox = el('div', 'cli-box');
    var cliHead = el('div', 'cli-box-head');
    cliHead.appendChild(el('span', 'cli-box-label', 'Inspect paired diffs locally'));
    var copyCliBtn = el('button', 'btn-cli-copy', 'Copy CLI command');
    copyCliBtn.type = 'button';
    copyCliBtn.addEventListener('click', function () {
      copyText(cliCmd, copyCliBtn, 'Copied');
    });
    cliHead.appendChild(copyCliBtn);
    cliBox.appendChild(cliHead);
    cliBox.appendChild(el('code', 'cli-code', sanitizeText(cliCmd)));
    panel.appendChild(cliBox);

    var exportBtn = el('button', 'btn-export', 'Copy finding for PR / discussion');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', function () {
      var markdown = formatFindingMarkdown(e);
      copyText(markdown, exportBtn, 'Copied finding to clipboard');
    });
    panel.appendChild(exportBtn);
  }

  function renderSelectedNode(n) {
    var backBtn = el('button', 'back-btn', '← Back to overview');
    backBtn.type = 'button';
    backBtn.addEventListener('click', clearSelection);
    panel.appendChild(backBtn);

    panel.appendChild(el('div', 'cut-section-label', 'C-02 / EVIDENCE'));
    if (n.frame) panel.appendChild(el('span', 'cut-chip', n.frame.id));
    panel.appendChild(el('h2', '', base(n.safePath)));
    panel.appendChild(el('p', 'path', n.safePath));
    var who = n.author ? ' Most commits by ' + n.author + ' (' + pct(n.share || 0) + ').' : '';
    panel.appendChild(el('p', '', 'Folder: ' + n.safeDir + ' · Changed in ' + plural(n.changes, 'commit') + '.' + who));

    var rels = n.edges.filter(isVisible).sort(compareEdgesByPriority);
    panel.appendChild(el('h3', '', 'Connected file relationships (' + rels.length + ')'));

    if (rels.length === 0) {
      panel.appendChild(el('p', '', 'Its relationships are hidden by the filters above.'));
    } else {
      var cardsContainer = el('div', 'cards-list');
      rels.forEach(function (e) {
        cardsContainer.appendChild(relationshipCard(e));
      });
      panel.appendChild(cardsContainer);
    }
  }

  // ---- RA-17 Investigation Board (Briefing Mode) ---------------------------
  var appEl = document.querySelector('.app');
  var briefingEl = document.getElementById('briefing-view');
  var atlasStageEl = document.getElementById('atlas-stage');
  var viewBriefingBtn = document.getElementById('view-briefing');
  var viewAtlasBtn = document.getElementById('view-atlas');
  var briefingScriptEl = document.getElementById('ra-briefing');
  var briefingData = null;
  if (briefingScriptEl && briefingScriptEl.textContent) {
    try { briefingData = JSON.parse(briefingScriptEl.textContent); } catch (_) { briefingData = null; }
  }
  var viewMode = 'briefing';
  var briefingShowAllRanked = false;
  var readingFindingOpen = false;
  var briefingSelectedEdgeIdx = briefingData && briefingData.featured ? briefingData.featured.edgeIndex : (edges[0] ? 0 : -1);
  var briefingSelectedFamilyIdx = (briefingData && briefingData.featured && (briefingData.featured.isFamily || briefingData.featured.kind === 'family') && typeof briefingData.featured.familyIndex === 'number')
    ? briefingData.featured.familyIndex
    : -1;
  var briefingUseDefaultFeatured = Boolean(briefingData && briefingData.featured);

  function makeHelpBtn(popoverId, ariaLabel, visibleLabel) {
    var btn = el('button', 'f12-help-btn' + (visibleLabel ? ' f12-help-pill' : ''), visibleLabel ? (visibleLabel + ' ?') : '?');
    btn.type = 'button';
    btn.setAttribute('popovertarget', popoverId);
    var fullLabel = visibleLabel ? (visibleLabel + ' ? \u2014 ' + ariaLabel) : ariaLabel;
    btn.setAttribute('aria-label', fullLabel);
    btn.title = fullLabel;
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var pop = document.getElementById(popoverId);
      if (!pop) return;
      if (typeof pop.togglePopover === 'function') return;
      var isOpen = pop.classList.contains(':popover-open');
      var allPops = document.querySelectorAll('.f12-help-popover');
      for (var i = 0; i < allPops.length; i++) {
        allPops[i].classList.remove(':popover-open');
      }
      if (!isOpen) pop.classList.add(':popover-open');
    });
    return btn;
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t && t.closest && (t.closest('.f12-help-popover') || t.closest('.f12-help-btn'))) return;
    var openPops = document.querySelectorAll('.f12-help-popover');
    for (var i = 0; i < openPops.length; i++) {
      openPops[i].classList.remove(':popover-open');
    }
  });

  var fgDetailsEl = document.getElementById('field-guide-details');
  var fgCloseBtn = document.getElementById('field-guide-close');
  if (fgCloseBtn && fgDetailsEl) {
    fgCloseBtn.addEventListener('click', function () {
      fgDetailsEl.open = false;
      var fgSum = fgDetailsEl.querySelector('summary');
      if (fgSum && typeof fgSum.focus === 'function') fgSum.focus();
    });
  }
  var moreGlossaryBtns = document.querySelectorAll('.f12-help-more-btn');
  for (var mgi = 0; mgi < moreGlossaryBtns.length; mgi++) {
    moreGlossaryBtns[mgi].addEventListener('click', function (ev) {
      var btn = ev.currentTarget;
      var targetId = btn ? btn.getAttribute('data-glossary-target') : null;
      var openPops = document.querySelectorAll('.f12-help-popover');
      for (var pi = 0; pi < openPops.length; pi++) {
        openPops[pi].classList.remove(':popover-open');
        try { if (typeof openPops[pi].hidePopover === 'function') openPops[pi].hidePopover(); } catch (_) {}
      }
      if (fgDetailsEl) {
        fgDetailsEl.open = true;
      }
      if (targetId) {
        var targetDet = document.getElementById(targetId);
        if (targetDet) {
          targetDet.open = true;
          var sum = targetDet.querySelector('summary');
          if (sum && typeof sum.focus === 'function') sum.focus();
          if (typeof targetDet.scrollIntoView === 'function') {
            targetDet.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
          }
        }
      }
    });
  }

  function buildClientReadingGuide(edgeObj, forwardFirst, dynLabels, activeFamilyEntry) {
    var d = edgeObj.d;
    var safeFrom = dynLabels[0];
    var safeTo = dynLabels[1];
    var fromChanges = forwardFirst ? d.fromChanges : d.toChanges;
    var toChanges = forwardFirst ? d.toChanges : d.fromChanges;
    var conf = forwardFirst ? d.confidence : d.reverseConfidence;
    var revConf = forwardFirst ? d.reverseConfidence : d.confidence;
    var iv = forwardFirst ? d.interval : d.reverseInterval;
    var pctVal = Math.floor(conf * 100 + 1e-9);
    var revPctVal = Math.floor(revConf * 100 + 1e-9);
    var rawPctVal = fromChanges > 0 ? Math.floor((d.shared / fromChanges) * 100 + 1e-9) : 0;
    var revRawPctVal = toChanges > 0 ? Math.floor((d.shared / toChanges) * 100 + 1e-9) : 0;
    var lowPct = Math.floor(iv.low * 100 + 1e-9);
    var highPct = Math.ceil(iv.high * 100 - 1e-9);
    var isWeighted = Boolean(d.weighted);
    var wPhrase = edgeWeightingLabel(d);
    var familyPrefix = '';
    if (activeFamilyEntry && activeFamilyEntry.evidence && activeFamilyEntry.evidence.familySummary) {
      var fs = activeFamilyEntry.evidence.familySummary;
      familyPrefix = 'Across this ' + fs.members.length + '-file family (' + fs.qualifyingPairs + ' of ' + fs.possiblePairs + ' pairs qualifying), the lead pair is ' + safeFrom + ' \u2192 ' + safeTo + '. ';
    }
    var whatItSaysLabel = isWeighted
      ? 'What does ' + pctVal + '% weighted (' + rawPctVal + '% raw) mean?'
      : 'What does ' + pctVal + '% mean?';
    var whatItSays = isWeighted
      ? familyPrefix + 'With ' + wPhrase + ' scoring active, ' + safeFrom + ' \u2192 ' + safeTo + ' scores ' + pctVal + '% weighted confidence across ' + d.shared + ' of ' + fromChanges + ' raw analyzed commits (' + rawPctVal + '% raw ratio; unweighted 95% Wilson range ' + lowPct + '\u2013' + highPct + '%). In the reverse direction (' + safeTo + ' \u2192 ' + safeFrom + '), the score is ' + revPctVal + '% weighted (' + d.shared + ' of ' + toChanges + ' raw commits, ' + revRawPctVal + '% raw).'
      : familyPrefix + 'Of the ' + fromChanges + ' analyzed commits that changed ' + safeFrom + ', ' + d.shared + ' also changed ' + safeTo + ' (' + pctVal + '%, 95% Wilson confidence range ' + lowPct + '\u2013' + highPct + '%). In the reverse direction (' + safeTo + ' \u2192 ' + safeFrom + '), ' + d.shared + ' of ' + toChanges + ' commits moved together (' + revPctVal + '%).';
    var whatItDoesNotSayLabel = 'Does that mean ' + safeTo + ' needs changing now?';
    var relExp = '';
    if (d.relationship === 'ghost') {
      relExp = 'This history does not establish a ' + pctVal + '% probability of a bug, a missing edit, or a runtime dependency. No direct or one-step-removed static import link was detected between ' + safeFrom + ' and ' + safeTo + ' in current code\u2014this is a historical signal to investigate, not proof that your current change requires updating ' + safeTo + '.';
    } else if (d.relationship === 'unknown') {
      relExp = 'Static import analysis could not verify whether ' + safeFrom + ' and ' + safeTo + ' import each other (for example, non-JS/TS files, dynamic specifiers, or pairs beyond the import classification cap). "Unchecked" means import status is unknown\u2014not that an import link is absent\u2014and does not prove ' + safeTo + ' needs an update now.';
    } else if (d.relationship === 'indirect') {
      relExp = 'These files are connected indirectly (one step removed through an intermediate module) in current code and have moved together historically, but that still does not guarantee every edit to ' + safeFrom + ' requires modifying ' + safeTo + '.';
    } else if (d.relationship === 'test') {
      var isBothTests = String(d.why || '').trim().toLowerCase() === 'both are tests';
      relExp = isBothTests
        ? 'Both ' + safeFrom + ' and ' + safeTo + ' are test files that changed together in ' + d.shared + ' of ' + fromChanges + ' analyzed commits (' + pctVal + '%). Shared test edits often reflect fixture, helper, or suite-wide assertion updates rather than a direct runtime dependency, so check whether your current change affects shared test setup.'
        : 'This links a test file and the code it exercises (' + d.shared + ' of ' + fromChanges + ' analyzed commits, ' + pctVal + '%). Behavioral changes to ' + safeFrom + ' usually require updating ' + safeTo + ', though internal refactors that preserve behavior may not.';
    } else {
      relExp = 'These files have a direct import link in current code, but historical co-change still does not prove that every isolated edit to ' + safeFrom + ' requires modifying ' + safeTo + '.';
    }
    if (d.verdict) {
      var vTag = d.verdict.kind === 'confirmed'
        ? 'Recorded verdict (confirmed dependency): "' + sanitizeText(d.verdict.reason) + '".'
        : 'Recorded verdict (expected / silenced relationship): "' + sanitizeText(d.verdict.reason) + '".';
      relExp += ' ' + vTag;
    }
    var leadNode = forwardFirst ? edgeObj.s : edgeObj.t;
    var isBotOrAgentLead = leadNode && leadNode.author && /\[bot\]$|\b(?:dependabot|renovate|github-actions|snyk-bot|greenkeeper|semantic-release-bot|mergify|copilot-swe-agent|devin-ai-integration|cursor-agent|codex|claude-code|gemini-code-assist)\b/i.test(leadNode.author);
    if (leadNode && !isBotOrAgentLead && typeof leadNode.share === 'number' && leadNode.share >= 0.6) {
      var authorSharePct = Math.floor(leadNode.share * 100 + 1e-9);
      relExp += ' One contributor made ' + authorSharePct + '% of the analyzed changes to ' + safeFrom + ', so this pattern may reflect one contributor\'s workflow habits rather than a strict code dependency.';
    }
    var fromAlone = Math.max(0, fromChanges - d.shared);
    var toAlone = Math.max(0, toChanges - d.shared);
    var totalAlone = fromAlone + toAlone;
    var whatToInspect = totalAlone > 0
      ? 'Review the ' + d.shared + ' shared commit receipts below alongside the ' + totalAlone + ' counterexample commit' + (totalAlone === 1 ? '' : 's') + ' where ' + safeFrom + ' (' + fromAlone + ') or ' + safeTo + ' (' + toAlone + ') changed alone. Check whether the historical co-changes resemble your current edit.'
      : 'Review the ' + d.shared + ' shared commit receipts below (neither file changed alone in the analyzed window) and run the CLI explain command to inspect the paired diff hunks.';
    var summaryLine = isWeighted
      ? 'Reading this finding \u00b7 ' + pctVal + '% weighted (' + d.shared + '/' + fromChanges + ' raw commits) is historical co-change, not proof \u2014 Explain these numbers \u25b8'
      : 'Reading this finding \u00b7 ' + pctVal + '% (' + d.shared + '/' + fromChanges + ' commits) is historical co-change, not proof \u2014 Explain these numbers \u25b8';
    return {
      heading: 'READING THIS FINDING \u00b7 EXPLAIN THESE NUMBERS',
      summaryLine: summaryLine,
      whatItSaysLabel: whatItSaysLabel,
      whatItSays: whatItSays,
      whatItDoesNotSayLabel: whatItDoesNotSayLabel,
      whatItDoesNotSay: relExp,
      whatToInspectLabel: 'What should I inspect next?',
      whatToInspect: whatToInspect
    };
  }

  function renderReadingFindingDisclosure(guide, idAttr) {
    var det = el('details', 'f12-reading-finding');
    if (idAttr) det.id = idAttr;
    det.open = readingFindingOpen;
    det.addEventListener('toggle', function () {
      readingFindingOpen = Boolean(det.open);
    });
    det.appendChild(el('summary', '', guide.summaryLine || guide.heading || 'READING THIS FINDING \u00b7 EXPLAIN THESE NUMBERS'));
    var body = el('div', 'f12-reading-body');
    var row1 = el('div', 'f12-reading-item');
    row1.appendChild(el('strong', '', guide.whatItSaysLabel));
    row1.appendChild(document.createTextNode(guide.whatItSays));
    body.appendChild(row1);
    var row2 = el('div', 'f12-reading-item');
    row2.appendChild(el('strong', '', guide.whatItDoesNotSayLabel));
    row2.appendChild(document.createTextNode(guide.whatItDoesNotSay));
    body.appendChild(row2);
    var row3 = el('div', 'f12-reading-item');
    row3.appendChild(el('strong', '', guide.whatToInspectLabel));
    row3.appendChild(document.createTextNode(guide.whatToInspect));
    body.appendChild(row3);
    det.appendChild(body);
    return det;
  }

  function renderAboutAnalysisSection(targetEl) {
    if (!targetEl || !briefingData || !briefingData.provenance) return;
    var prov = briefingData.provenance;
    var sec = el('section', 'f12-about-panel');
    sec.id = 'about-this-analysis';
    sec.setAttribute('aria-label', 'About this analysis');
    var det = el('details', 'f12-about-details');
    det.id = 'about-analysis-details';
    det.appendChild(el('summary', '', prov.title + ' \u25b8'));
    var body = el('div', 'f12-about-body');
    body.appendChild(el('p', 'f12-fg-sub', prov.subtitle));
    var dl = el('dl', 'f12-provenance-list');
    (prov.items || []).forEach(function (it) {
      var row = el('div', 'f12-prov-row');
      row.appendChild(el('dt', '', it.label));
      row.appendChild(el('dd', '', it.value));
      dl.appendChild(row);
    });
    body.appendChild(dl);
    if (prov.warnings && prov.warnings.length > 0) {
      var wBox = el('div', 'f12-prov-warnings');
      wBox.textContent = prov.warnings.map(function (w) { return '! ' + w; }).join(' | ');
      body.appendChild(wBox);
    }
    det.appendChild(body);
    sec.appendChild(det);

    var foot = el('footer', 'f12-report-footer');
    foot.appendChild(el('span', '', prov.footerText));
    var ghLink = el('a', '', 'View project on GitHub \u2197');
    ghLink.href = prov.githubUrl || 'https://github.com/lbrodie11/repo-archaeology';
    ghLink.target = '_blank';
    ghLink.rel = 'noopener noreferrer';
    foot.appendChild(ghLink);
    sec.appendChild(foot);
    targetEl.appendChild(sec);
  }

  function encodeHashPart(p) {
    return encodeURIComponent(String(p || '')).replace(/\.\./g, '%2E%2E');
  }
  function makeFindingHash(a, b) {
    return '#f=' + encodeHashPart(a) + '..' + encodeHashPart(b);
  }
  function resolveEdgeFromHash(hashStr) {
    var trimmed = String(hashStr || '').replace(/^#/, '');
    if (trimmed.indexOf('f=') !== 0) return null;
    var payload = trimmed.slice(2);
    var sep = payload.indexOf('..');
    if (sep <= 0 || sep >= payload.length - 2) return null;
    var fromPath = '', toPath = '';
    try {
      fromPath = decodeURIComponent(payload.slice(0, sep));
      toPath = decodeURIComponent(payload.slice(sep + 2));
    } catch (_) {
      return null;
    }
    var found = edgeByPairKey[edgeKey(fromPath, toPath)];
    return found || null;
  }

  function syncMarkerDom() {
    if (viewMode === 'briefing') {
      var panelMarkers = panel ? panel.querySelectorAll('.marker-active') : [];
      for (var i = 0; i < panelMarkers.length; i++) {
        panelMarkers[i].classList.remove('marker-active');
      }
      var chip = briefingEl ? briefingEl.querySelector('.f12-kicker-chip') : null;
      if (chip) chip.classList.add('marker-active');
    } else {
      var briefingMarkers = briefingEl ? briefingEl.querySelectorAll('.marker-active') : [];
      for (var j = 0; j < briefingMarkers.length; j++) {
        briefingMarkers[j].classList.remove('marker-active');
      }
      syncCardMarkerBadges();
    }
  }

  function setViewMode(mode) {
    viewMode = mode === 'atlas' ? 'atlas' : 'briefing';
    if (appEl) appEl.setAttribute('data-view', viewMode);
    if (viewBriefingBtn) viewBriefingBtn.setAttribute('aria-pressed', String(viewMode === 'briefing'));
    if (viewAtlasBtn) viewAtlasBtn.setAttribute('aria-pressed', String(viewMode === 'atlas'));
    var isAtlas = viewMode === 'atlas';
    if (briefingEl) {
      briefingEl.hidden = isAtlas;
      if (isAtlas) briefingEl.setAttribute('inert', '');
      else briefingEl.removeAttribute('inert');
    }
    if (atlasStageEl) {
      atlasStageEl.hidden = !isAtlas;
      if (!isAtlas) atlasStageEl.setAttribute('inert', '');
      else atlasStageEl.removeAttribute('inert');
    }
    if (panel) {
      panel.hidden = !isAtlas;
      if (!isAtlas) panel.setAttribute('inert', '');
      else panel.removeAttribute('inert');
    }
    if (isAtlas) {
      resizeNow();
      if (selectedEdge) {
        if (selectedEdge.frame) flyToFrame(selectedEdge.frame);
        else flyToNodes([selectedEdge.s, selectedEdge.t]);
      } else if (selectedFamily) {
        var activeFamV = resolveActiveFamilyView(selectedFamily);
        if (activeFamV) flyToNodes(activeFamV.nodes);
        else fitSheet();
      } else {
        fitSheet();
      }
      renderPanel();
      requestDraw();
    } else {
      renderBriefingBoard();
    }
    syncMarkerDom();
  }
  if (viewBriefingBtn) {
    viewBriefingBtn.addEventListener('click', function () { setViewMode('briefing'); });
  }
  if (viewAtlasBtn) {
    viewAtlasBtn.addEventListener('click', function () { setViewMode('atlas'); });
  }

  function selectBriefingFamily(familyIdx, updateHash) {
    if (!briefingData || !briefingData.families || !briefingData.families[familyIdx]) return;
    var famEntry = briefingData.families[familyIdx];
    briefingSelectedFamilyIdx = familyIdx;
    briefingSelectedEdgeIdx = famEntry.edgeIndex;
    briefingUseDefaultFeatured = Boolean(
      briefingData.featured &&
      (briefingData.featured.isFamily || briefingData.featured.kind === 'family') &&
      briefingData.featured.familyIndex === familyIdx
    );
    selectedEdge = null;
    selectedNode = null;
    var famObj = families[familyIdx] || null;
    var activeFamView = famObj ? resolveActiveFamilyView(famObj) : null;
    if (!activeFamView && famObj) {
      var visFamEdges = (famObj.edges || []).filter(isVisible);
      activeFamView = {
        id: famObj.d.id,
        d: famObj.d,
        family: famObj,
        members: famObj.members || [],
        nodes: famObj.nodes || [],
        nodeSet: famObj.nodeSet || new Set(),
        edges: visFamEdges,
        edgeSet: new Set(visFamEdges),
        undrawnPairs: famObj.undrawnPairs || [],
        qualifyingPairs: famObj.d.qualifyingPairs,
        possiblePairs: famObj.d.possiblePairs,
        commitsTouchingTwoOrMore: famObj.d.commitsTouchingTwoOrMore,
        commitsTouchingAll: famObj.d.commitsTouchingAll,
        lastTogether: famObj.d.lastTogether,
        evidence: famObj.d.evidence || [],
        isSubset: false,
        _isFallbackView: true
      };
    }
    selectedFamily = activeFamView;
    if (updateHash && famEntry.hash) {
      try {
        if (window.history && typeof window.history.replaceState === 'function') {
          window.history.replaceState(null, '', famEntry.hash);
        }
      } catch (_) {}
    }
    renderPanel();
  }

  function selectBriefingEdge(edgeObj, isDefault, updateHash) {
    if (!edgeObj) return;
    briefingSelectedEdgeIdx = edgeObj.idx;
    briefingSelectedFamilyIdx = (isDefault && briefingData && briefingData.featured && (briefingData.featured.isFamily || briefingData.featured.kind === 'family') && typeof briefingData.featured.familyIndex === 'number')
      ? briefingData.featured.familyIndex
      : -1;
    briefingUseDefaultFeatured = Boolean(isDefault);
    selectedEdge = edgeObj;
    selectedNode = null;
    selectedFamily = null;
    if (updateHash) {
      var forwardFirst = edgeObj.d.confidence > edgeObj.d.reverseConfidence ||
        (edgeObj.d.confidence === edgeObj.d.reverseConfidence && edgeObj.d.fromChanges <= edgeObj.d.toChanges);
      var fromP = forwardFirst ? edgeObj.s.path : edgeObj.t.path;
      var toP = forwardFirst ? edgeObj.t.path : edgeObj.s.path;
      try {
        if (window.history && typeof window.history.replaceState === 'function') {
          window.history.replaceState(null, '', makeFindingHash(fromP, toP));
        }
      } catch (_) {}
    }
    renderPanel();
  }

  function pointToSegDist(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-6) return Math.hypot(px - x1, py - y1);
    var t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function buildDynamicPlate(seedNodes, featuredEdgeIdxSet, leadEdgeObj, isMobile) {
    var w = isMobile ? 340 : 760;
    var h = isMobile ? 240 : 420;
    var maxEgoNodes = isMobile ? 6 : 12;
    var maxLabelLen = isMobile ? 20 : 28;
    var padX = isMobile ? 48 : 88;
    var padTop = isMobile ? 36 : 58;
    var padBottom = isMobile ? 28 : 42;

    var seedSet = Object.create(null);
    seedNodes.forEach(function (sn) { seedSet[sn.i] = true; });

    // Count connected component size via BFS
    var compVisited = Object.create(null);
    var bfsQ = seedNodes.slice();
    bfsQ.forEach(function (sn) { compVisited[sn.i] = true; });
    var qHead = 0;
    while (qHead < bfsQ.length) {
      var curr = bfsQ[qHead++];
      curr.edges.forEach(function (ce) {
        var nb = ce.s === curr ? ce.t : ce.s;
        if (!compVisited[nb.i]) {
          compVisited[nb.i] = true;
          bfsQ.push(nb);
        }
      });
    }
    var fullComponentNodeCount = Object.keys(compVisited).length;

    // Collect 1-hop neighbors ranked by ghost status & Wilson lower bound
    var neighborMap = Object.create(null);
    seedNodes.forEach(function (sn) {
      sn.edges.forEach(function (ce) {
        var other = ce.s === sn ? ce.t : ce.s;
        if (seedSet[other.i]) return;
        var wScore = (ce.d.relationship === 'ghost' ? 10 : 1) + ce.lowBound * 4 + (ce.d.shared || 0) * 0.05;
        if (!neighborMap[other.i] || wScore > neighborMap[other.i].score) {
          neighborMap[other.i] = { node: other, score: wScore };
        }
      });
    });
    var sortedNeighbors = Object.keys(neighborMap)
      .map(function (k) { return neighborMap[k]; })
      .sort(function (a, b) {
        return b.score - a.score || a.node.path.localeCompare(b.node.path);
      });
    var orderedSeeds = seedNodes.slice().sort(function (a, b) {
      var aLead = a === leadEdgeObj.s ? 0 : (a === leadEdgeObj.t ? 1 : 2);
      var bLead = b === leadEdgeObj.s ? 0 : (b === leadEdgeObj.t ? 1 : 2);
      return aLead - bLead || a.path.localeCompare(b.path);
    });
    var chosenNodes = orderedSeeds.slice(0, maxEgoNodes);
    for (var ni = 0; ni < sortedNeighbors.length && chosenNodes.length < maxEgoNodes; ni++) {
      chosenNodes.push(sortedNeighbors[ni].node);
    }

    var chosenSet = Object.create(null);
    chosenNodes.forEach(function (cn, idx) { chosenSet[cn.i] = idx; });

    var cx = w * 0.5;
    var cy = h * (isMobile ? 0.56 : 0.55);
    var posX = new Array(chosenNodes.length);
    var posY = new Array(chosenNodes.length);
    var sCount = Math.min(orderedSeeds.length, chosenNodes.length);
    var outerCount = chosenNodes.length - sCount;
    if (sCount === 2) {
      var span = isMobile ? (outerCount >= 5 ? 116 : 96) : (outerCount >= 5 ? 236 : 196);
      var seedY = outerCount >= 5 ? (cy - (isMobile ? 22 : 36)) : cy;
      posX[0] = cx - span * 0.5; posY[0] = seedY;
      posX[1] = cx + span * 0.5; posY[1] = seedY;
    } else if (sCount >= 5) {
      var leadSpan = isMobile ? 104 : 212;
      var leadY = cy - (isMobile ? 20 : 34);
      posX[0] = cx - leadSpan * 0.5; posY[0] = leadY;
      posX[1] = cx + leadSpan * 0.5; posY[1] = leadY;
      var remSeeds = sCount - 2;
      var rxLarge = isMobile ? 106 : 244;
      var ryLarge = isMobile ? 72 : 136;
      for (var rsi = 0; rsi < remSeeds; rsi++) {
        var rAng = -0.14 * Math.PI + (1.28 * Math.PI * rsi) / Math.max(1, remSeeds - 1);
        posX[2 + rsi] = cx + Math.cos(rAng) * rxLarge;
        posY[2 + rsi] = cy + Math.sin(rAng) * ryLarge;
      }
    } else {
      var rx = isMobile ? 76 : 168;
      var ry = isMobile ? 54 : 104;
      for (var si = 0; si < sCount; si++) {
        var sAng = -Math.PI * 0.75 + (2 * Math.PI * si) / Math.max(1, sCount);
        posX[si] = cx + Math.cos(sAng) * rx;
        posY[si] = cy + Math.sin(sAng) * ry;
      }
    }
    var outerAnchorX = new Array(chosenNodes.length);
    var outerAnchorY = new Array(chosenNodes.length);
    for (var ai = 0; ai < sCount; ai++) {
      outerAnchorX[ai] = posX[ai];
      outerAnchorY[ai] = posY[ai];
    }
    for (var oi = 0; oi < outerCount; oi++) {
      var oIdx = sCount + oi;
      var oAng = outerCount >= 4
        ? (-0.14 * Math.PI + (1.28 * Math.PI * oi) / Math.max(1, outerCount - 1))
        : (-Math.PI * 0.35 + (2 * Math.PI * oi) / Math.max(1, outerCount));
      var ox = cx + Math.cos(oAng) * (isMobile ? 118 : 262);
      var oy = cy + Math.sin(oAng) * (isMobile ? 78 : 146);
      posX[oIdx] = ox;
      posY[oIdx] = oy;
      outerAnchorX[oIdx] = ox;
      outerAnchorY[oIdx] = oy;
    }

    // Collect internal edges and per-node degree
    var rawSubEdges = [];
    edges.forEach(function (ce) {
      var u = chosenSet[ce.s.i], v = chosenSet[ce.t.i];
      if (u !== undefined && v !== undefined) {
        rawSubEdges.push({ ce: ce, u: u, v: v, isFeat: Boolean(featuredEdgeIdxSet[ce.idx]) });
      }
    });
    // Prune crossing non-incident chords on dense >=5-node cliques so the blueprint stays legible
    var subEdges = (chosenNodes.length >= 5 && rawSubEdges.length > chosenNodes.length + 3)
      ? rawSubEdges.filter(function (se) {
          if (se.ce === leadEdgeObj) return true;
          if (se.ce.s === leadEdgeObj.s || se.ce.s === leadEdgeObj.t || se.ce.t === leadEdgeObj.s || se.ce.t === leadEdgeObj.t) {
            return true;
          }
          var diff = Math.abs(se.u - se.v);
          return diff === 1 || diff === chosenNodes.length - 1;
        })
      : rawSubEdges;
    var hiddenContextEdges = Math.max(0, rawSubEdges.length - subEdges.length);
    var nodeDeg = new Array(chosenNodes.length).fill(0);
    subEdges.forEach(function (se) {
      nodeDeg[se.u]++;
      nodeDeg[se.v]++;
    });

    // Reserve top-center balloon zone on desktop; on mobile keep compact
    var balloonW = isMobile ? 256 : 310;
    var balloonH = isMobile ? 28 : 38;
    var balloonX = Math.round(cx - balloonW / 2);
    var balloonY = isMobile ? 8 : 34;

    // 50-step deterministic force relaxation (degree-normalized so cliques never collapse inward)
    var idealDist = isMobile ? 88 : 168;
    for (var step = 0; step < 50; step++) {
      var cooling = 1 - step / 55;
      var fx = new Array(chosenNodes.length).fill(0);
      var fy = new Array(chosenNodes.length).fill(0);
      for (var i = 0; i < chosenNodes.length; i++) {
        for (var j = i + 1; j < chosenNodes.length; j++) {
          var dx = posX[j] - posX[i];
          var dy = posY[j] - posY[i];
          var dist = Math.hypot(dx, dy) || 0.5;
          var minSep = (i < sCount && j < sCount) ? idealDist * 1.15 : idealDist * 0.92;
          if (dist < minSep * 1.45) {
            var rep = ((minSep * 1.45 - dist) / dist) * 0.46 * cooling;
            fx[i] -= dx * rep; fy[i] -= dy * rep;
            fx[j] += dx * rep; fy[j] += dy * rep;
          }
        }
      }
      subEdges.forEach(function (se) {
        var dx = posX[se.v] - posX[se.u];
        var dy = posY[se.v] - posY[se.u];
        var dist = Math.hypot(dx, dy) || 1;
        var target = se.isFeat ? idealDist * 1.08 : idealDist * 0.98;
        var degNorm = Math.sqrt(Math.max(1, Math.max(nodeDeg[se.u] || 1, nodeDeg[se.v] || 1)));
        var pull = ((dist - target) / dist) * (0.12 / degNorm) * cooling;
        fx[se.u] += dx * pull; fy[se.u] += dy * pull;
        fx[se.v] -= dx * pull; fy[se.v] -= dy * pull;
      });
      for (var k = 0; k < chosenNodes.length; k++) {
        var isSeedNode = k < sCount;
        var damp = isSeedNode ? 0.35 : 0.78;
        if (!isSeedNode && outerAnchorX[k] !== undefined) {
          fx[k] += (outerAnchorX[k] - posX[k]) * 0.14 * cooling;
          fy[k] += (outerAnchorY[k] - posY[k]) * 0.14 * cooling;
        }
        // Keep nodes out of balloon box
        if (
          posX[k] > balloonX - 24 &&
          posX[k] < balloonX + balloonW + 24 &&
          posY[k] < balloonY + balloonH + 26
        ) {
          fy[k] += 5.5 * cooling;
        }
        posX[k] = Math.max(padX, Math.min(w - padX, posX[k] + fx[k] * damp));
        posY[k] = Math.max(padTop, Math.min(h - padBottom, posY[k] + fy[k] * damp));
      }
    }

    // Compute Balloon target at midpoint of lead edge
    var leadSIdx = chosenSet[leadEdgeObj.s.i] !== undefined ? chosenSet[leadEdgeObj.s.i] : 0;
    var leadTIdx = chosenSet[leadEdgeObj.t.i] !== undefined ? chosenSet[leadEdgeObj.t.i] : Math.min(1, chosenNodes.length - 1);
    var btX = Math.round((posX[leadSIdx] + posX[leadTIdx]) / 2);
    var btY = Math.round((posY[leadSIdx] + posY[leadTIdx]) / 2);
    balloonW = Math.max(balloonW, isMobile ? 268 : 340);
    balloonX = Math.max(12, Math.min(w - balloonW - 12, Math.round(btX - balloonW / 2)));
    balloonY = Math.max(8, Math.min(btY - balloonH - (isMobile ? 16 : 24), isMobile ? 14 : 46));
    var balloonBox = { x: balloonX, y: balloonY, w: balloonW, h: balloonH };
    for (var bni = 0; bni < chosenNodes.length; bni++) {
      if (
        posX[bni] > balloonBox.x - 42 &&
        posX[bni] < balloonBox.x + balloonBox.w + 42 &&
        posY[bni] < balloonBox.y + balloonBox.h + 22
      ) {
        posY[bni] = Math.min(h - padBottom, balloonBox.y + balloonBox.h + 24);
      }
    }

    // Build short labels (distinguish endpoints if duplicate basenames)
    var baseCounts = Object.create(null);
    var rawBasenames = chosenNodes.map(function (cn) {
      var parts = cn.safePath.split('/');
      return parts[parts.length - 1] || cn.safePath;
    });
    rawBasenames.forEach(function (b) { baseCounts[b] = (baseCounts[b] || 0) + 1; });

    var placedBoxes = [{ x: balloonBox.x - 4, y: balloonBox.y - 4, w: balloonBox.w + 8, h: balloonBox.h + 12 }];
    var pNodes = [];
    var candDirs = [
      { key: 'S', dx: 0, dy: 1, align: 'center' },
      { key: 'N', dx: 0, dy: -1, align: 'center' },
      { key: 'E', dx: 1, dy: 0, align: 'left' },
      { key: 'W', dx: -1, dy: 0, align: 'right' },
      { key: 'SE', dx: 0.85, dy: 0.85, align: 'left' },
      { key: 'SW', dx: -0.85, dy: 0.85, align: 'right' },
      { key: 'NE', dx: 0.85, dy: -0.85, align: 'left' },
      { key: 'NW', dx: -0.85, dy: -0.85, align: 'right' }
    ];

    chosenNodes.forEach(function (cn, idx) {
      var isSeed = idx < sCount;
      var r = isSeed ? (isMobile ? 7.5 : 9.2) : (isMobile ? 5.5 : 6.6);
      var nx = Math.round(posX[idx]);
      var ny = Math.round(posY[idx]);
      var lblText = rawBasenames[idx];
      if (baseCounts[lblText] > 1) {
        var segs = cn.safePath.split('/').filter(Boolean);
        if (segs.length >= 2) lblText = segs[segs.length - 2] + '/' + segs[segs.length - 1];
      }
      lblText = middleTruncate(lblText, maxLabelLen);
      var charW = isMobile ? 7.1 : 7.5;
      var tw = Math.max(40, Math.round(lblText.length * charW + 10));
      var th = 18;

      var bestCand = null;
      var bestPenalty = Infinity;
      candDirs.forEach(function (cd) {
        var offset = r + 8;
        var ax = Math.round(nx + cd.dx * offset);
        var ay = Math.round(ny + cd.dy * (cd.dy === 0 ? 4 : offset + (cd.dy > 0 ? 8 : -2)));
        var bx = cd.align === 'right' ? ax - tw + 4 : (cd.align === 'center' ? Math.round(ax - tw / 2) : ax - 4);
        var by = ay - 13;
        var pen = 0;
        if (bx < 6) pen += (6 - bx) * 25;
        if (by < 6) pen += (6 - by) * 25;
        if (bx + tw > w - 6) pen += (bx + tw - (w - 6)) * 25;
        if (by + th > h - 6) pen += (by + th - (h - 6)) * 25;

        placedBoxes.forEach(function (ob) {
          var ox = Math.max(0, Math.min(bx + tw, ob.x + ob.w) - Math.max(bx, ob.x));
          var oy = Math.max(0, Math.min(by + th, ob.y + ob.h) - Math.max(by, ob.y));
          if (ox > 0 && oy > 0) pen += ox * oy * 12 + 500;
        });
        for (var m = 0; m < chosenNodes.length; m++) {
          var mx = posX[m], my = posY[m], mr = (m < sCount ? 9.5 : 6.8) + 4;
          var nearX = Math.max(bx, Math.min(mx, bx + tw));
          var nearY = Math.max(by, Math.min(my, by + th));
          if (Math.hypot(mx - nearX, my - nearY) < mr) pen += 900;
        }
        var lcx = bx + tw / 2, lcy = by + th / 2;
        subEdges.forEach(function (se) {
          if (!se.isFeat) return;
          var dSeg = pointToSegDist(lcx, lcy, posX[se.u], posY[se.u], posX[se.v], posY[se.v]);
          if (dSeg < th * 0.75) pen += 320;
        });
        if (pen < bestPenalty) {
          bestPenalty = pen;
          bestCand = { x: bx, y: by, w: tw, h: th, anchorX: ax, anchorY: ay, textAlign: cd.align };
        }
      });

      if (bestCand) placedBoxes.push(bestCand);
      pNodes.push({
        nodeIndex: cn.i,
        path: cn.safePath,
        shortLabel: lblText,
        dir: cn.safeDir,
        changes: cn.changes || 1,
        x: nx,
        y: ny,
        r: r,
        isFeaturedEndpoint: isSeed,
        label: bestCand
      });
    });

    var pEdges = subEdges.map(function (se) {
      return {
        edgeIndex: se.ce.idx,
        sourceNodeIndex: se.ce.s.i,
        targetNodeIndex: se.ce.t.i,
        x1: Math.round(posX[se.u]),
        y1: Math.round(posY[se.u]),
        x2: Math.round(posX[se.v]),
        y2: Math.round(posY[se.v]),
        relationship: se.ce.d.relationship,
        intervalLow: se.ce.lowBound,
        strokeWidth: Number((1.6 + se.ce.lowBound * 3.2).toFixed(2)),
        isFeatured: se.isFeat,
        isLeadEdge: se.ce === leadEdgeObj
      };
    });

    var forwardFirst = leadEdgeObj.d.confidence > leadEdgeObj.d.reverseConfidence ||
      (leadEdgeObj.d.confidence === leadEdgeObj.d.reverseConfidence && leadEdgeObj.d.fromChanges <= leadEdgeObj.d.toChanges);
    var denom = forwardFirst ? leadEdgeObj.d.fromChanges : leadEdgeObj.d.toChanges;
    var relSuffix = leadEdgeObj.d.relationship === 'ghost' ? 'no import' : leadEdgeObj.d.relationship + ' link';

    return {
      width: w,
      height: h,
      nodes: pNodes,
      edges: pEdges,
      balloonTarget: { x: btX, y: btY },
      balloonBox: balloonBox,
      balloonText: leadEdgeObj.d.shared + ' of ' + denom + ' commits together \u00b7 ' + relSuffix,
      fullComponentNodeCount: fullComponentNodeCount,
      hiddenContextEdges: hiddenContextEdges
    };
  }

  var dynamicPlateCache = Object.create(null);

  function snapshotPlateInitialState(plate, w, h) {
    if (!plate || plate._initialNodes) return;
    plate._initialNodes = (plate.nodes || []).map(function (pn) {
      return {
        x: pn.x,
        y: pn.y,
        label: pn.label
          ? {
              x: pn.label.x,
              y: pn.label.y,
              w: pn.label.w,
              h: pn.label.h,
              anchorX: pn.label.anchorX,
              anchorY: pn.label.anchorY,
              textAlign: pn.label.textAlign
            }
          : null
      };
    });
    plate._initialEdges = (plate.edges || []).map(function (pe) {
      return { x1: pe.x1, y1: pe.y1, x2: pe.x2, y2: pe.y2 };
    });
    plate._initialBalloonTarget = plate.balloonTarget
      ? { x: plate.balloonTarget.x, y: plate.balloonTarget.y }
      : null;
    if (!plate._viewBox) {
      plate._viewBox = { x: 0, y: 0, w: w, h: h };
    }
  }

  function renderPlateSvg(svgEl, plate, balloonText, plateOpts) {
    var ns = 'http://www.w3.org/2000/svg';
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
    var w = plate.width || 760, h = plate.height || 420;
    snapshotPlateInitialState(plate, w, h);
    var vb = plate._viewBox || (plate._viewBox = { x: 0, y: 0, w: w, h: h });
    svgEl.setAttribute('viewBox', vb.x.toFixed(1) + ' ' + vb.y.toFixed(1) + ' ' + vb.w.toFixed(1) + ' ' + vb.h.toFixed(1));

    var defs = document.createElementNS(ns, 'defs');
    var grad = document.createElementNS(ns, 'linearGradient');
    grad.setAttribute('id', 'ra17-plate-bg');
    grad.setAttribute('gradientUnits', 'userSpaceOnUse');
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0'); grad.setAttribute('y2', String(h));
    [['0%', '#13304f'], ['60%', '#0e2540'], ['100%', '#09192c']].forEach(function (st) {
      var stop = document.createElementNS(ns, 'stop');
      stop.setAttribute('offset', st[0]);
      stop.setAttribute('stop-color', st[1]);
      grad.appendChild(stop);
    });
    defs.appendChild(grad);

    var pat = document.createElementNS(ns, 'pattern');
    pat.setAttribute('id', 'ra17-plate-grid');
    pat.setAttribute('width', '32'); pat.setAttribute('height', '32');
    pat.setAttribute('patternUnits', 'userSpaceOnUse');
    var patPath = document.createElementNS(ns, 'path');
    patPath.setAttribute('d', 'M 32 0 L 0 0 0 32');
    patPath.setAttribute('fill', 'none');
    patPath.setAttribute('stroke', '#173b61');
    patPath.setAttribute('stroke-width', '1');
    pat.appendChild(patPath);
    defs.appendChild(pat);
    svgEl.appendChild(defs);

    var bg1 = document.createElementNS(ns, 'rect');
    bg1.setAttribute('x', '-2000'); bg1.setAttribute('y', '-2000');
    bg1.setAttribute('width', '5000'); bg1.setAttribute('height', '5000');
    bg1.setAttribute('fill', 'url(#ra17-plate-bg)');
    svgEl.appendChild(bg1);

    var bg2 = document.createElementNS(ns, 'rect');
    bg2.setAttribute('x', '-2000'); bg2.setAttribute('y', '-2000');
    bg2.setAttribute('width', '5000'); bg2.setAttribute('height', '5000');
    bg2.setAttribute('fill', 'url(#ra17-plate-grid)');
    svgEl.appendChild(bg2);

    var edgeLayer = document.createElementNS(ns, 'g');
    var nodeLayer = document.createElementNS(ns, 'g');
    var balloonLayer = document.createElementNS(ns, 'g');
    balloonLayer.setAttribute('class', 'f12-plate-balloon');
    svgEl.appendChild(edgeLayer);
    svgEl.appendChild(nodeLayer);
    svgEl.appendChild(balloonLayer);

    var rawEdges = plate.edges || [];
    var hasLeadEdge = rawEdges.some(function (e) { return Boolean(e.isLeadEdge); });
    var featuredEdgeCount = rawEdges.filter(function (e) { return Boolean(e.isFeatured); }).length;
    function isPrimaryEdge(pe) {
      return Boolean(pe.isLeadEdge || (pe.isFeatured && (!hasLeadEdge || featuredEdgeCount <= 3)));
    }
    var primaryNodeIdxSet = Object.create(null);
    rawEdges.forEach(function (pe) {
      if (isPrimaryEdge(pe)) {
        primaryNodeIdxSet[pe.sourceNodeIndex] = true;
        primaryNodeIdxSet[pe.targetNodeIndex] = true;
      }
    });
    if (Object.keys(primaryNodeIdxSet).length === 0) {
      (plate.nodes || []).slice(0, 2).forEach(function (pn) {
        primaryNodeIdxSet[pn.nodeIndex] = true;
      });
    }

    var sortedEdgesForDraw = rawEdges.slice().sort(function (a, b) {
      return (isPrimaryEdge(a) ? 1 : 0) - (isPrimaryEdge(b) ? 1 : 0);
    });

    var edgeRecords = [];
    sortedEdgesForDraw.forEach(function (pe) {
      var primary = isPrimaryEdge(pe);
      var strokeW = String(pe.strokeWidth || 2.2);
      var halo = null;
      if (primary) {
        // Blueprint chalk halo (#fffef9) instead of #ffd60a stroke (--f-marker is never a stroke)
        halo = document.createElementNS(ns, 'line');
        halo.setAttribute('x1', String(pe.x1)); halo.setAttribute('y1', String(pe.y1));
        halo.setAttribute('x2', String(pe.x2)); halo.setAttribute('y2', String(pe.y2));
        halo.setAttribute('stroke', '#fffef9');
        halo.setAttribute('stroke-width', String(Math.max(6.8, Number(strokeW) + 4.2)));
        halo.setAttribute('stroke-opacity', '0.45');
        halo.setAttribute('stroke-linecap', 'round');
        edgeLayer.appendChild(halo);
      }
      var line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', String(pe.x1)); line.setAttribute('y1', String(pe.y1));
      line.setAttribute('x2', String(pe.x2)); line.setAttribute('y2', String(pe.y2));
      var col = pe.relationship === 'ghost' ? '#ff4f9a' : (pe.relationship === 'unknown' ? '#e3b65b' : (pe.relationship === 'indirect' ? '#7fd1b0' : '#7eb3e0'));
      line.setAttribute('stroke', col);
      line.setAttribute('stroke-width', primary ? String(Math.max(3.2, Number(strokeW) + 0.9)) : '1.35');
      line.setAttribute('stroke-opacity', primary ? '1' : '0.9');
      if (pe.relationship === 'ghost') line.setAttribute('stroke-dasharray', '9 5');
      else if (pe.relationship === 'unknown') line.setAttribute('stroke-dasharray', '2 5');
      else if (pe.relationship === 'indirect') line.setAttribute('stroke-dasharray', '5 4');
      line.setAttribute('stroke-linecap', 'round');
      edgeLayer.appendChild(line);

      var hitLine = document.createElementNS(ns, 'line');
      hitLine.setAttribute('class', 'f12-plate-edge-hit');
      hitLine.setAttribute('x1', String(pe.x1)); hitLine.setAttribute('y1', String(pe.y1));
      hitLine.setAttribute('x2', String(pe.x2)); hitLine.setAttribute('y2', String(pe.y2));
      hitLine.setAttribute('stroke', 'transparent');
      hitLine.setAttribute('stroke-width', '14');
      hitLine.setAttribute('stroke-linecap', 'round');
      edgeLayer.appendChild(hitLine);

      edgeRecords.push({ pe: pe, isPrimary: primary, haloEl: halo, lineEl: line, hitEl: hitLine });
    });

    var isCompactPlate = w <= 420;
    var nodeRecords = [];
    (plate.nodes || []).forEach(function (pn, pIdx) {
      var g = document.createElementNS(ns, 'g');
      g.setAttribute('class', 'f12-plate-node');
      g.setAttribute('data-node-idx', String(pn.nodeIndex));
      g.setAttribute('data-plate-idx', String(pIdx));

      var titleEl = document.createElementNS(ns, 'title');
      titleEl.textContent = (pn.path || pn.shortLabel || '') + ' \u00b7 drag to move';
      g.appendChild(titleEl);

      var hitC = document.createElementNS(ns, 'circle');
      hitC.setAttribute('cx', String(pn.x)); hitC.setAttribute('cy', String(pn.y));
      hitC.setAttribute('r', String(Math.max(15, (pn.r || 7) + 6)));
      hitC.setAttribute('fill', 'transparent');
      g.appendChild(hitC);

      var hue = hashHue(pn.dir || '.');
      var fillCol = 'hsl(' + hue + ', 72%, 64%)';
      var c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', String(pn.x)); c.setAttribute('cy', String(pn.y));
      c.setAttribute('r', String(pn.r));
      c.setAttribute('fill', fillCol);
      c.setAttribute('stroke', '#fffef9');
      c.setAttribute('stroke-width', pn.isFeaturedEndpoint ? '2.5' : '1.8');
      g.appendChild(c);

      var pill = null;
      var txt = null;
      var lbl = pn.label;
      if (lbl) {
        pill = document.createElementNS(ns, 'rect');
        pill.setAttribute('x', String(Math.round(lbl.x)));
        pill.setAttribute('y', String(Math.round(lbl.y)));
        pill.setAttribute('width', String(Math.round(lbl.w)));
        pill.setAttribute('height', String(Math.round(lbl.h)));
        pill.setAttribute('fill', 'rgba(9, 25, 44, 0.88)');
        g.appendChild(pill);

        txt = document.createElementNS(ns, 'text');
        txt.setAttribute('x', String(lbl.anchorX));
        txt.setAttribute('y', String(lbl.anchorY));
        var anchor = lbl.textAlign === 'right' ? 'end' : (lbl.textAlign === 'center' ? 'middle' : 'start');
        txt.setAttribute('text-anchor', anchor);
        txt.setAttribute('fill', '#fffef9');
        txt.setAttribute('font-family', '"M PLUS 1 Code", ui-monospace, "SF Mono", Menlo, Consolas, monospace');
        txt.setAttribute('font-size', isCompactPlate ? '13' : (pn.isFeaturedEndpoint ? '13.5' : '12.5'));
        txt.setAttribute('font-weight', pn.isFeaturedEndpoint ? '700' : '500');
        txt.textContent = pn.shortLabel;
        g.appendChild(txt);
      }
      nodeLayer.appendChild(g);
      nodeRecords.push({ pn: pn, isPrimary: Boolean(primaryNodeIdxSet[pn.nodeIndex]), gEl: g, hitCircleEl: hitC, circleEl: c, pillEl: pill, txtEl: txt });
    });

    function applyFocusPairFilter() {
      var focusPair = Boolean(plate._focusPairOnly);
      edgeRecords.forEach(function (er) {
        var hide = focusPair && !er.isPrimary;
        er.lineEl.style.display = hide ? 'none' : '';
        er.hitEl.style.display = hide ? 'none' : '';
        if (er.haloEl) er.haloEl.style.display = hide ? 'none' : '';
      });
      nodeRecords.forEach(function (nr) {
        var hide = focusPair && !nr.isPrimary;
        nr.gEl.style.display = hide ? 'none' : '';
      });
    }
    svgEl._setFocusPairOnly = function (active) {
      plate._focusPairOnly = Boolean(active);
      applyFocusPairFilter();
    };
    applyFocusPairFilter();

    var balloonDom = null;
    if (plate.balloonBox && balloonText) {
      var bb = plate.balloonBox;
      var shownBText = isCompactPlate ? middleTruncate(balloonText, 32) : balloonText;
      var rawBw = bb.w || bb.width || 300;
      var minBw = Math.round(shownBText.length * (isCompactPlate ? 6.9 : 7.7) + 28);
      var bw = Math.min(w - 24, Math.max(rawBw, minBw));
      var origCenter = (bb.x || 0) + rawBw / 2;
      var bx = Math.max(12, Math.min(w - bw - 12, Math.round(origCenter - bw / 2)));
      var by = bb.y, bh = bb.h || bb.height || 36;
      var bt = plate.balloonTarget || { x: bx + bw / 2, y: by + bh + 28 };
      var ax = bt.x, ay = bt.y;
      var tailBaseX = Math.max(bx + 20, Math.min(bx + bw - 20, ax));
      var tailBaseY = by + bh;

      var bgShadow = document.createElementNS(ns, 'rect');
      bgShadow.setAttribute('x', String(bx + 3)); bgShadow.setAttribute('y', String(by + 3));
      bgShadow.setAttribute('width', String(bw)); bgShadow.setAttribute('height', String(bh));
      bgShadow.setAttribute('fill', '#121212');
      balloonLayer.appendChild(bgShadow);

      var tail = document.createElementNS(ns, 'polygon');
      tail.setAttribute('points', (tailBaseX - 6) + ',' + tailBaseY + ' ' + (tailBaseX + 6) + ',' + tailBaseY + ' ' + ax + ',' + (ay - 4));
      tail.setAttribute('fill', '#fffef9');
      tail.setAttribute('stroke', '#121212');
      tail.setAttribute('stroke-width', '2');
      balloonLayer.appendChild(tail);

      var box = document.createElementNS(ns, 'rect');
      box.setAttribute('x', String(bx)); box.setAttribute('y', String(by));
      box.setAttribute('width', String(bw)); box.setAttribute('height', String(bh));
      box.setAttribute('fill', '#fffef9');
      box.setAttribute('stroke', '#121212');
      box.setAttribute('stroke-width', '2.5');
      balloonLayer.appendChild(box);

      var pin = document.createElementNS(ns, 'circle');
      pin.setAttribute('cx', String(ax)); pin.setAttribute('cy', String(ay));
      pin.setAttribute('r', '4');
      pin.setAttribute('fill', '#fffef9');
      pin.setAttribute('stroke', '#121212');
      pin.setAttribute('stroke-width', '1.8');
      balloonLayer.appendChild(pin);

      var bTxt = document.createElementNS(ns, 'text');
      bTxt.setAttribute('x', String(bx + bw / 2));
      bTxt.setAttribute('y', String(by + (isCompactPlate ? 18 : 23)));
      bTxt.setAttribute('text-anchor', 'middle');
      bTxt.setAttribute('fill', '#121212');
      bTxt.setAttribute('font-family', '"M PLUS 1 Code", ui-monospace, "SF Mono", Menlo, Consolas, monospace');
      bTxt.setAttribute('font-size', isCompactPlate ? '12.5' : '12');
      bTxt.setAttribute('font-weight', '700');
      bTxt.textContent = shownBText;
      balloonLayer.appendChild(bTxt);

      balloonDom = { bx: bx, by: by, bw: bw, bh: bh, tailEl: tail, pinEl: pin };
    }

    function syncPlateDom() {
      var curVb = plate._viewBox;
      svgEl.setAttribute('viewBox', curVb.x.toFixed(1) + ' ' + curVb.y.toFixed(1) + ' ' + curVb.w.toFixed(1) + ' ' + curVb.h.toFixed(1));
      edgeRecords.forEach(function (er) {
        var pe = er.pe;
        if (er.haloEl) {
          er.haloEl.setAttribute('x1', String(pe.x1)); er.haloEl.setAttribute('y1', String(pe.y1));
          er.haloEl.setAttribute('x2', String(pe.x2)); er.haloEl.setAttribute('y2', String(pe.y2));
        }
        er.lineEl.setAttribute('x1', String(pe.x1)); er.lineEl.setAttribute('y1', String(pe.y1));
        er.lineEl.setAttribute('x2', String(pe.x2)); er.lineEl.setAttribute('y2', String(pe.y2));
        er.hitEl.setAttribute('x1', String(pe.x1)); er.hitEl.setAttribute('y1', String(pe.y1));
        er.hitEl.setAttribute('x2', String(pe.x2)); er.hitEl.setAttribute('y2', String(pe.y2));
      });
      nodeRecords.forEach(function (nr) {
        var pn = nr.pn;
        nr.hitCircleEl.setAttribute('cx', String(pn.x)); nr.hitCircleEl.setAttribute('cy', String(pn.y));
        nr.circleEl.setAttribute('cx', String(pn.x)); nr.circleEl.setAttribute('cy', String(pn.y));
        if (pn.label && nr.pillEl && nr.txtEl) {
          nr.pillEl.setAttribute('x', String(Math.round(pn.label.x)));
          nr.pillEl.setAttribute('y', String(Math.round(pn.label.y)));
          nr.txtEl.setAttribute('x', String(Math.round(pn.label.anchorX)));
          nr.txtEl.setAttribute('y', String(Math.round(pn.label.anchorY)));
        }
      });
      if (balloonDom && plate.balloonTarget) {
        var ax = plate.balloonTarget.x, ay = plate.balloonTarget.y;
        var tbx = Math.max(balloonDom.bx + 20, Math.min(balloonDom.bx + balloonDom.bw - 20, ax));
        var tby = balloonDom.by + balloonDom.bh;
        balloonDom.tailEl.setAttribute('points', (tbx - 6) + ',' + tby + ' ' + (tbx + 6) + ',' + tby + ' ' + ax + ',' + (ay - 4));
        balloonDom.pinEl.setAttribute('cx', String(ax));
        balloonDom.pinEl.setAttribute('cy', String(ay));
      }
      if (plateOpts && typeof plateOpts.onDirtyChange === 'function') {
        plateOpts.onDirtyChange(Boolean(plate._dirty));
      }
    }

    function resetPlateLayout() {
      if (plate._initialNodes) {
        plate._initialNodes.forEach(function (initN, idx) {
          var pn = plate.nodes[idx];
          if (!pn) return;
          pn.x = initN.x;
          pn.y = initN.y;
          if (pn.label && initN.label) {
            pn.label.x = initN.label.x;
            pn.label.y = initN.label.y;
            pn.label.anchorX = initN.label.anchorX;
            pn.label.anchorY = initN.label.anchorY;
          }
        });
      }
      if (plate._initialEdges) {
        plate._initialEdges.forEach(function (initE, idx) {
          var pe = plate.edges[idx];
          if (!pe) return;
          pe.x1 = initE.x1; pe.y1 = initE.y1;
          pe.x2 = initE.x2; pe.y2 = initE.y2;
        });
      }
      if (plate._initialBalloonTarget && plate.balloonTarget) {
        plate.balloonTarget.x = plate._initialBalloonTarget.x;
        plate.balloonTarget.y = plate._initialBalloonTarget.y;
      }
      plate._viewBox = { x: 0, y: 0, w: w, h: h };
      plate._dirty = false;
      nodeRecords.forEach(function (nr) {
        if (nr.gEl.parentNode === nodeLayer) nodeLayer.appendChild(nr.gEl);
      });
      syncPlateDom();
    }

    svgEl._resetPlateLayout = resetPlateLayout;

    function clientToSvg(clientX, clientY) {
      var rect = svgEl.getBoundingClientRect();
      var curVb = plate._viewBox;
      return {
        x: curVb.x + ((clientX - rect.left) / Math.max(1, rect.width)) * curVb.w,
        y: curVb.y + ((clientY - rect.top) / Math.max(1, rect.height)) * curVb.h
      };
    }

    var plateDrag = null;
    svgEl.addEventListener('pointerdown', function (ev) {
      if (ev.button !== undefined && ev.button !== 0) return;
      var target = ev.target;
      var foundNodeRec = null;
      for (var ni = 0; ni < nodeRecords.length; ni++) {
        if (nodeRecords[ni].gEl === target || nodeRecords[ni].gEl.contains(target)) {
          foundNodeRec = nodeRecords[ni];
          break;
        }
      }
      var foundEdgeRec = null;
      if (!foundNodeRec) {
        for (var ei = 0; ei < edgeRecords.length; ei++) {
          if (edgeRecords[ei].hitEl === target || edgeRecords[ei].lineEl === target || edgeRecords[ei].haloEl === target) {
            foundEdgeRec = edgeRecords[ei];
            break;
          }
        }
      }
      var startSvg = clientToSvg(ev.clientX, ev.clientY);
      if (foundNodeRec) {
        var pn = foundNodeRec.pn;
        plateDrag = {
          mode: 'node',
          pointerId: ev.pointerId,
          nodeRec: foundNodeRec,
          startClientX: ev.clientX,
          startClientY: ev.clientY,
          startSvg: startSvg,
          origX: pn.x,
          origY: pn.y,
          origLabel: pn.label
            ? {
                x: pn.label.x,
                y: pn.label.y,
                anchorX: pn.label.anchorX,
                anchorY: pn.label.anchorY
              }
            : null,
          moved: false
        };
        foundNodeRec.gEl.classList.add('is-dragging');
        if (foundNodeRec.gEl.parentNode === nodeLayer) {
          nodeLayer.appendChild(foundNodeRec.gEl);
        }
      } else {
        plateDrag = {
          mode: 'pan',
          pointerId: ev.pointerId,
          edgeRec: foundEdgeRec,
          startClientX: ev.clientX,
          startClientY: ev.clientY,
          origVbX: plate._viewBox.x,
          origVbY: plate._viewBox.y,
          moved: false
        };
        svgEl.classList.add('is-panning');
      }
      try {
        if (typeof svgEl.setPointerCapture === 'function') svgEl.setPointerCapture(ev.pointerId);
      } catch (_) {}
    });

    svgEl.addEventListener('pointermove', function (ev) {
      if (!plateDrag || plateDrag.pointerId !== ev.pointerId) return;
      var distPx = Math.hypot(ev.clientX - plateDrag.startClientX, ev.clientY - plateDrag.startClientY);
      if (distPx > 3) plateDrag.moved = true;
      if (!plateDrag.moved) return;

      if (plateDrag.mode === 'node') {
        var curSvg = clientToSvg(ev.clientX, ev.clientY);
        var dx = curSvg.x - plateDrag.startSvg.x;
        var dy = curSvg.y - plateDrag.startSvg.y;
        var pn = plateDrag.nodeRec.pn;
        pn.x = Math.round(plateDrag.origX + dx);
        pn.y = Math.round(plateDrag.origY + dy);
        if (pn.label && plateDrag.origLabel) {
          pn.label.x = Math.round(plateDrag.origLabel.x + dx);
          pn.label.y = Math.round(plateDrag.origLabel.y + dy);
          pn.label.anchorX = Math.round(plateDrag.origLabel.anchorX + dx);
          pn.label.anchorY = Math.round(plateDrag.origLabel.anchorY + dy);
        }
        edgeRecords.forEach(function (er) {
          var pe = er.pe;
          var touched = false;
          if (pe.sourceNodeIndex === pn.nodeIndex) {
            pe.x1 = pn.x; pe.y1 = pn.y; touched = true;
          }
          if (pe.targetNodeIndex === pn.nodeIndex) {
            pe.x2 = pn.x; pe.y2 = pn.y; touched = true;
          }
          if (touched && pe.isLeadEdge && plate.balloonTarget) {
            plate.balloonTarget.x = Math.round((pe.x1 + pe.x2) / 2);
            plate.balloonTarget.y = Math.round((pe.y1 + pe.y2) / 2);
          }
        });
        plate._dirty = true;
        syncPlateDom();
      } else {
        var rect = svgEl.getBoundingClientRect();
        var curVb = plate._viewBox;
        curVb.x = plateDrag.origVbX - ((ev.clientX - plateDrag.startClientX) / Math.max(1, rect.width)) * curVb.w;
        curVb.y = plateDrag.origVbY - ((ev.clientY - plateDrag.startClientY) / Math.max(1, rect.height)) * curVb.h;
        plate._dirty = true;
        syncPlateDom();
      }
    });

    function finishPlateDrag(ev) {
      if (!plateDrag || (ev && ev.pointerId !== undefined && plateDrag.pointerId !== ev.pointerId)) return;
      var wasMoved = plateDrag.moved;
      var mode = plateDrag.mode;
      var nodeRec = plateDrag.nodeRec;
      var edgeRec = plateDrag.edgeRec;
      if (nodeRec) nodeRec.gEl.classList.remove('is-dragging');
      svgEl.classList.remove('is-panning');
      try {
        if (ev && typeof svgEl.releasePointerCapture === 'function') svgEl.releasePointerCapture(ev.pointerId);
      } catch (_) {}
      plateDrag = null;
      if (!wasMoved && ev && ev.type === 'pointerup' && plateOpts) {
        if (mode === 'node' && nodeRec && typeof plateOpts.onSelectNode === 'function') {
          plateOpts.onSelectNode(nodeRec.pn.nodeIndex);
        } else if (edgeRec && typeof plateOpts.onSelectEdge === 'function') {
          plateOpts.onSelectEdge(edgeRec.pe.edgeIndex);
        }
      }
    }

    svgEl.addEventListener('pointerup', finishPlateDrag);
    svgEl.addEventListener('pointercancel', finishPlateDrag);
    svgEl.addEventListener('lostpointercapture', finishPlateDrag);

    svgEl.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var rect = svgEl.getBoundingClientRect();
      var curVb = plate._viewBox;
      var rx = (ev.clientX - rect.left) / Math.max(1, rect.width);
      var ry = (ev.clientY - rect.top) / Math.max(1, rect.height);
      var worldX = curVb.x + rx * curVb.w;
      var worldY = curVb.y + ry * curVb.h;
      var zoomFactor = Math.exp(ev.deltaY * 0.0014);
      var nextW = Math.max(w * 0.3, Math.min(w * 1.75, curVb.w * zoomFactor));
      var nextH = (nextW / w) * h;
      curVb.w = nextW;
      curVb.h = nextH;
      curVb.x = worldX - rx * nextW;
      curVb.y = worldY - ry * nextH;
      plate._dirty = true;
      syncPlateDom();
    }, { passive: false });

    svgEl.addEventListener('dblclick', function (ev) {
      ev.preventDefault();
      resetPlateLayout();
    });
  }

  function buildPairRankedRowFromEdge(edgeObj, findingId) {
    var d = edgeObj.d;
    var fFirst = d.confidence > d.reverseConfidence ||
      (d.confidence === d.reverseConfidence && d.fromChanges <= d.toChanges);
    var labels = distinguishingPaths(
      fFirst ? edgeObj.s.safePath : edgeObj.t.safePath,
      fFirst ? edgeObj.t.safePath : edgeObj.s.safePath
    );
    var denom = fFirst ? d.fromChanges : d.toChanges;
    var confVal = fFirst ? d.confidence : d.reverseConfidence;
    var iv = fFirst ? d.interval : d.reverseInterval;
    var fPath = fFirst ? edgeObj.s.path : edgeObj.t.path;
    var tPath = fFirst ? edgeObj.t.path : edgeObj.s.path;
    return {
      findingId: findingId,
      kind: 'pair',
      edgeIndex: edgeObj.idx,
      title: labels[0] + ' \u2192 ' + labels[1],
      fromPath: fPath,
      toPath: tPath,
      relationship: d.relationship,
      shared: d.shared,
      denom: denom,
      ratioText: d.shared + '/' + denom,
      pctText: d.weighted ? (pct(confVal) + ' weighted') : pct(confVal),
      pointPct: Math.floor(confVal * 100 + 1e-9),
      rangeLowPct: Math.floor(iv.low * 100 + 1e-9),
      rangeHighPct: Math.ceil(iv.high * 100 - 1e-9),
      lastTogether: d.lastTogether,
      hash: makeFindingHash(fPath, tPath)
    };
  }

  function renderBriefingBoard() {
    if (!briefingEl || !briefingData) return;
    var prevFocusDesc = null;
    var activeEl = document.activeElement;
    if (activeEl && briefingEl.contains(activeEl)) {
      if (activeEl.id === 'toggle-all-findings') {
        prevFocusDesc = { kind: 'toggle-all' };
      } else if (activeEl.classList && activeEl.classList.contains('f12-rank-row') && activeEl.getAttribute('data-finding-id')) {
        prevFocusDesc = { kind: 'rank-row', findingId: activeEl.getAttribute('data-finding-id') };
      } else if (activeEl.classList && activeEl.classList.contains('f12-sec-card') && activeEl.getAttribute('data-edge-idx')) {
        prevFocusDesc = { kind: 'sec-card', edgeIdx: activeEl.getAttribute('data-edge-idx') };
      } else if (activeEl.classList && activeEl.classList.contains('f12-family-pair-row') && activeEl.getAttribute('data-edge-idx')) {
        prevFocusDesc = { kind: 'family-pair', edgeIdx: activeEl.getAttribute('data-edge-idx') };
      } else if (activeEl.id) {
        prevFocusDesc = { kind: 'id', id: activeEl.id };
      }
    }
    briefingEl.textContent = '';
    var isMobileViewport = Boolean(window.innerWidth && window.innerWidth <= 640);

    // 1. Compact Inline Stat Strip with accessible '?' popover buttons
    var st = briefingData.stats;
    var strip = el('div', 'f12-stat-strip');
    var p1 = el('div', 'f12-stat-pill');
    p1.appendChild(el('strong', '', String(st.ghostCount)));
    p1.appendChild(el('span', '', 'GHOST WIRES'));
    p1.appendChild(makeHelpBtn('help-ghost-wire', 'What is a ghost wire?'));
    strip.appendChild(p1);

    var p2 = el('div', 'f12-stat-pill');
    p2.appendChild(el('strong', '', String(st.familyCount)));
    p2.appendChild(el('span', '', 'FAMILIES'));
    p2.appendChild(makeHelpBtn('help-family', 'What is a finding family?'));
    strip.appendChild(p2);

    var p3 = el('div', 'f12-stat-pill');
    p3.appendChild(el('strong', '', String(st.unknownCount)));
    var uncheckedLabel = st.totalUnchecked !== st.unknownCount
      ? 'UNCHECKED (' + st.unknownCount + ' SHOWN OF ' + st.totalUnchecked + ')'
      : 'UNCHECKED (' + st.totalUnchecked + ' TOTAL)';
    p3.appendChild(el('span', '', uncheckedLabel));
    p3.appendChild(makeHelpBtn('help-unchecked', 'What does Unchecked mean?'));
    strip.appendChild(p3);

    var p4 = el('div', 'f12-stat-pill');
    p4.appendChild(el('strong', '', st.commitsAnalyzed.toLocaleString('en-US')));
    p4.appendChild(el('span', '', 'COMMITS ANALYSED'));
    strip.appendChild(p4);
    briefingEl.appendChild(strip);

    // 2. Empty state when no findings exist (includes context graph plate + dynamic threshold CLI suggestion)
    if (!briefingData.featured || edges.length === 0) {
      var emp = briefingData.emptyState;
      var empPanel = el('article', 'f12-cut-panel');
      empPanel.id = 'cut-c01';
      empPanel.appendChild(el('span', 'f12-cut-label', 'C-01'));
      var empKicker = el('div', 'f12-kicker-row');
      empKicker.appendChild(el('span', 'f12-kicker-chip marker-active', 'C-01 / NO GHOST WIRES ABOVE THRESHOLD'));
      empPanel.appendChild(empKicker);
      empPanel.appendChild(el('h2', 'f12-headline', emp ? emp.headline : 'No co-changing file pairs passed current thresholds'));
      empPanel.appendChild(el('p', 'f12-lede', emp ? emp.subhead : 'Try lowering --min-shared or --min-confidence.'));
      if (emp && emp.plate && emp.plate.nodes && emp.plate.nodes.length > 0) {
        var empPlateWrap = el('div', 'f12-plate-wrap');
        var empSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        empSvg.setAttribute('id', 'featured-plate-svg');
        empSvg.setAttribute('class', 'f12-plate-svg');
        empSvg.setAttribute('role', 'img');
        empSvg.setAttribute('aria-label', 'Analyzed files context plate');
        renderPlateSvg(empSvg, emp.plate, '');
        empPlateWrap.appendChild(empSvg);
        var empFooter = el('div', 'f12-plate-footer');
        empFooter.appendChild(el('span', 'f12-plate-meta', 'Context view: top ' + emp.plate.nodes.length + ' most frequently changed files in repository'));
        empPlateWrap.appendChild(empFooter);
        empPanel.appendChild(empPlateWrap);
      }
      if (emp && emp.suggestedCommand) {
        var empCli = el('div', 'f12-cli-row');
        empCli.appendChild(el('code', 'f12-cli-code', emp.suggestedCommand));
        var empCopyBtn = el('button', 'f12-copy-btn', 'Copy CLI command');
        empCopyBtn.type = 'button';
        empCopyBtn.addEventListener('click', function () { copyText(emp.suggestedCommand, empCopyBtn, 'Copied'); });
        empCli.appendChild(empCopyBtn);
        empPanel.appendChild(empCli);
      }
      briefingEl.appendChild(empPanel);
      renderAboutAnalysisSection(briefingEl);
      return;
    }

    // Filter ranked findings by active relationship toggles and search query (supporting mixed-kind families)
    var q = search && search.value ? search.value.trim().toLowerCase() : '';
    var filteredRanked = [];
    (briefingData.ranked || []).forEach(function (item) {
      if (item.kind === 'family') {
        var famEntryRef = (typeof item.familyIndex === 'number' && briefingData.families) ? briefingData.families[item.familyIndex] : null;
        var memberIndices = item.edgeIndices || (famEntryRef && famEntryRef.edgeIndices) || [item.edgeIndex];
        var visMemberIndices = memberIndices.filter(function (ei) { return edges[ei] && visible[edges[ei].d.relationship]; });
        if (visMemberIndices.length === 0) return;
        if (visMemberIndices.length === 1) {
          var singleRow = buildPairRankedRowFromEdge(edges[visMemberIndices[0]], item.findingId);
          if (q) {
            var sHay = (singleRow.title + ' ' + (singleRow.fromPath || '') + ' ' + (singleRow.toPath || '')).toLowerCase();
            if (sHay.indexOf(q) < 0) return;
          }
          filteredRanked.push(singleRow);
          return;
        }
        var leadVisEdge = edges[visMemberIndices[0]];
        var hasVisGhost = visMemberIndices.some(function (ei) { return edges[ei].d.relationship === 'ghost'; });
        var famRow = Object.assign({}, item, {
          edgeIndex: leadVisEdge.idx,
          relationship: hasVisGhost ? 'ghost' : leadVisEdge.d.relationship
        });
        if (leadVisEdge.idx !== item.edgeIndex) {
          var leadPairRow = buildPairRankedRowFromEdge(leadVisEdge, item.findingId);
          famRow.ratioText = leadPairRow.ratioText;
          famRow.pctText = leadPairRow.pctText;
          famRow.pointPct = leadPairRow.pointPct;
          famRow.rangeLowPct = leadPairRow.rangeLowPct;
          famRow.rangeHighPct = leadPairRow.rangeHighPct;
        }
        if (q) {
          var fHay = (famRow.title + ' ' + (famEntryRef && famEntryRef.memberPaths ? famEntryRef.memberPaths.join(' ') : '')).toLowerCase();
          if (fHay.indexOf(q) < 0) return;
        }
        filteredRanked.push(famRow);
        return;
      }
      if (item.relationship && !visible[item.relationship]) return;
      if (q) {
        var hay = (item.title + ' ' + (item.fromPath || '') + ' ' + (item.toPath || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return;
      }
      filteredRanked.push(item);
    });

    // Resolve active finding: family or edge, respecting relationship filter toggles (including mixed families)
    var activeFamilyEntry = (briefingSelectedFamilyIdx >= 0 && briefingData.families && briefingData.families[briefingSelectedFamilyIdx])
      ? briefingData.families[briefingSelectedFamilyIdx]
      : null;
    var activeEdge = edges[briefingSelectedEdgeIdx] || edges[briefingData.featured.edgeIndex] || edges[0];
    var familyFilteredToSubset = false;
    if (activeFamilyEntry) {
      var famIndices = activeFamilyEntry.edgeIndices || [activeFamilyEntry.edgeIndex];
      var visFamIndices = famIndices.filter(function (ei) { return edges[ei] && visible[edges[ei].d.relationship]; });
      if (visFamIndices.length >= 2) {
        activeEdge = edges[visFamIndices[0]] || activeEdge;
        familyFilteredToSubset = visFamIndices.length < famIndices.length || activeEdge.idx !== activeFamilyEntry.edgeIndex;
      } else if (visFamIndices.length === 1) {
        activeFamilyEntry = null;
        activeEdge = edges[visFamIndices[0]] || activeEdge;
      } else {
        activeFamilyEntry = null;
      }
    }
    var currentRel = activeFamilyEntry
      ? (activeEdge ? activeEdge.d.relationship : activeFamilyEntry.relationship)
      : (activeEdge ? activeEdge.d.relationship : 'ghost');

    // If current finding's relationship kind is hidden by filter toggles, promote top visible finding
    if (currentRel && !visible[currentRel] && filteredRanked.length > 0) {
      var topVis = filteredRanked[0];
      if (topVis.kind === 'family' && typeof topVis.familyIndex === 'number' && briefingData.families && briefingData.families[topVis.familyIndex]) {
        activeFamilyEntry = briefingData.families[topVis.familyIndex];
        var promFamIndices = activeFamilyEntry.edgeIndices || [activeFamilyEntry.edgeIndex];
        var visPromIndices = promFamIndices.filter(function (ei) { return edges[ei] && visible[edges[ei].d.relationship]; });
        activeEdge = edges[visPromIndices[0] != null ? visPromIndices[0] : activeFamilyEntry.edgeIndex] || activeEdge;
        familyFilteredToSubset = visPromIndices.length < promFamIndices.length || activeEdge.idx !== activeFamilyEntry.edgeIndex;
      } else {
        activeFamilyEntry = null;
        var promEdge = edges[topVis.edgeIndex] || (topVis.fromPath && topVis.toPath ? edgeByPairKey[edgeKey(topVis.fromPath, topVis.toPath)] : null);
        if (promEdge) activeEdge = promEdge;
      }
      currentRel = activeFamilyEntry
        ? (activeEdge ? activeEdge.d.relationship : activeFamilyEntry.relationship)
        : (activeEdge ? activeEdge.d.relationship : 'ghost');
    }

    var isDefaultFeatured = Boolean(
      briefingUseDefaultFeatured &&
      !familyFilteredToSubset &&
      ((activeFamilyEntry && (briefingData.featured.isFamily || briefingData.featured.kind === 'family') && briefingData.featured.familyIndex === activeFamilyEntry.familyIndex) ||
       (!activeFamilyEntry && !(briefingData.featured.isFamily || briefingData.featured.kind === 'family') && activeEdge && activeEdge.idx === briefingData.featured.edgeIndex)) &&
      visible[activeEdge ? activeEdge.d.relationship : (briefingData.featured.relationship || 'ghost')]
    );

    // If all relationship toggles are off and nothing matches, show filter empty state in C-01
    if (currentRel && !visible[currentRel] && filteredRanked.length === 0) {
      var filterEmptyPanel = el('article', 'f12-cut-panel');
      filterEmptyPanel.id = 'cut-c01';
      filterEmptyPanel.appendChild(el('span', 'f12-cut-label', 'C-01'));
      filterEmptyPanel.appendChild(el('h2', 'f12-headline', 'No findings match the active relationship filters'));
      filterEmptyPanel.appendChild(el('p', 'f12-lede', 'Enable Ghost wires, Unchecked, Indirect imports, or Import links in the filter bar above to inspect findings.'));
      briefingEl.appendChild(filterEmptyPanel);
      renderAboutAnalysisSection(briefingEl);
      return;
    }

    var featuredPayload = activeFamilyEntry || (isDefaultFeatured ? briefingData.featured : null);
    var usePrebuiltLeadCopy = Boolean(featuredPayload && !familyFilteredToSubset);

    // 3. Main 12-col Board Grid: Cut C-01 (Featured Finding + Plate) & Cut E-01 (Evidence)
    var grid = el('div', 'f12-board-grid');
    var cut01 = el('article', 'f12-cut-panel f12-cut-c01');
    cut01.id = 'cut-c01';
    cut01.appendChild(el('span', 'f12-cut-label', 'C-01'));

    // Beat 01: What we found + Jump to evidence link
    var beat01 = el('div', 'f12-beat-row');
    beat01.appendChild(el('span', 'f12-beat-tag', '01 \u00b7 WHAT WE FOUND'));
    var jumpEvBtn = el('button', 'f12-jump-btn', 'Inspect evidence \u2193');
    jumpEvBtn.type = 'button';
    jumpEvBtn.addEventListener('click', function () {
      var evEl = document.getElementById('cut-c05');
      if (evEl && typeof evEl.scrollIntoView === 'function') {
        evEl.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      }
    });
    beat01.appendChild(jumpEvBtn);
    cut01.appendChild(beat01);

    var kickerRow = el('div', 'f12-kicker-row');
    var kickerLeft = el('div', 'f12-kicker-left');
    var activeRankItem = null;
    if (briefingData.ranked) {
      for (var ri = 0; ri < briefingData.ranked.length; ri++) {
        var rItem = briefingData.ranked[ri];
        if (activeFamilyEntry && rItem.kind === 'family' && rItem.familyIndex === activeFamilyEntry.familyIndex) {
          activeRankItem = rItem; break;
        }
        if (!activeFamilyEntry && rItem.kind === 'pair' && rItem.edgeIndex === activeEdge.idx) {
          activeRankItem = rItem; break;
        }
      }
    }
    var chipLabel = featuredPayload
      ? featuredPayload.kickerChip
      : ((activeRankItem ? activeRankItem.findingId : 'F-01') + ' \u00b7 SELECTED FINDING');
    kickerLeft.appendChild(el('span', 'f12-kicker-chip' + (viewMode === 'briefing' ? ' marker-active' : ''), chipLabel));

    var relUpper = activeEdge.d.relationship === 'ghost'
      ? 'GHOST WIRE'
      : (activeEdge.d.relationship === 'unknown' ? 'UNCHECKED LINK' : activeEdge.d.relationship.toUpperCase());
    var tagLabel = featuredPayload
      ? featuredPayload.kickerTag
      : (relUpper + ' \u00b7 ' + activeEdge.d.shared + ' SHARED COMMITS');
    kickerLeft.appendChild(el('span', 'f12-tag', tagLabel));
    kickerRow.appendChild(kickerLeft);
    var lastDateStr = featuredPayload ? featuredPayload.lastTogether : activeEdge.d.lastTogether;
    kickerRow.appendChild(el('span', 'f12-last-date', 'Last together ' + lastDateStr));
    cut01.appendChild(kickerRow);

    var forwardFirst = activeEdge.d.confidence > activeEdge.d.reverseConfidence ||
      (activeEdge.d.confidence === activeEdge.d.reverseConfidence && activeEdge.d.fromChanges <= activeEdge.d.toChanges);
    var dynLabels = distinguishingPaths(
      forwardFirst ? activeEdge.s.safePath : activeEdge.t.safePath,
      forwardFirst ? activeEdge.t.safePath : activeEdge.s.safePath
    );
    var headlineText = featuredPayload
      ? featuredPayload.headline
      : (dynLabels[0] + ' and ' + dynLabels[1] + ' keep changing together');
    var dynDenom = forwardFirst ? activeEdge.d.fromChanges : activeEdge.d.toChanges;
    var dynConfVal = forwardFirst ? activeEdge.d.confidence : activeEdge.d.reverseConfidence;
    var isWeightedEdge = Boolean(activeEdge.d.weighted);
    var rawRateStr = pct(dynDenom > 0 ? activeEdge.d.shared / dynDenom : 0);
    var dynPct = isWeightedEdge ? (pct(dynConfVal) + ' weighted') : pct(dynConfVal);
    var dynIv = forwardFirst ? activeEdge.d.interval : activeEdge.d.reverseInterval;
    var dynLow = Math.floor(dynIv.low * 100 + 1e-9);
    var dynHigh = Math.ceil(dynIv.high * 100 - 1e-9);
    var dynRateDetail = isWeightedEdge
      ? (dynPct + ' (' + rawRateStr + ' raw), 95% confidence range ' + dynLow + '\u2013' + dynHigh + '%')
      : (dynPct + ', 95% confidence range ' + dynLow + '\u2013' + dynHigh + '%');
    var ledeText = usePrebuiltLeadCopy
      ? featuredPayload.lede
      : ((activeEdge.d.relationship === 'ghost'
        ? 'No direct or one-step-removed import link was detected between these files in current code, yet '
        : (activeEdge.d.relationship === 'unknown'
          ? 'Import relationship was not statically verified for this file pair, yet '
          : 'Connected via ' + activeEdge.d.relationship + ' relationship: ')) +
        activeEdge.d.shared + ' of ' + dynDenom + ' commits to ' + dynLabels[0] +
        ' also modified ' + dynLabels[1] + ' (' + dynRateDetail + ').');

    var h2 = el('h2', 'f12-headline', headlineText);
    h2.id = 'briefing-headline';
    h2.tabIndex = -1;
    cut01.appendChild(h2);
    var ledeP = el('p', 'f12-lede', ledeText);
    ledeP.id = 'briefing-lede';
    cut01.appendChild(ledeP);

    var plateWrap = el('div', 'f12-plate-wrap');
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('id', 'featured-plate-svg');
    svg.setAttribute('class', 'f12-plate-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Featured ego-network blueprint plate');

    var plateObj = null;
    var bText = '';
    var visMaskKey = ['ghost', 'unknown', 'indirect', 'direct', 'test'].map(function (k) { return visible[k] ? '1' : '0'; }).join('');
    var plateCacheKey = (activeFamilyEntry ? 'fam:' + activeFamilyEntry.familyIndex + ':' + activeEdge.idx : 'edge:' + activeEdge.idx) + ':' + (isMobileViewport ? 'm' : 'd') + ':' + visMaskKey;
    if (usePrebuiltLeadCopy && !isMobileViewport) {
      plateObj = featuredPayload.plate;
      bText = featuredPayload.balloonText;
    } else if (dynamicPlateCache[plateCacheKey]) {
      plateObj = dynamicPlateCache[plateCacheKey].plate;
      bText = dynamicPlateCache[plateCacheKey].bText;
    } else if (activeFamilyEntry) {
      var famNodes = [];
      var famEdgeSet = Object.create(null);
      (activeFamilyEntry.memberPaths || []).forEach(function (mp) {
        var fn = nodeByPath[mp];
        if (fn) famNodes.push(fn);
      });
      edges.forEach(function (ce) {
        if (visible[ce.d.relationship] &&
            (activeFamilyEntry.memberPaths || []).indexOf(ce.s.path) >= 0 &&
            (activeFamilyEntry.memberPaths || []).indexOf(ce.t.path) >= 0) {
          famEdgeSet[ce.idx] = true;
        }
      });
      if (famNodes.length < 2) famNodes = [activeEdge.s, activeEdge.t];
      famEdgeSet[activeEdge.idx] = true;
      plateObj = buildDynamicPlate(famNodes, famEdgeSet, activeEdge, isMobileViewport);
      bText = (!familyFilteredToSubset && activeFamilyEntry.balloonText) ? activeFamilyEntry.balloonText : plateObj.balloonText;
      dynamicPlateCache[plateCacheKey] = { plate: plateObj, bText: bText };
    } else {
      var pairSeedNodes = forwardFirst ? [activeEdge.s, activeEdge.t] : [activeEdge.t, activeEdge.s];
      var pairFeatSet = Object.create(null);
      pairFeatSet[activeEdge.idx] = true;
      plateObj = buildDynamicPlate(pairSeedNodes, pairFeatSet, activeEdge, isMobileViewport);
      bText = usePrebuiltLeadCopy ? featuredPayload.balloonText : plateObj.balloonText;
      dynamicPlateCache[plateCacheKey] = { plate: plateObj, bText: bText };
    }

    var resetPlateBtn = el('button', 'f12-plate-reset-btn', 'Reset plate');
    resetPlateBtn.type = 'button';
    resetPlateBtn.id = 'reset-plate-btn';
    resetPlateBtn.hidden = !plateObj._dirty;

    var focusPairBtn = null;
    if ((plateObj.nodes || []).length > 2) {
      var isFocused = Boolean(plateObj._focusPairOnly);
      focusPairBtn = el('button', 'f12-plate-reset-btn', isFocused ? 'Show ego network' : 'Focus selected pair');
      focusPairBtn.type = 'button';
      focusPairBtn.id = 'focus-pair-btn';
      focusPairBtn.setAttribute('aria-pressed', String(isFocused));
      focusPairBtn.addEventListener('click', function () {
        var nextFocused = !Boolean(plateObj._focusPairOnly);
        if (typeof svg._setFocusPairOnly === 'function') svg._setFocusPairOnly(nextFocused);
        focusPairBtn.setAttribute('aria-pressed', String(nextFocused));
        focusPairBtn.textContent = nextFocused ? 'Show ego network' : 'Focus selected pair';
      });
    }

    resetPlateBtn.addEventListener('click', function () {
      if (typeof svg._resetPlateLayout === 'function') svg._resetPlateLayout();
      if (focusPairBtn && plateObj._focusPairOnly) {
        if (typeof svg._setFocusPairOnly === 'function') svg._setFocusPairOnly(false);
        focusPairBtn.setAttribute('aria-pressed', 'false');
        focusPairBtn.textContent = 'Focus selected pair';
      }
      if (h2 && typeof h2.focus === 'function') h2.focus();
    });

    renderPlateSvg(svg, plateObj, bText, {
      onDirtyChange: function (isDirty) {
        resetPlateBtn.hidden = !isDirty;
      },
      onSelectEdge: function (edgeIdx) {
        if (typeof edgeIdx === 'number' && edges[edgeIdx]) {
          if (!activeFamilyEntry && edgeIdx === activeEdge.idx) return;
          selectBriefingEdge(edgeIdx);
        }
      },
      onSelectNode: function (nodeIdx) {
        if (typeof nodeIdx !== 'number' || !plateObj.edges) return;
        var incident = plateObj.edges.filter(function (pe) {
          return (pe.sourceNodeIndex === nodeIdx || pe.targetNodeIndex === nodeIdx) &&
                 edges[pe.edgeIndex] && visible[edges[pe.edgeIndex].d.relationship];
        });
        if (incident.length === 0) return;
        incident.sort(function (a, b) {
          var ea = edges[a.edgeIndex], eb = edges[b.edgeIndex];
          var aDiff = a.edgeIndex !== activeEdge.idx ? 1 : 0;
          var bDiff = b.edgeIndex !== activeEdge.idx ? 1 : 0;
          var aGhost = ea.d.relationship === 'ghost' ? 1 : 0;
          var bGhost = eb.d.relationship === 'ghost' ? 1 : 0;
          return (bGhost - aGhost) || (bDiff - aDiff) || (eb.d.overviewPriority - ea.d.overviewPriority) || (eb.d.score - ea.d.score);
        });
        var nextEdgeIdx = incident[0].edgeIndex;
        if (!activeFamilyEntry && nextEdgeIdx === activeEdge.idx) return;
        selectBriefingEdge(nextEdgeIdx);
      }
    });
    plateWrap.appendChild(svg);

    var plateFooter = el('div', 'f12-plate-footer');
    var plateLegend = el('div', 'f12-plate-legend');
    plateLegend.appendChild(el('span', 'f12-plate-legend-item', '\u2501\u2501 Featured halo + link'));
    plateLegend.appendChild(el('span', 'f12-plate-legend-item', '- - Ghost wire (long dash)'));
    plateLegend.appendChild(el('span', 'f12-plate-legend-item', '\u00b7\u00b7\u00b7 Unchecked (dotted)'));
    plateLegend.appendChild(el('span', 'f12-plate-legend-item', '\u2500\u2500 Import (solid)'));
    plateFooter.appendChild(plateLegend);
    var compTotal = plateObj.fullComponentNodeCount || (plateObj.nodes ? plateObj.nodes.length : 0);
    var hiddenEdgesCount = plateObj.hiddenContextEdges || 0;
    var hiddenEdgesNote = hiddenEdgesCount > 0
      ? ' \u00b7 ' + hiddenEdgesCount + ' ' + (hiddenEdgesCount === 1 ? 'connection' : 'connections') + ' between context files hidden (see Atlas)'
      : '';
    var footerRight = el('div', 'f12-plate-footer-right');
    footerRight.appendChild(el('span', 'f12-plate-meta', 'Ego network (' + (plateObj.nodes ? plateObj.nodes.length : 0) + ' of ' + compTotal + ' files in component)' + hiddenEdgesNote + ' \u00b7 Drag files to move'));
    if (focusPairBtn) footerRight.appendChild(focusPairBtn);
    footerRight.appendChild(resetPlateBtn);
    plateFooter.appendChild(footerRight);
    plateWrap.appendChild(plateFooter);
    cut01.appendChild(plateWrap);
    grid.appendChild(cut01);

    // Cut E-01: Evidence & Receipts (keeps id="cut-c05" for DOM selectors, displays E-01 · EVIDENCE)
    var cut05 = el('aside', 'f12-cut-panel f12-cut-c05');
    cut05.id = 'cut-c05';
    cut05.appendChild(el('span', 'f12-cut-label', 'E-01 \u00b7 EVIDENCE'));

    // Beat 02: What the history shows + Contextual '?' help buttons with visible labels
    var beat02 = el('div', 'f12-beat-row');
    beat02.appendChild(el('span', 'f12-beat-tag', '02 \u00b7 WHAT THE HISTORY SHOWS \u00b7 Historical co-change rate (not defect probability)'));
    var evHelpWrap = el('div', 'f12-kicker-left');
    evHelpWrap.appendChild(makeHelpBtn('help-directional-pct', 'Why do the two directional percentages differ?', '% asymmetry'));
    evHelpWrap.appendChild(makeHelpBtn('help-confidence-range', 'What does the 95% confidence range mean?', '95% range'));
    beat02.appendChild(evHelpWrap);
    cut05.appendChild(beat02);

    var evKicker = el('div', 'f12-kicker-row');
    evKicker.appendChild(el('span', 'f12-tag', 'DIRECTIONAL CO-CHANGE & RECEIPTS'));
    evKicker.appendChild(el('span', 'f12-last-date', 'Lead pair: ' + dynLabels[0] + ' \u2194 ' + dynLabels[1]));
    cut05.appendChild(evKicker);

    var dirGrid = el('div', 'f12-dir-grid');
    var asymmetryText = '';
    if (usePrebuiltLeadCopy && featuredPayload.evidence) {
      var evCopy = featuredPayload.evidence;
      var pd = evCopy.primaryDirection;
      var rd = evCopy.reverseDirection;
      var box1 = el('div', 'f12-dir-box');
      box1.setAttribute('data-edge-idx', String(activeEdge.idx));
      box1.appendChild(el('div', 'f12-dir-pair', pd.fromLabel + ' \u2192 ' + pd.toLabel));
      box1.appendChild(el('div', 'f12-dir-pct', pd.pctText));
      box1.appendChild(el('div', 'f12-dir-sub', pd.detailText + ' \u00b7 \u2265' + pd.rangeLowPct + '% lower bound'));
      dirGrid.appendChild(box1);

      var box2 = el('div', 'f12-dir-box');
      box2.appendChild(el('div', 'f12-dir-pair', rd.fromLabel + ' \u2192 ' + rd.toLabel));
      box2.appendChild(el('div', 'f12-dir-pct', rd.pctText));
      box2.appendChild(el('div', 'f12-dir-sub', rd.detailText + ' \u00b7 \u2265' + rd.rangeLowPct + '% lower bound'));
      dirGrid.appendChild(box2);
      asymmetryText = evCopy.asymmetrySummary || '';
    } else {
      var revDenom = forwardFirst ? activeEdge.d.toChanges : activeEdge.d.fromChanges;
      var revConfVal = forwardFirst ? activeEdge.d.reverseConfidence : activeEdge.d.confidence;
      var revRawRateStr = pct(revDenom > 0 ? activeEdge.d.shared / revDenom : 0);
      var revPct = isWeightedEdge ? (pct(revConfVal) + ' weighted') : pct(revConfVal);
      var revIv = forwardFirst ? activeEdge.d.reverseInterval : activeEdge.d.interval;
      var revLow = Math.floor(revIv.low * 100 + 1e-9);
      var revHigh = Math.ceil(revIv.high * 100 - 1e-9);

      var dBox1 = el('div', 'f12-dir-box');
      dBox1.setAttribute('data-edge-idx', String(activeEdge.idx));
      dBox1.appendChild(el('div', 'f12-dir-pair', dynLabels[0] + ' \u2192 ' + dynLabels[1]));
      dBox1.appendChild(el('div', 'f12-dir-pct', dynPct));
      var dSub1 = activeEdge.d.shared + ' of ' + dynDenom + ' commits' +
        (isWeightedEdge ? ' (' + rawRateStr + ' raw)' : '') +
        ' \u00b7 95% range ' + dynLow + '\u2013' + dynHigh + '% \u00b7 \u2265' + dynLow + '% lower bound';
      dBox1.appendChild(el('div', 'f12-dir-sub', dSub1));
      dirGrid.appendChild(dBox1);

      var dBox2 = el('div', 'f12-dir-box');
      dBox2.appendChild(el('div', 'f12-dir-pair', dynLabels[1] + ' \u2192 ' + dynLabels[0]));
      dBox2.appendChild(el('div', 'f12-dir-pct', revPct));
      var dSub2 = activeEdge.d.shared + ' of ' + revDenom + ' commits' +
        (isWeightedEdge ? ' (' + revRawRateStr + ' raw)' : '') +
        ' \u00b7 95% range ' + revLow + '\u2013' + revHigh + '% \u00b7 \u2265' + revLow + '% lower bound';
      dBox2.appendChild(el('div', 'f12-dir-sub', dSub2));
      dirGrid.appendChild(dBox2);
      if (dynDenom === revDenom) {
        asymmetryText = 'Both ' + dynLabels[0] + ' and ' + dynLabels[1] + ' changed ' + dynDenom + ' ' + (dynDenom === 1 ? 'time' : 'times') + ' in the analyzed history, and ' + activeEdge.d.shared + ' of those commits touched both files.';
      } else if (activeEdge.d.shared === dynDenom && dynDenom > 0) {
        asymmetryText = 'Every observed change to ' + dynLabels[0] + ' (' + activeEdge.d.shared + ' of ' + dynDenom + ') also changed ' + dynLabels[1] + ', whereas only ' + activeEdge.d.shared + ' of ' + revDenom + ' changes to ' + dynLabels[1] + ' involved ' + dynLabels[0] + '.';
      } else {
        asymmetryText = activeEdge.d.shared + ' of ' + dynDenom + ' changes to ' + dynLabels[0] + ' also changed ' + dynLabels[1] + ', compared with ' + activeEdge.d.shared + ' of ' + revDenom + ' changes to ' + dynLabels[1] + ' that involved ' + dynLabels[0] + '.';
      }
    }
    cut05.appendChild(dirGrid);
    if (asymmetryText) {
      cut05.appendChild(el('p', 'f12-dir-asymmetry', asymmetryText));
    }

    var readingGuideObj = (usePrebuiltLeadCopy && featuredPayload.evidence && featuredPayload.evidence.readingGuide)
      ? featuredPayload.evidence.readingGuide
      : buildClientReadingGuide(activeEdge, forwardFirst, dynLabels, activeFamilyEntry);
    cut05.appendChild(renderReadingFindingDisclosure(readingGuideObj, 'reading-this-finding'));

    var metaStrip = el('div', 'f12-meta-strip');
    metaStrip.appendChild(el('span', 'f12-meta-pill', 'Last together ' + lastDateStr));
    if (featuredPayload && featuredPayload.evidence) {
      var evMeta = featuredPayload.evidence;
      if (evMeta.familySummary) {
        metaStrip.appendChild(el('span', 'f12-meta-pill', evMeta.familySummary.commitsTouchingTwoOrMore + ' family commits (2+ files) \u00b7 ' + evMeta.familySummary.commitsTouchingAll + ' touched all ' + evMeta.familySummary.members.length));
      }
      if (evMeta.ownerNotes && evMeta.ownerNotes.length > 0) {
        metaStrip.appendChild(el('span', 'f12-meta-pill', evMeta.ownerNotes[0]));
      }
      if (evMeta.originShareNote) {
        metaStrip.appendChild(el('span', 'f12-meta-pill', evMeta.originShareNote));
      }
    } else {
      var leadN = forwardFirst ? activeEdge.s : activeEdge.t;
      if (leadN.author) {
        metaStrip.appendChild(el('span', 'f12-meta-pill', 'Top historical contributor: ' + leadN.author + ' (' + pct(leadN.share || 0) + ' of ' + dynLabels[0] + ' commits)'));
      }
    }
    cut05.appendChild(metaStrip);

    // Family pairs breakdown (when active finding is a family)
    if (featuredPayload && featuredPayload.evidence && featuredPayload.evidence.familySummary && featuredPayload.evidence.familySummary.pairs && featuredPayload.evidence.familySummary.pairs.length > 0) {
      var famSum = featuredPayload.evidence.familySummary;
      var visFamPairs = famSum.pairs.filter(function (fp) {
        var pe = edges[fp.edgeIndex] || edgeByPairKey[edgeKey(fp.fromPath, fp.toPath)];
        return !pe || Boolean(visible[pe.d.relationship]);
      });
      if (visFamPairs.length > 0) {
        var famBox = el('div', 'f12-family-pairs');
        famBox.appendChild(el('div', 'f12-family-pairs-hdr', 'QUALIFYING FAMILY PAIRS (' + visFamPairs.length + ' OF ' + famSum.possiblePairs + ')'));
        var famPairBtns = [];
        visFamPairs.forEach(function (fp, fpIdx) {
          var fpBtn = el('button', 'f12-family-pair-row');
          fpBtn.type = 'button';
          if (fpIdx >= 5) fpBtn.hidden = true;
          fpBtn.appendChild(el('span', '', fp.shortFrom + ' \u2194 ' + fp.shortTo));
          var fpLb = String(fp.lowerBoundText || '').replace(/\s*CI$/i, ' lower bound');
          fpBtn.appendChild(el('span', '', fp.shared + ' shared \u00b7 ' + fp.pctText + ' (' + fpLb + ')'));
          var matchingEdge = edges[fp.edgeIndex] || edgeByPairKey[edgeKey(fp.fromPath, fp.toPath)];
          if (matchingEdge) {
            fpBtn.setAttribute('data-edge-idx', String(matchingEdge.idx));
            fpBtn.addEventListener('click', function () {
              selectBriefingEdge(matchingEdge, false, true);
            });
          }
          famPairBtns.push(fpBtn);
          famBox.appendChild(fpBtn);
        });
        if (visFamPairs.length > 5) {
          var famToggleBtn = el('button', 'f12-family-pair-row', 'Show all ' + visFamPairs.length + ' qualifying pairs \u25be');
          famToggleBtn.type = 'button';
          var famPairsExpanded = false;
          famToggleBtn.addEventListener('click', function () {
            famPairsExpanded = !famPairsExpanded;
            for (var fpi = 5; fpi < famPairBtns.length; fpi++) {
              famPairBtns[fpi].hidden = !famPairsExpanded;
            }
            famToggleBtn.textContent = famPairsExpanded
              ? 'Show top 5 qualifying pairs \u25b4'
              : 'Show all ' + visFamPairs.length + ' qualifying pairs \u25be';
          });
          famBox.appendChild(famToggleBtn);
        }
        cut05.appendChild(famBox);
      }
    }

    // Counterexamples
    var cxData = activeEdge.d.counterexamples;
    if (usePrebuiltLeadCopy && featuredPayload.evidence) {
      var evCx = featuredPayload.evidence;
      var totalStandalone = (evCx.fromOnlyTotal || 0) + (evCx.toOnlyTotal || 0);
      if (totalStandalone > 0) {
        var cxDet = el('details', 'f12-counterexamples');
        cxDet.appendChild(el('summary', '', evCx.counterexamplesSummary + ' (' + evCx.primaryDirection.fromLabel + ') \u00b7 ' + evCx.reverseCounterexamplesSummary + ' (' + evCx.reverseDirection.fromLabel + ') \u2014 ' + plural(totalStandalone, 'counterexample commit')));
        var cxItems = (evCx.fromOnly || []).concat(evCx.toOnly || []).slice(0, 4);
        if (cxItems.length > 0) {
          var cxUl = el('ul', 'f12-cx-list');
          cxItems.forEach(function (item) {
            cxUl.appendChild(el('li', '', item.hash.slice(0, 7) + ' \u00b7 ' + item.date + ' \u00b7 ' + sanitizeText(item.subject)));
          });
          cxDet.appendChild(cxUl);
        }
        cut05.appendChild(cxDet);
      }
    } else {
      var fromStandalone = Math.max(0, dynDenom - activeEdge.d.shared);
      var revDenom2 = forwardFirst ? activeEdge.d.toChanges : activeEdge.d.fromChanges;
      var toStandalone = Math.max(0, revDenom2 - activeEdge.d.shared);
      var totalCx = fromStandalone + toStandalone;
      if (totalCx > 0) {
        var cxDet2 = el('details', 'f12-counterexamples');
        var fUnit = fromStandalone === 1 ? 'time' : 'times';
        var tUnit = toStandalone === 1 ? 'time' : 'times';
        cxDet2.appendChild(el('summary', '', 'Changed alone: ' + fromStandalone + ' ' + fUnit + ' (' + dynLabels[0] + ') \u00b7 Changed alone: ' + toStandalone + ' ' + tUnit + ' (' + dynLabels[1] + ') \u2014 ' + plural(totalCx, 'counterexample commit')));
        if (cxData) {
          var cxUl2 = el('ul', 'f12-cx-list');
          (cxData.fromOnly || []).concat(cxData.toOnly || []).slice(0, 4).forEach(function (item) {
            cxUl2.appendChild(el('li', '', item.hash.slice(0, 7) + ' \u00b7 ' + item.date + ' \u00b7 ' + sanitizeText(item.subject)));
          });
          cxDet2.appendChild(cxUl2);
        }
        cut05.appendChild(cxDet2);
      }
    }

    // Supporting Commit Receipts
    var rawReceipts = usePrebuiltLeadCopy && featuredPayload.evidence
      ? (featuredPayload.evidence.receiptsShown || [])
      : (activeEdge.d.evidence || []).slice(0, 3);
    var receiptsTotal = usePrebuiltLeadCopy && featuredPayload.evidence
      ? featuredPayload.evidence.receiptsTotal
      : activeEdge.d.shared;
    cut05.appendChild(el('div', 'f12-receipts-hdr', 'SUPPORTING COMMIT RECEIPTS (' + rawReceipts.length + ' OF ' + receiptsTotal + ')'));
    var rList = el('ul', 'f12-receipts-list');
    rawReceipts.forEach(function (r) {
      var li = el('li', 'f12-receipt-row');
      var shortH = r.hash ? r.hash.slice(0, 7) : '';
      var hBtn = el('button', 'f12-receipt-hash', shortH);
      hBtn.type = 'button';
      hBtn.title = 'Copy commit hash';
      hBtn.addEventListener('click', function () { copyText(r.hash || shortH, hBtn, 'Copied'); });
      li.appendChild(hBtn);
      li.appendChild(el('span', 'f12-receipt-subj', sanitizeText(r.subject)));
      li.appendChild(el('span', 'f12-receipt-date', r.date));
      rList.appendChild(li);
    });
    cut05.appendChild(rList);

    // Beat 03: What to do next + CLI explain command + Copy finding button
    var nextStepBox = el('div', 'f12-next-step');
    nextStepBox.appendChild(el('strong', '', '03 \u00b7 WHAT TO DO NEXT'));
    nextStepBox.appendChild(document.createTextNode('If you modify one of these files, inspect the companion file(s) and supporting commits above to decide whether a coordinated update is needed.'));
    cut05.appendChild(nextStepBox);

    var explainCmd = (usePrebuiltLeadCopy && featuredPayload.evidence)
      ? featuredPayload.evidence.explainCommand
      : (activeEdge.d.explainCommand || fallbackExplainCommand(activeEdge.s.path, activeEdge.t.path));
    var cliRow = el('div', 'f12-cli-row');
    cliRow.appendChild(el('code', 'f12-cli-code', sanitizeText(explainCmd)));
    var copyCli = el('button', 'f12-copy-btn', 'Copy CLI command');
    copyCli.type = 'button';
    copyCli.addEventListener('click', function () { copyText(explainCmd, copyCli, 'Copied'); });
    cliRow.appendChild(copyCli);
    cut05.appendChild(cliRow);

    var expBtn = el('button', 'btn-export', 'Copy finding for PR / discussion');
    expBtn.type = 'button';
    expBtn.addEventListener('click', function () {
      copyText(formatFindingMarkdown(activeEdge), expBtn, 'Copied finding to clipboard');
    });
    cut05.appendChild(expBtn);
    grid.appendChild(cut05);
    briefingEl.appendChild(grid);

    // 4. Secondary Investigation Cards (C-02, C-03, C-04) — filtered by visible relationship kinds
    if (briefingData.secondaryCards && briefingData.secondaryCards.length > 0) {
      var visibleSecondary = briefingData.secondaryCards.filter(function (sc) {
        return !sc.relationship || Boolean(visible[sc.relationship]);
      }).slice(0, 3);
      if (visibleSecondary.length > 0) {
        var secGrid = el('div', 'f12-secondary-grid');
        visibleSecondary.forEach(function (sc, sIdx) {
          var secEdge = edges[sc.edgeIndex];
          var isSel = !activeFamilyEntry && !isDefaultFeatured && activeEdge && activeEdge.idx === sc.edgeIndex;
          var card = el('button', 'f12-sec-card card interactive' + (isSel ? ' selected' : ''));
          card.type = 'button';
          card.setAttribute('data-edge-idx', String(sc.edgeIndex));
          card.appendChild(el('span', 'f12-cut-label', 'C-0' + (sIdx + 2)));
          var kRow = el('div', 'f12-kicker-row');
          kRow.appendChild(el('span', 'f12-tag', sc.findingId + ' \u00b7 ' + sc.badge));
          kRow.appendChild(el('span', 'f12-last-date', 'Last together ' + sc.lastTogether));
          card.appendChild(kRow);
          card.appendChild(el('div', 'f12-sec-pair', sc.pairLabel));
          card.appendChild(el('div', 'f12-sec-sub', sc.detailText));

          var ciRow = el('div', 'f12-ci-row');
          ciRow.appendChild(el('span', 'f12-ci-pct', sc.headlinePct));
          var track = el('div', 'f12-ci-track');
          var fill = el('div', 'f12-ci-fill');
          fill.style.left = sc.lowPct + '%';
          fill.style.width = Math.max(2, sc.highPct - sc.lowPct) + '%';
          track.appendChild(fill);
          var tick = el('div', 'f12-ci-tick');
          tick.style.left = 'calc(' + sc.pointPct + '% - 1px)';
          track.appendChild(tick);
          ciRow.appendChild(track);
          ciRow.appendChild(el('span', 'f12-ci-bounds', sc.lowPct + '\u2013' + sc.highPct + '%'));
          card.appendChild(ciRow);

          card.appendChild(el('div', 'f12-sec-rev', sc.reverseLine));
          if (sc.receiptHash) {
            card.appendChild(el('div', 'f12-sec-receipt', sc.receiptHash + ' \u00b7 ' + sc.receiptDate + ' \u00b7 ' + sc.receiptSubject));
          }
          card.addEventListener('click', function () {
            if (secEdge) selectBriefingEdge(secEdge, false, true);
          });
          secGrid.appendChild(card);
        });
        briefingEl.appendChild(secGrid);
      }
    }

    // 5. Full-width Ranked Findings Table (filtered by search & kind toggles)
    var rankedPanel = el('section', 'f12-ranked-panel');
    rankedPanel.id = 'cut-ranked';
    rankedPanel.appendChild(el('span', 'f12-cut-label', 'C-05 \u00b7 RANKED FINDINGS'));
    var rHdr = el('div', 'f12-ranked-hdr');
    var rLeft = el('div', 'f12-kicker-left');
    rLeft.appendChild(el('h3', 'f12-ranked-title', 'RANKED FINDINGS (' + filteredRanked.length + ')'));
    rLeft.appendChild(el('span', 'f12-tag', '45\u00b0 HALFTONE DOTS = 95% CONFIDENCE RANGE \u00b7 TICK = POINT ESTIMATE'));
    rHdr.appendChild(rLeft);
    rHdr.appendChild(el('span', 'f12-last-date', 'Ordered by overview priority & Wilson lower bound'));
    rankedPanel.appendChild(rHdr);

    var rListEl = el('div', 'f12-ranked-list');
    rListEl.id = 'ranked-findings-list';
    var shownRanked = briefingShowAllRanked ? filteredRanked : filteredRanked.slice(0, 10);
    shownRanked.forEach(function (item) {
      var isRowActive = (activeFamilyEntry && item.kind === 'family' && item.familyIndex === activeFamilyEntry.familyIndex) ||
        (!activeFamilyEntry && item.kind === 'pair' && activeEdge && item.edgeIndex === activeEdge.idx);
      var row = el('button', 'f12-rank-row' + (isRowActive ? ' active' : ''));
      row.type = 'button';
      row.setAttribute('data-finding-id', item.findingId);
      row.appendChild(el('span', 'f12-rank-id', item.findingId));
      row.appendChild(el('span', 'f12-rank-pair', item.title));
      var rBadge = item.kind === 'family'
        ? 'FAMILY'
        : (item.relationship === 'ghost' ? 'GHOST WIRE' : (item.relationship === 'unknown' ? 'UNCHECKED' : item.relationship.toUpperCase()));
      row.appendChild(el('span', 'f12-tag', rBadge));
      row.appendChild(el('span', 'f12-rank-ratio', item.ratioText));

      var track = el('div', 'f12-ci-track');
      var fill = el('div', 'f12-ci-fill');
      fill.style.left = item.rangeLowPct + '%';
      fill.style.width = Math.max(2, item.rangeHighPct - item.rangeLowPct) + '%';
      track.appendChild(fill);
      var tick = el('div', 'f12-ci-tick');
      tick.style.left = 'calc(' + item.pointPct + '% - 1px)';
      track.appendChild(tick);
      row.appendChild(track);

      row.appendChild(el('span', 'f12-ci-bounds', item.rangeLowPct + '\u2013' + item.rangeHighPct + '%'));
      row.appendChild(el('span', 'f12-last-date', item.lastTogether));
      row.addEventListener('click', function () {
        if (item.kind === 'family' && typeof item.familyIndex === 'number') {
          selectBriefingFamily(item.familyIndex, true);
          return;
        }
        var targetE = edges[item.edgeIndex] || (item.fromPath && item.toPath ? edgeByPairKey[edgeKey(item.fromPath, item.toPath)] : null);
        if (targetE) selectBriefingEdge(targetE, false, true);
      });
      rListEl.appendChild(row);
    });
    rankedPanel.appendChild(rListEl);

    if (filteredRanked.length > 10) {
      var moreCount = filteredRanked.length - 10;
      var toggleAllBtn = el(
        'button',
        'f12-toggle-all-btn',
        briefingShowAllRanked
          ? 'Show top 10 findings'
          : 'Show all ' + filteredRanked.length + ' findings (' + moreCount + ' more)'
      );
      toggleAllBtn.id = 'toggle-all-findings';
      toggleAllBtn.type = 'button';
      toggleAllBtn.setAttribute('aria-expanded', String(briefingShowAllRanked));
      toggleAllBtn.addEventListener('click', function () {
        briefingShowAllRanked = !briefingShowAllRanked;
        renderBriefingBoard();
        syncMarkerDom();
      });
      rankedPanel.appendChild(toggleAllBtn);
    }
    briefingEl.appendChild(rankedPanel);
    renderAboutAnalysisSection(briefingEl);

    // Restore keyboard focus across full DOM rebuilds when triggered from inside briefingEl
    if (prevFocusDesc) {
      var nextFocusEl = null;
      if (prevFocusDesc.kind === 'toggle-all') {
        nextFocusEl = document.getElementById('toggle-all-findings');
      } else if (prevFocusDesc.kind === 'rank-row') {
        nextFocusEl = briefingEl.querySelector('.f12-rank-row[data-finding-id="' + prevFocusDesc.findingId + '"]');
      } else if (prevFocusDesc.kind === 'sec-card') {
        nextFocusEl = briefingEl.querySelector('.f12-sec-card[data-edge-idx="' + prevFocusDesc.edgeIdx + '"]');
      } else if (prevFocusDesc.kind === 'family-pair') {
        nextFocusEl = briefingEl.querySelector('.f12-family-pair-row[data-edge-idx="' + prevFocusDesc.edgeIdx + '"]')
          || briefingEl.querySelector('.f12-rank-row.active');
      } else if (prevFocusDesc.kind === 'id') {
        nextFocusEl = document.getElementById(prevFocusDesc.id);
      }
      if (!nextFocusEl) {
        nextFocusEl = briefingEl.querySelector('.f12-rank-row.active') || document.getElementById('briefing-headline');
      }
      if (nextFocusEl && typeof nextFocusEl.focus === 'function') {
        try { nextFocusEl.focus({ preventScroll: true }); } catch (_) { nextFocusEl.focus(); }
      }
    }
  }

  if (window.location && window.location.hash) {
    var hashEdge = resolveEdgeFromHash(window.location.hash);
    if (hashEdge) {
      ensureRelationshipVisible(hashEdge.d.relationship);
      briefingSelectedEdgeIdx = hashEdge.idx;
      briefingSelectedFamilyIdx = -1;
      briefingUseDefaultFeatured = false;
      selectedEdge = hashEdge;
    }
  }
  window.addEventListener('hashchange', function () {
    var he = resolveEdgeFromHash(window.location.hash);
    if (he) {
      ensureRelationshipVisible(he.d.relationship);
      selectBriefingEdge(he, false, false);
    }
  });

  var lastBriefingMobile = Boolean(window.innerWidth && window.innerWidth <= 640);
  window.addEventListener('resize', function () {
    var nowMobile = Boolean(window.innerWidth && window.innerWidth <= 640);
    if (nowMobile !== lastBriefingMobile) {
      lastBriefingMobile = nowMobile;
      if (viewMode === 'briefing') {
        renderBriefingBoard();
        syncMarkerDom();
      }
    }
  });

  function renderPanel() {
    panel.textContent = '';
    if (selectedNode) {
      renderSelectedNode(selectedNode);
    } else if (selectedEdge) {
      renderSelectedEdge(selectedEdge);
    } else if (selectedFamily) {
      renderSelectedFamily(selectedFamily);
    } else {
      renderOverview();
    }
    renderBriefingBoard();
    syncMarkerDom();
  }

  // ---- media & print listeners ---------------------------------------------
  function bindMedia(mq, fn) {
    if (!mq) return;
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', fn);
    else if (typeof mq.addListener === 'function') mq.addListener(fn);
  }
  bindMedia(motionMedia, function (ev) {
    reduceMotion = Boolean(ev.matches);
    if (reduceMotion) {
      cancelMarchTimer();
      if (flight) {
        cam.x = flight.to.x; cam.y = flight.to.y; cam.scale = flight.to.scale;
        flight = null;
      }
    }
    requestDraw();
  });
  bindMedia(darkMedia, function () {
    invalidateThemeColors();
    if (colorByDir) renderPanel();
    requestDraw();
  });
  bindMedia(contrastMedia, function (ev) {
    highContrast = Boolean(ev.matches);
    invalidateThemeColors();
    requestDraw();
  });
  bindMedia(forcedColorsMedia, function (ev) {
    forcedColors = Boolean(ev.matches);
    invalidateThemeColors();
    requestDraw();
  });

  var prePrintThemeMode = null;
  window.addEventListener('beforeprint', function () {
    prePrintThemeMode = themeMode;
    applyThemeMode('light', false);
    draw();
    if (printImg) {
      try {
        printImg.src = canvas.toDataURL('image/png');
        printImg.hidden = false;
      } catch (_) {}
    }
  });
  window.addEventListener('afterprint', function () {
    if (prePrintThemeMode !== null) {
      applyThemeMode(prePrintThemeMode, false);
      prePrintThemeMode = null;
    }
    if (printImg) printImg.hidden = true;
    requestDraw();
  });

  var resizeTimer = null;
  function scheduleResize() {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      var rect = canvas.getBoundingClientRect();
      if (Math.round(rect.width) === Math.round(size.w) && Math.round(rect.height) === Math.round(size.h)) return;
      resizeNow();
    }, 50);
  }
  if (typeof ResizeObserver !== 'undefined') {
    var roInitialized = false;
    var ro = new ResizeObserver(function () {
      if (!roInitialized) { roInitialized = true; return; }
      scheduleResize();
    });
    ro.observe(canvas);
  } else {
    window.addEventListener('resize', scheduleResize);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) cancelMarchTimer();
    else requestDraw();
  });

  resizeNow();
  fitSheet();
  renderPanel();
  requestDraw();
})();
`;


