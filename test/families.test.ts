import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import vm from 'node:vm';
import { diff, printDiff, suggestMissing } from '../src/commands/diff.js';
import { attachMapPatches, buildMapData, printMap } from '../src/commands/map.js';
import { printScan, scan } from '../src/commands/scan.js';
import { loadContext } from '../src/context.js';
import { renderMapHtml } from '../src/map/template.js';
import { buildFindingFamilies } from '../src/model/families.js';
import { FixtureRepo } from './helpers.js';

const repos: FixtureRepo[] = [];
after(() => repos.forEach((r) => r.cleanup()));
function createRepo(): FixtureRepo {
  const r = new FixtureRepo();
  repos.push(r);
  return r;
}

class FakeElement {
  tagName: string;
  className = '';
  type = '';
  title = '';
  value = '';
  hidden = false;
  open = false;
  width = 800;
  height = 600;
  offsetWidth = 120;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  classList = {
    add: (cls: string) => {
      if (!this.className.split(/\s+/).includes(cls)) {
        this.className = this.className ? `${this.className} ${cls}` : cls;
      }
    },
    remove: (cls: string) => {
      this.className = this.className
        .split(/\s+/)
        .filter((c) => c !== cls)
        .join(' ');
    },
    toggle: () => {},
  };
  children: FakeElement[] = [];
  listeners: Record<string, Array<(ev?: unknown) => void>> = {};
  private _text = '';
  canvasOps: Array<{ op: string; args: unknown[] }> = [];

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join('\n');
  }
  set textContent(v: string) {
    this._text = String(v);
    this.children = [];
  }
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  remove(): void {}
  select(): void {}
  blur(): void {}
  focus(): void {}
  addEventListener(type: string, fn: (ev?: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  setAttribute(k: string, v: string): void {
    this.attributes[k] = v;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
  getContext() {
    const ops = this.canvasOps;
    return new Proxy(
      {},
      {
        get(_target, prop: string) {
          return (...args: unknown[]) => {
            ops.push({ op: prop, args });
            return { width: 10 };
          };
        },
        set(_target, prop: string, val: unknown) {
          ops.push({ op: `set:${prop}`, args: [val] });
          return true;
        },
      },
    );
  }
  findAll(pred: (el: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    if (pred(this)) out.push(this);
    for (const c of this.children) out.push(...c.findAll(pred));
    return out;
  }
}

function mountMapDom(html: string) {
  const dataMatch = html.match(/<script type="application\/json" id="ra-data">([\s\S]*?)<\/script>/);
  const scriptMatch = html.match(/<\/script>\s*<script>([\s\S]*?)<\/script>\s*<\/body>/);
  assert.ok(dataMatch && scriptMatch, 'Expected ra-data JSON and client script in map HTML');

  const elementsById: Record<string, FakeElement> = {
    'ra-data': new FakeElement('script'),
    map: new FakeElement('canvas'),
    tooltip: new FakeElement('div'),
    panel: new FakeElement('div'),
    search: new FakeElement('input'),
    'reset-view': new FakeElement('button'),
    'toggle-anim': new FakeElement('button'),
    summary: new FakeElement('div'),
    toggles: new FakeElement('div'),
  };
  elementsById['ra-data']!.textContent = dataMatch[1]!;

  let copiedClipboardText = '';
  const docListeners: Record<string, Array<(ev?: unknown) => void>> = {};
  const sandboxWindow: Record<string, unknown> = {
    devicePixelRatio: 1,
    isSecureContext: true,
    matchMedia: () => ({ matches: true }),
    addEventListener: () => {},
  };
  const sandboxDocument = {
    hidden: false,
    activeElement: null,
    body: new FakeElement('body'),
    getElementById: (id: string) => elementsById[id] ?? new FakeElement('div'),
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: (type: string, fn: (ev?: unknown) => void) => {
      (docListeners[type] ??= []).push(fn);
    },
    execCommand: () => true,
  };
  const sandboxNavigator = {
    clipboard: {
      writeText: (text: string) => {
        copiedClipboardText = text;
        return { then: (cb: () => void) => cb() };
      },
    },
  };

  vm.runInNewContext(scriptMatch[1]!, {
    window: sandboxWindow,
    document: sandboxDocument,
    navigator: sandboxNavigator,
    performance: { now: () => 0 },
    requestAnimationFrame: (cb: (now: number) => void) => {
      cb(16);
      return 1;
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
  });

  return {
    elementsById,
    docListeners,
    getCopiedText: () => copiedClipboardText,
  };
}

const ALL_KINDS = ['ghost', 'unknown', 'indirect', 'direct', 'test'] as const;
const scanOpts = { limit: 20, kinds: [...ALL_KINDS] };
const diffOpts = { limit: 5, kinds: [...ALL_KINDS] };
const mapOpts = { edges: 100, kinds: [...ALL_KINDS] };

describe('Stage 2 Feature 2: Finding Families', () => {
  it('1 & 2. detects 3-way and 4-way parallel implementation families across sibling directories', async () => {
    const r = createRepo();
    for (let i = 1; i <= 3; i++) {
      r.commit({
        message: `sync serve-static and stream v${i}`,
        write: {
          'src/adapter/bun/serve-static.ts': `export const bunStatic = ${i};\n`,
          'src/adapter/deno/serve-static.ts': `export const denoStatic = ${i};\n`,
          'src/adapter/cloudflare-workers/serve-static.ts': `export const cfStatic = ${i};\n`,
          'src/runtime/bun/stream.ts': `export const bunStream = ${i};\n`,
          'src/runtime/deno/stream.ts': `export const denoStream = ${i};\n`,
          'src/runtime/node/stream.ts': `export const nodeStream = ${i};\n`,
          'src/runtime/workerd/stream.ts': `export const workerdStream = ${i};\n`,
        },
      });
    }

    const ctx = await loadContext(r.dir, { minShared: 2, minConfidence: 0.5 });
    const result = scan(ctx, scanOpts);

    assert.equal(result.families.length, 2);
    const byId = new Map(result.families.map((f) => [f.id, f]));

    const serveStatic = byId.get('src/adapter/*/serve-static');
    assert.ok(serveStatic, 'Expected 3-way serve-static family');
    assert.equal(serveStatic.members.length, 3);
    assert.deepEqual(
      serveStatic.members.map((m) => m.path),
      [
        'src/adapter/bun/serve-static.ts',
        'src/adapter/cloudflare-workers/serve-static.ts',
        'src/adapter/deno/serve-static.ts',
      ],
    );
    assert.deepEqual(
      serveStatic.members.map((m) => m.variant),
      ['bun', 'cloudflare-workers', 'deno'],
    );
    assert.equal(serveStatic.qualifyingPairs, 3);
    assert.equal(serveStatic.possiblePairs, 3);
    assert.equal(serveStatic.complete, true);
    assert.equal(serveStatic.commitsTouchingTwoOrMore, 3);
    assert.equal(serveStatic.commitsTouchingAll, 3);
    assert.equal(serveStatic.relationships.length, 3);

    const streamFam = byId.get('src/runtime/*/stream');
    assert.ok(streamFam, 'Expected 4-way stream family');
    assert.equal(streamFam.members.length, 4);
    assert.equal(streamFam.qualifyingPairs, 6);
    assert.equal(streamFam.possiblePairs, 6);
    assert.equal(streamFam.complete, true);
    assert.equal(streamFam.commitsTouchingTwoOrMore, 3);
    assert.equal(streamFam.commitsTouchingAll, 3);
    assert.equal(streamFam.relationships.length, 6);
  });

  it('3. supports incomplete families (A-B and B-C qualify, A-C does not) without fabricating missing pairs', async () => {
    const r = createRepo();
    // A (bun) and B (deno) change together in 3 commits
    for (let i = 1; i <= 3; i++) {
      r.commit({
        message: `bun + deno websocket ${i}`,
        write: {
          'src/adapter/bun/websocket.ts': `export const bunWs = ${i};\n`,
          'src/adapter/deno/websocket.ts': `export const denoWs = ${i};\n`,
        },
      });
    }
    // B (deno) and C (cloudflare-workers) change together in 3 commits (A does not change here)
    for (let i = 1; i <= 3; i++) {
      r.commit({
        message: `deno + cf websocket ${i}`,
        write: {
          'src/adapter/deno/websocket.ts': `export const denoWs = ${10 + i};\n`,
          'src/adapter/cloudflare-workers/websocket.ts': `export const cfWs = ${i};\n`,
        },
      });
    }
    // 1 single commit touching A (bun) and C (cloudflare-workers) -> below minShared (2), so A-C does NOT qualify
    r.commit({
      message: 'isolated below-threshold bun + cf commit',
      write: {
        'src/adapter/bun/websocket.ts': 'export const bunWs = 999;\n',
        'src/adapter/cloudflare-workers/websocket.ts': 'export const cfWs = 999;\n',
      },
    });

    const ctx = await loadContext(r.dir, { minShared: 2, minConfidence: 0.4 });
    const result = scan(ctx, scanOpts);

    assert.equal(result.families.length, 1);
    const fam = result.families[0]!;
    assert.equal(fam.id, 'src/adapter/*/websocket');
    assert.equal(fam.members.length, 3);
    assert.equal(fam.qualifyingPairs, 2);
    assert.equal(fam.possiblePairs, 3);
    assert.equal(fam.complete, false);
    assert.equal(fam.relationships.length, 2);

    // Ensure A-C (bun <-> cloudflare-workers) was NOT fabricated
    const pairKeys = fam.relationships.map((rel) => [rel.from, rel.to].sort().join(' <-> '));
    assert.deepEqual(pairKeys.sort(), [
      'src/adapter/bun/websocket.ts <-> src/adapter/deno/websocket.ts',
      'src/adapter/cloudflare-workers/websocket.ts <-> src/adapter/deno/websocket.ts',
    ]);

    // Check family-wide commit counts: only the 6 commits touching a qualifying pair are counted (never the 1 A-C commit)
    assert.equal(fam.commitsTouchingTwoOrMore, 6);
    assert.equal(fam.commitsTouchingAll, 0);
    assert.equal(fam.allMemberEvidence.length, 0);
    assert.ok(fam.evidence.every((ev) => ev.subject !== 'isolated below-threshold bun + cf commit'));
  });

  it('4, 5 & 6. rejects same-name files in unrelated directories, project config files, high-churn hubs, and 2-file pairs', async () => {
    const r = createRepo();
    for (let i = 1; i <= 4; i++) {
      r.commit({
        message: `unrelated files, hub, configs, and 2-file pair ${i}`,
        write: {
          // High-churn hub files
          'package.json': `{"name":"test","version":"0.0.${i}"}\n`,
          'src/types.ts': `export type V = ${i};\n`,
          // Sibling project configuration files (must never form implementation families)
          'packages/alpha/package.json': `{"name":"alpha","version":"0.0.${i}"}\n`,
          'packages/beta/package.json': `{"name":"beta","version":"0.0.${i}"}\n`,
          'packages/gamma/package.json': `{"name":"gamma","version":"0.0.${i}"}\n`,
          'packages/delta/package.json': `{"name":"delta","version":"0.0.${i}"}\n`,
          'packages/alpha/tsconfig.json': `{"compilerOptions":{"strict":true},"include":["src-${i}"]}\n`,
          'packages/beta/tsconfig.json': `{"compilerOptions":{"strict":true},"include":["src-${i}"]}\n`,
          'packages/gamma/tsconfig.json': `{"compilerOptions":{"strict":true},"include":["src-${i}"]}\n`,
          'packages/alpha/vite.config.ts': `export default { define: { V: ${i} } };\n`,
          'packages/beta/vite.config.ts': `export default { define: { V: ${i} } };\n`,
          'packages/gamma/vite.config.ts': `export default { define: { V: ${i} } };\n`,
          'playground/alpha/vite.config-relative-base.js': `export default { base: "./${i}" };\n`,
          'playground/beta/vite.config-relative-base.js': `export default { base: "./${i}" };\n`,
          'playground/gamma/vite.config-relative-base.js': `export default { base: "./${i}" };\n`,
          // Same-name index.ts at different hierarchy depths
          'src/index.ts': `export const rootIdx = ${i};\n`,
          'src/router/index.ts': `export const routerIdx = ${i};\n`,
          'src/adapter/bun/index.ts': `export const bunIdx = ${i};\n`,
          // Same-name helper.ts under different parent trees (packages/* vs apps/* vs tools/*)
          'packages/alpha/src/helper.ts': `export const a = ${i};\n`,
          'apps/beta/lib/helper.ts': `export const b = ${i};\n`,
          'tools/gamma/bin/helper.ts': `export const c = ${i};\n`,
          // 2-file parallel pair (only 2 sibling directories)
          'src/adapter/bun/ssg.ts': `export const bunSsg = ${i};\n`,
          'src/adapter/deno/ssg.ts': `export const denoSsg = ${i};\n`,
        },
      });
    }

    const ctx = await loadContext(r.dir, { minShared: 2, minConfidence: 0.4 });
    const result = scan(ctx, { ...scanOpts, limit: 300 });

    // None of these should form a >=3-member Finding Family!
    assert.equal(result.families.length, 0);

    // Sibling project configuration files must never be classified as parallel-implementation
    const pkgConfigRel = result.relationships.find(
      (rel) =>
        (rel.from === 'packages/alpha/package.json' && rel.to === 'packages/beta/package.json') ||
        (rel.from === 'packages/beta/package.json' && rel.to === 'packages/alpha/package.json'),
    );
    assert.ok(pkgConfigRel, 'Expected sibling package.json pair in relationships');
    assert.equal(pkgConfigRel.why, 'involves project configuration, which code uses without importing');
    assert.equal(pkgConfigRel.hiddenBridge, undefined);

    const viteConfigRel = result.relationships.find(
      (rel) =>
        (rel.from === 'packages/alpha/vite.config.ts' && rel.to === 'packages/beta/vite.config.ts') ||
        (rel.from === 'packages/beta/vite.config.ts' && rel.to === 'packages/alpha/vite.config.ts'),
    );
    assert.ok(viteConfigRel, 'Expected sibling vite.config.ts pair in relationships');
    assert.notEqual(viteConfigRel.hiddenBridge?.signal, 'parallel-implementation');

    // Yet the 2-file parallel pair (bun/ssg.ts <-> deno/ssg.ts) is still preserved in relationships
    const ssgRel = result.relationships.find(
      (rel) =>
        (rel.from === 'src/adapter/bun/ssg.ts' && rel.to === 'src/adapter/deno/ssg.ts') ||
        (rel.from === 'src/adapter/deno/ssg.ts' && rel.to === 'src/adapter/bun/ssg.ts'),
    );
    assert.ok(ssgRel, 'Expected 2-file parallel pair to remain in scan relationships');
    assert.equal(ssgRel.hiddenBridge?.signal, 'parallel-implementation');
  });

  it('7. handles mixed relationship classifications inside a family and recomputes active-member stats when filtered in map', async () => {
    const r = createRepo();
    // 4-member family: bun, deno, and node are connected by ghost wires (all 3 pairs),
    // while cf is connected to bun via a direct import.
    // - 1 commit touches all 4 (bun, deno, node, cf)
    r.commit({
      message: 'etag all 4 members',
      write: {
        'src/adapter/bun/etag.ts': 'export const baseEtag = 1;\n',
        'src/adapter/deno/etag.ts': 'export const denoEtag = 1;\n',
        'src/adapter/node/etag.ts': 'export const nodeEtag = 1;\n',
        'src/adapter/cf/etag.ts': "import { baseEtag } from '../bun/etag.js';\nexport const cfEtag = baseEtag + 1;\n",
      },
    });
    // - 3 commits touch bun, deno, and node (ghost triangle)
    for (let i = 1; i <= 3; i++) {
      r.commit({
        message: `etag ghost trio ${i}`,
        write: {
          'src/adapter/bun/etag.ts': `export const baseEtag = ${10 + i};\n`,
          'src/adapter/deno/etag.ts': `export const denoEtag = ${10 + i};\n`,
          'src/adapter/node/etag.ts': `export const nodeEtag = ${10 + i};\n`,
        },
      });
    }
    // - 2 commits touch only bun and cf (direct import link)
    for (let i = 1; i <= 2; i++) {
      r.commit({
        message: `etag bun + cf direct ${i}`,
        write: {
          'src/adapter/bun/etag.ts': `export const baseEtag = ${20 + i};\n`,
          'src/adapter/cf/etag.ts': `import { baseEtag } from '../bun/etag.js';\nexport const cfEtag = baseEtag + ${20 + i};\n`,
        },
      });
    }

    const ctx = await loadContext(r.dir, { minShared: 2, minConfidence: 0.4 });
    const result = scan(ctx, scanOpts);
    assert.equal(result.families.length, 1);
    const fam = result.families[0]!;
    assert.deepEqual(fam.relationshipKinds, ['ghost', 'direct']);
    assert.equal(fam.members.length, 4);
    assert.equal(fam.qualifyingPairs, 4);
    assert.equal(fam.commitsTouchingTwoOrMore, 6);
    assert.equal(fam.commitsTouchingAll, 1);

    const mapData = buildMapData(ctx, mapOpts);
    const html = renderMapHtml(mapData);
    const { elementsById } = mountMapDom(html);

    // When both ghost and direct links are visible, the overview card shows all 4 members and 6 commits (1 touching all 4)
    let familyCards = elementsById.panel!.findAll((el) => el.className.includes('family-card'));
    assert.equal(familyCards.length, 1);
    assert.match(familyCards[0]!.textContent, /Related family · 4 files/);
    assert.match(familyCards[0]!.textContent, /6 commits \(2\+ files\) · 4 of 6 pairs/);
    assert.match(familyCards[0]!.textContent, /1 commit touched all 4/);

    // Now click the "Import links" toggle button in #toggles to hide `direct` links (`src/adapter/cf/etag.ts`)
    const toggleBtns = elementsById.toggles!.findAll((el) => el.className.includes('toggle'));
    const directToggle = toggleBtns.find((b) => b.textContent.includes('Import links'));
    assert.ok(directToggle, 'Expected Import links toggle button');
    directToggle.listeners.click?.[0]?.();

    // Overview card now reflects the 3 active members (bun, deno, node) and recomputes stats:
    // 4 commits touched 2+ of the 3 active members, and all 4 touched all 3 active members!
    familyCards = elementsById.panel!.findAll((el) => el.className.includes('family-card'));
    assert.equal(familyCards.length, 1);
    assert.match(familyCards[0]!.textContent, /Related family · 3 files/);
    assert.match(familyCards[0]!.textContent, /4 commits \(2\+ files\) · 3 of 3 pairs/);
    assert.match(familyCards[0]!.textContent, /4 commits touched all 3/);
    assert.doesNotMatch(familyCards[0]!.textContent, /touched all 4/);

    // Open the filtered family detail panel and verify stat cards + supporting commits exclude `cf/etag.ts`
    familyCards[0]!.listeners.click?.[0]?.();
    const detailText = elementsById.panel!.textContent;
    assert.match(detailText, /3 sibling files \(filtered from 4 family members\) · 3 of 3 qualifying pairs/);
    assert.match(detailText, /Commits touching all 3 family members together/);
    assert.doesNotMatch(detailText, /Commits touching all 4 family members together/);
    assert.doesNotMatch(detailText, /src\/adapter\/cf\/etag\.ts/);
  });

  it('8. calculates true unique family-level commit counts instead of summing pairwise shared counts', async () => {
    const r = createRepo();
    const fileA = 'src/adapter/bun/cors.ts';
    const fileB = 'src/adapter/deno/cors.ts';
    const fileC = 'src/adapter/node/cors.ts';

    // 2 commits touching all 3 members
    for (let i = 1; i <= 2; i++) {
      r.commit({
        message: `all three cors ${i}`,
        write: {
          [fileA]: `export const a = ${i};\n`,
          [fileB]: `export const b = ${i};\n`,
          [fileC]: `export const c = ${i};\n`,
        },
      });
    }
    // 2 commits touching only A and B
    for (let i = 1; i <= 2; i++) {
      r.commit({
        message: `only A and B ${i}`,
        write: {
          [fileA]: `export const a = ${10 + i};\n`,
          [fileB]: `export const b = ${10 + i};\n`,
        },
      });
    }
    // 2 commits touching only B and C
    for (let i = 1; i <= 2; i++) {
      r.commit({
        message: `only B and C ${i}`,
        write: {
          [fileB]: `export const b = ${20 + i};\n`,
          [fileC]: `export const c = ${20 + i};\n`,
        },
      });
    }
    // 2 commits touching only A and C
    for (let i = 1; i <= 2; i++) {
      r.commit({
        message: `only A and C ${i}`,
        write: {
          [fileA]: `export const a = ${30 + i};\n`,
          [fileC]: `export const c = ${30 + i};\n`,
        },
      });
    }

    const ctx = await loadContext(r.dir, { minShared: 2, minConfidence: 0.4 });
    const result = scan(ctx, scanOpts);
    assert.equal(result.families.length, 1);
    const fam = result.families[0]!;

    // Each of the 3 pairs has shared = 4, so summing pairwise shared counts would be 4 + 4 + 4 = 12.
    const pairwiseSum = fam.relationships.reduce((sum, rel) => sum + rel.shared, 0);
    assert.equal(pairwiseSum, 12);

    // True unique commits touching >=2 members is 2 + 2 + 2 + 2 = 8, and touching all 3 is 2.
    assert.equal(fam.commitsTouchingTwoOrMore, 8);
    assert.equal(fam.commitsTouchingAll, 2);
    assert.equal(fam.allMemberEvidence.length, 2);
    assert.ok(fam.allMemberEvidence.every((ev) => ev.touchesAllMembers && ev.membersTouched === 3 && ev.totalMembers === 3));

    // Recent evidence includes subset commits (2 of 3 members) and distinguishes them clearly
    const subsetEv = fam.evidence.find((ev) => !ev.touchesAllMembers);
    assert.ok(subsetEv, 'Expected subset commit in family evidence');
    assert.equal(subsetEv.membersTouched, 2);
    assert.equal(subsetEv.totalMembers, 3);
    assert.equal(subsetEv.memberPaths.length, 2);
  });

  it('9. handles renamed, deleted, and recreated files with separate historical lifetimes across scan and diff', async () => {
    const r = createRepo();
    const header =
      '// Cookie adapter implementation\nexport interface CookieOpts { path?: string; secure?: boolean; httpOnly?: boolean; }\nexport function serializeCookie(k: string, v: string): string { return `${k}=${v}`; }\n';

    // Lifetime 1 of deno/cookie.ts (later deleted and recreated) co-changes with bun/cookie.ts and legacy/cookie.ts
    for (let i = 1; i <= 3; i++) {
      r.commit({
        message: `old lifetime cookie ${i}`,
        write: {
          'src/adapter/bun/cookie.ts': `${header}export const bunCookie = ${i};\n`,
          'src/adapter/deno/cookie.ts': `${header}export const oldDenoCookie = ${i};\n`,
          'src/adapter/legacy/cookie.ts': `${header}export const legacyCookie = ${i};\n`,
          'src/adapter/obsolete/cookie.ts': `${header}export const obsoleteCookie = ${i};\n`,
        },
      });
    }

    // Delete deno/cookie.ts (ending lifetime 1) and delete obsolete/cookie.ts permanently
    r.commit({
      message: 'delete old deno cookie and obsolete cookie',
      write: {
        'src/adapter/deno/cookie.ts': null,
        'src/adapter/obsolete/cookie.ts': null,
      },
    });

    // Recreate deno/cookie.ts (lifetime 2) and rename legacy/cookie.ts -> node/cookie.ts
    r.commit({
      message: 'recreate deno cookie and rename legacy -> node',
      move: [['src/adapter/legacy/cookie.ts', 'src/adapter/node/cookie.ts']],
      write: {
        'src/adapter/bun/cookie.ts': `${header}export const bunCookie = 100;\n`,
        'src/adapter/deno/cookie.ts': `${header}export const freshDenoCookie = 100;\n`,
        'src/adapter/node/cookie.ts': `${header}export const legacyCookie = 100;\n`,
      },
    });

    for (let i = 1; i <= 2; i++) {
      r.commit({
        message: `new lifetime sync ${i}`,
        write: {
          'src/adapter/bun/cookie.ts': `${header}export const bunCookie = ${100 + i};\n`,
          'src/adapter/deno/cookie.ts': `${header}export const freshDenoCookie = ${100 + i};\n`,
          'src/adapter/node/cookie.ts': `${header}export const legacyCookie = ${100 + i};\n`,
        },
      });
    }

    const ctx = await loadContext(r.dir, { minShared: 2, minConfidence: 0.4 });
    const scanRes = scan(ctx, scanOpts);
    assert.equal(scanRes.families.length, 1);
    const fam = scanRes.families[0]!;

    // Deleted obsolete/cookie.ts must NOT be in the family
    assert.deepEqual(
      fam.members.map((m) => m.path),
      [
        'src/adapter/bun/cookie.ts',
        'src/adapter/deno/cookie.ts',
        'src/adapter/node/cookie.ts',
      ],
    );

    // Commits touching >=2 current members:
    // - In the 3 old-lifetime commits, bun/cookie.ts and legacy/cookie.ts (now node/cookie.ts) both changed (2 current members),
    //   while deno/cookie.ts was in its old deleted lifetime (so those 3 commits touched 2 current members, NOT all 3!).
    // - In the 3 new-lifetime commits, all 3 current members changed together.
    // Therefore: commitsTouchingTwoOrMore === 6, commitsTouchingAll === 3!
    assert.equal(fam.commitsTouchingTwoOrMore, 6);
    assert.equal(fam.commitsTouchingAll, 3);

    // Now test a working-tree rename in `diff`: rename node/cookie.ts -> workerd/cookie.ts and edit bun/cookie.ts
    mkdirSync(join(r.dir, 'src/adapter/workerd'), { recursive: true });
    r.git('mv', 'src/adapter/node/cookie.ts', 'src/adapter/workerd/cookie.ts');
    r.write('src/adapter/bun/cookie.ts', `${header}export const bunCookie = 999;\n`);

    const diffCtx = await loadContext(r.dir, { minShared: 2, minConfidence: 0.4 });
    const diffRes = await diff(diffCtx, diffOpts);
    assert.equal(diffRes.families?.length, 1);
    const diffFam = diffRes.families![0]!;
    assert.deepEqual(diffFam.changedMembers, ['src/adapter/bun/cookie.ts', 'src/adapter/workerd/cookie.ts']);
    assert.deepEqual(diffFam.suggestedMembers, ['src/adapter/deno/cookie.ts']);
    assert.equal(diffFam.commitsTouchingTwoOrMore, 6);
    assert.equal(diffFam.commitsTouchingAll, 3);
  });

  it('10 & 11. guarantees deterministic ordering under relationship permutations and respects filters/thresholds', async () => {
    const r = createRepo();
    for (let i = 1; i <= 4; i++) {
      r.commit({
        message: `sync adapters ${i}`,
        write: {
          'src/adapter/bun/jwt.ts': `export const bunJwt = ${i};\n`,
          'src/adapter/deno/jwt.ts': `export const denoJwt = ${i};\n`,
          'src/adapter/node/jwt.ts': `export const nodeJwt = ${i};\n`,
          'src/adapter/workerd/jwt.ts': `export const workerdJwt = ${i};\n`,
        },
      });
    }

    const ctx = await loadContext(r.dir, { minShared: 2, minConfidence: 0.4 });
    const baseScan = scan(ctx, scanOpts);
    assert.equal(baseScan.families.length, 1);

    // Permute/reverse the input relationships and verify identical output
    const reversedRels = [...baseScan.relationships].reverse();
    const shuffledRels = [
      baseScan.relationships[3]!,
      baseScan.relationships[0]!,
      baseScan.relationships[5]!,
      baseScan.relationships[1]!,
      baseScan.relationships[4]!,
      baseScan.relationships[2]!,
    ];
    const famFromReversed = buildFindingFamilies(ctx, reversedRels);
    const famFromShuffled = buildFindingFamilies(ctx, shuffledRels);
    assert.deepEqual(famFromReversed, baseScan.families);
    assert.deepEqual(famFromShuffled, baseScan.families);

    // Filtering out 2 of the 4 adapters via --ignore leaves only 2 files -> 0 families, 1 pairwise relationship
    const filteredCtx = await loadContext(r.dir, {
      minShared: 2,
      minConfidence: 0.4,
      ignore: ['src/adapter/node/**', 'src/adapter/workerd/**'],
    });
    const filteredScan = scan(filteredCtx, scanOpts);
    assert.equal(filteredScan.families.length, 0);
    assert.equal(filteredScan.relationships.length, 1);

    // Raising minShared above 4 filters out all pairs -> 0 families
    const highThresholdCtx = await loadContext(r.dir, { minShared: 5, minConfidence: 0.4 });
    assert.equal(scan(highThresholdCtx, scanOpts).families.length, 0);
  });

  it('12. integrates consistently across scan, diff, map, and their human-readable CLI printers', async () => {
    const r = createRepo();
    for (let i = 1; i <= 3; i++) {
      r.commit({
        message: `sync logger adapters ${i}`,
        write: {
          'src/adapter/bun/logger.ts': `export const bunLog = ${i};\n`,
          'src/adapter/deno/logger.ts': `export const denoLog = ${i};\n`,
          'src/adapter/node/logger.ts': `export const nodeLog = ${i};\n`,
        },
      });
    }

    const ctx = await loadContext(r.dir, { minShared: 2, minConfidence: 0.4 });
    const scanRes = scan(ctx, scanOpts);
    const mapData = buildMapData(ctx, mapOpts);
    const suggestRes = suggestMissing(
      ctx,
      [{ path: 'src/adapter/bun/logger.ts', deleted: false, sources: ['unstaged'] }],
      diffOpts,
    );

    assert.equal(scanRes.families.length, 1);
    assert.equal(mapData.families?.length, 1);
    assert.equal(suggestRes.families?.length, 1);

    // Individual pairwise relationships and suggestions remain intact
    assert.equal(scanRes.relationships.length, 3);
    assert.equal(mapData.edges.length, 3);
    assert.equal(suggestRes.suggestions.length, 2);

    // Verify human-readable CLI output for scan, diff, and map
    const chunks: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => chunks.push(args.join(' '));
    try {
      printScan(scanRes, scanOpts);
      printDiff({ meta: scanRes.meta, ...suggestRes });
      const cappedDiff = suggestMissing(
        ctx,
        [{ path: 'src/adapter/bun/logger.ts', deleted: false, sources: ['unstaged'] }],
        { ...diffOpts, limit: 1 },
      );
      printDiff({ meta: scanRes.meta, ...cappedDiff });
      printMap('/tmp/logger-map.html', mapData, false);
      printMap('/tmp/two-families-map.html', { ...mapData, families: [mapData.families![0]!, mapData.families![0]!] }, false);
    } finally {
      console.log = origLog;
    }
    const output = chunks.join('\n');
    assert.match(output, /Finding families \(1\)/);
    assert.match(output, /logger\.ts across src\/adapter\/\*/);
    assert.match(output, /all 3 pairwise links met thresholds/);
    assert.match(output, /3 supporting commits \(2\+ members via a qualifying pair\)/);
    assert.match(output, /\(beyond --limit\)/);
    assert.match(output, /1 finding family/);
    assert.match(output, /2 finding families/);
    assert.doesNotMatch(output, /familys/);
  });

  it('13 & 14. supports interactive family inspection, incomplete-triangle canvas accuracy, Evidence Explorer round-trip, and patch privacy', async () => {
    const r = createRepo();
    // Create an incomplete 3-way family: bun <-> deno (3 commits) and deno <-> cf (3 commits), no bun <-> cf
    for (let i = 1; i <= 3; i++) {
      r.commit({
        message: `bun + deno proxy ${i}`,
        write: {
          'src/adapter/bun/proxy.ts': `export const bunProxy = "SECRET_BUN_PATCH_${i}";\n`,
          'src/adapter/deno/proxy.ts': `export const denoProxy = "SECRET_DENO_PATCH_${i}";\n`,
        },
      });
    }
    for (let i = 1; i <= 3; i++) {
      r.commit({
        message: `deno + cf proxy ${i}`,
        write: {
          'src/adapter/deno/proxy.ts': `export const denoProxy = "SECRET_DENO_CF_${i}";\n`,
          'src/adapter/cf/proxy.ts': `export const cfProxy = "SECRET_CF_PATCH_${i}";\n`,
        },
      });
    }

    const ctx = await loadContext(r.dir, { minShared: 2, minConfidence: 0.4 });
    const defaultMapData = buildMapData(ctx, mapOpts);
    const defaultHtml = renderMapHtml(defaultMapData);

    // 14. Default map privacy check: no source-code patch hunks embedded by default
    assert.equal(defaultMapData.patchesIncluded, false);
    assert.doesNotMatch(defaultHtml, /SECRET_BUN_PATCH_/);
    assert.doesNotMatch(defaultHtml, /SECRET_CF_PATCH_/);

    // Mount the default map DOM and verify interactive family workflow
    const { elementsById, docListeners, getCopiedText } = mountMapDom(defaultHtml);

    // Overview replaces the individual parallel cards with 1 keyboard-accessible family button card
    const cards = elementsById.panel!.findAll((el) => el.className.includes('card interactive'));
    assert.equal(cards.length, 1, 'Expected 1 consolidated family card in overview');
    const famCard = cards[0]!;
    assert.equal(famCard.tagName, 'BUTTON');
    assert.equal(famCard.type, 'button');
    assert.ok(famCard.className.includes('family-card'));
    assert.match(famCard.textContent, /Related family · 3 files/);
    assert.match(famCard.textContent, /2 of 3 pairs/);

    // Clicking the family card opens the family detail view
    famCard.listeners.click?.[0]?.();
    const famPanelText = elementsById.panel!.textContent;
    assert.match(famPanelText, /Related implementation family/);
    assert.match(famPanelText, /Incomplete relationship graph: 2 of 3 possible pairs/);
    assert.match(famPanelText, /src\/adapter\/bun\/proxy\.ts/);
    assert.match(famPanelText, /src\/adapter\/cf\/proxy\.ts/);
    assert.match(famPanelText, /src\/adapter\/deno\/proxy\.ts/);

    // Verify that only 2 edges exist in data.edges and canvas draw() only strokes 2 edges (never fabricates the missing 3rd edge)
    assert.equal(defaultMapData.edges.length, 2, 'Incomplete triangle must have exactly 2 edges, never 3');
    let transformIdx = -1;
    elementsById.map!.canvasOps.forEach((op, idx) => {
      if (op.op === 'setTransform' && op.args[4] !== 0) transformIdx = idx;
    });
    const edgeStrokes = elementsById.map!.canvasOps
      .slice(transformIdx + 1)
      .filter((op) => op.op === 'lineTo');
    assert.equal(edgeStrokes.length, 2, 'Canvas draw() must only draw 2 lines for a 2-of-3 incomplete family');

    // Verify Copy finding for PR / discussion exports family Markdown
    const exportBtn = elementsById.panel!.findAll((el) => el.className.includes('btn-export'))[0];
    assert.ok(exportBtn, 'Expected export button on family detail view');
    exportBtn.listeners.click?.[0]?.();
    assert.match(getCopiedText(), /Repo Archaeology: Related Implementation Family/);
    assert.match(getCopiedText(), /2 of 3 possible pairs passed thresholds/);

    // Expand the second pairwise relationship (<details class="family-pair-details">) and click "Inspect paired diff & evidence →"
    const pairDetails = elementsById.panel!.findAll((el) => el.className.includes('family-pair-details'));
    assert.equal(pairDetails.length, 2);
    const secondPairInspectBtn = pairDetails[1]!.findAll((el) => el.className.includes('btn-inspect-pair'))[0];
    assert.ok(secondPairInspectBtn, 'Expected Inspect paired diff & evidence button on second pair');
    secondPairInspectBtn.listeners.click?.[0]?.();

    // Panel is now in Evidence Explorer (renderSelectedEdge) with a "← Back to family" button
    const edgePanelText = elementsById.panel!.textContent;
    assert.match(edgePanelText, /Connection worth checking/);
    assert.match(edgePanelText, /Inspect paired diffs locally/);
    const backToFamBtn = elementsById.panel!.findAll((el) => el.className.includes('back-to-family-btn'))[0];
    assert.ok(backToFamBtn, 'Expected Back to family button when viewing a pair from a family');
    assert.match(backToFamBtn.textContent, /← Back to family \(proxy\.ts across src\/adapter\/\*\)/);

    // Clicking "← Back to family" returns to the family view and keeps the second pair expanded!
    backToFamBtn.listeners.click?.[0]?.();
    assert.match(elementsById.panel!.textContent, /Related implementation family/);
    const pairDetailsAfterReturn = elementsById.panel!.findAll((el) => el.className.includes('family-pair-details'));
    assert.equal(pairDetailsAfterReturn[1]!.open, true, 'Expected second pair to remain expanded on return to family');

    // Also verify Escape key returns from pair view to family view, and a second Escape returns to overview
    const firstPairInspectBtn = pairDetailsAfterReturn[0]!.findAll((el) => el.className.includes('btn-inspect-pair'))[0]!;
    firstPairInspectBtn.listeners.click?.[0]?.();
    assert.match(elementsById.panel!.textContent, /Connection worth checking/);

    docListeners.keydown?.[0]?.({ key: 'Escape' });
    assert.match(elementsById.panel!.textContent, /Related implementation family/);

    docListeners.keydown?.[0]?.({ key: 'Escape' });
    assert.match(elementsById.panel!.textContent, /Explore file relationships/);

    // Now test with --include-patches enabled: bounded patch hunks are embedded and rendered in pair view
    const patchedMapData = buildMapData(ctx, mapOpts);
    await attachMapPatches(ctx, patchedMapData);
    assert.equal(patchedMapData.patchesIncluded, true);
    const patchedHtml = renderMapHtml(patchedMapData);
    assert.match(patchedHtml, /SECRET_BUN_PATCH_/);
  });

  it('15. safely escapes unusual characters in family paths, HTML output, and Markdown export', async () => {
    const r = createRepo();
    for (let i = 1; i <= 3; i++) {
      r.commit({
        message: `commit with </script> <b>bold</b> [x](javascript:alert(1)) & @user #123 ${i}`,
        write: {
          'src/adapter/a&b/widget.ts': `export const a = ${i};\n`,
          'src/adapter/c#123/widget.ts': `export const b = ${i};\n`,
          'src/adapter/d@user/widget.ts': `export const c = ${i};\n`,
        },
      });
    }

    const ctx = await loadContext(r.dir, { minShared: 2, minConfidence: 0.4 });
    const mapData = buildMapData(ctx, mapOpts);
    mapData.repoName = ' repo</script><script>alert(1)</script> ';
    const html = renderMapHtml(mapData);

    // Ensure no raw </script><script> injection in HTML
    assert.doesNotMatch(html, /<\/script><script>alert/);

    const { elementsById, getCopiedText } = mountMapDom(html);
    const famCard = elementsById.panel!.findAll((el) => el.className.includes('family-card'))[0];
    assert.ok(famCard);
    famCard.listeners.click?.[0]?.();

    const exportBtn = elementsById.panel!.findAll((el) => el.className.includes('btn-export'))[0]!;
    exportBtn.listeners.click?.[0]?.();
    const md = getCopiedText();
    // @user and #123 must be defused with zero-width space in Markdown export
    assert.ok(!md.includes('@user') || md.includes('@\u200Buser'));
    assert.ok(!md.includes('#123') || md.includes('#\u200B123'));
    // Raw HTML tags and markdown links in commit subjects must be backslash-escaped
    assert.ok(md.includes('\\<b\\>bold\\</b\\>'), 'Expected <b> tags to be escaped in Markdown export');
    assert.ok(md.includes('\\[x\\]\\(javascript:alert\\(1\\)\\)'), 'Expected markdown links to be escaped in Markdown export');
    assert.ok(md.includes('\\</script\\>'), 'Expected </script> to be escaped in Markdown export');
  });

  it('16. models multi-family adapter and router topologies (serve-static 3/3, websocket 2/3, router 4/10, and 2-file ssg pair)', async () => {
    const r = createRepo();
    // 1. serve-static.ts: 3-way complete triangle (bun, cloudflare-workers, deno)
    for (let i = 1; i <= 6; i++) {
      r.commit({
        message: `feat(adapter): update serve-static ${i}`,
        write: {
          'src/adapter/bun/serve-static.ts': `export const bunSS = ${i};\n`,
          'src/adapter/cloudflare-workers/serve-static.ts': `export const cfSS = ${i};\n`,
          'src/adapter/deno/serve-static.ts': `export const denoSS = ${i};\n`,
        },
      });
    }
    // 2. websocket.ts: 3-way incomplete triangle (bun <-> deno and cloudflare-workers <-> deno, no bun <-> cloudflare-workers)
    for (let i = 1; i <= 4; i++) {
      r.commit({
        message: `feat(ws): bun and deno ${i}`,
        write: {
          'src/adapter/bun/websocket.ts': `export const bunWS = ${i};\n`,
          'src/adapter/deno/websocket.ts': `export const denoWS = ${i};\n`,
        },
      });
    }
    for (let i = 1; i <= 4; i++) {
      r.commit({
        message: `feat(ws): cf and deno ${i}`,
        write: {
          'src/adapter/cloudflare-workers/websocket.ts': `export const cfWS = ${i};\n`,
          'src/adapter/deno/websocket.ts': `export const denoWS = ${10 + i};\n`,
        },
      });
    }
    // 3. router.ts: 5-way incomplete graph matching Hono's 4 of 10 qualifying pairs
    // (linear <-> reg-exp, linear <-> smart, linear <-> trie, linear <-> pattern)
    const routerSiblings = ['reg-exp-router', 'smart-router', 'trie-router', 'pattern-router'];
    for (const sib of routerSiblings) {
      for (let i = 1; i <= 3; i++) {
        r.commit({
          message: `feat(router): linear and ${sib} ${i}`,
          write: {
            'src/router/linear-router/router.ts': `export const lin = "${sib}-${i}";\n`,
            [`src/router/${sib}/router.ts`]: `export const r = ${i};\n`,
          },
        });
      }
    }
    // 4. ssg.ts: 2-file pair (bun <-> deno)
    for (let i = 1; i <= 4; i++) {
      r.commit({
        message: `feat(ssg): bun and deno ${i}`,
        write: {
          'src/adapter/bun/ssg.ts': `export const bunSSG = ${i};\n`,
          'src/adapter/deno/ssg.ts': `export const denoSSG = ${i};\n`,
        },
      });
    }

    const ctx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.4 });
    const scanRes = scan(ctx, scanOpts);
    assert.equal(scanRes.families.length, 3);
    assert.deepEqual(
      scanRes.families.map((f) => ({
        id: f.id,
        members: f.members.length,
        qualifyingPairs: f.qualifyingPairs,
        possiblePairs: f.possiblePairs,
        complete: f.complete,
      })),
      [
        {
          id: 'src/adapter/*/serve-static',
          members: 3,
          qualifyingPairs: 3,
          possiblePairs: 3,
          complete: true,
        },
        {
          id: 'src/adapter/*/websocket',
          members: 3,
          qualifyingPairs: 2,
          possiblePairs: 3,
          complete: false,
        },
        {
          id: 'src/router/*/router',
          members: 5,
          qualifyingPairs: 4,
          possiblePairs: 10,
          complete: false,
        },
      ],
    );
    const mapData = buildMapData(ctx, { edges: 100, kinds: scanOpts.kinds, uncheckedCap: undefined });
    assert.deepEqual(
      mapData.families?.map((f) => f.id),
      scanRes.families.map((f) => f.id),
    );
  });

  it('17. P1 regression: builds complete families even when uncheckedCap or map --edges truncates displayed pairwise edges', async () => {
    const r = createRepo();
    // Create 4 sibling Python drivers (6 'unknown' pairs) + 1 checked TS ghost pair so hasPrimary is true
    for (let i = 1; i <= 5; i++) {
      r.commit({
        message: `sync 4 python drivers ${i}`,
        write: {
          'drivers/postgres/client.py': `VERSION = ${i}\n`,
          'drivers/mysql/client.py': `VERSION = ${i}\n`,
          'drivers/sqlite/client.py': `VERSION = ${i}\n`,
          'drivers/duckdb/client.py': `VERSION = ${i}\n`,
        },
      });
    }
    for (let i = 1; i <= 6; i++) {
      r.commit({
        message: `sync ts ghost pair ${i}`,
        write: {
          'src/a/service.ts': `export const sA = ${i};\n`,
          'src/b/worker.ts': `export const wB = ${i};\n`,
        },
      });
    }

    const ctx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.4 });
    const uncappedScan = scan(ctx, { limit: 20, kinds: scanOpts.kinds });
    const cappedScan = scan(ctx, { limit: 20, kinds: scanOpts.kinds, uncheckedCap: 2 });

    // Even with uncheckedCap: 2 (which cuts displayed unknown relationships to 2),
    // the family itself must report all 4 members and all 6 of 6 qualifying pairs!
    assert.equal(cappedScan.relationships.filter((rel) => rel.relationship === 'unknown').length, 2);
    assert.equal(cappedScan.families.length, 1);
    assert.deepEqual(cappedScan.families[0], uncappedScan.families[0]);
    assert.equal(cappedScan.families[0]!.members.length, 4);
    assert.equal(cappedScan.families[0]!.qualifyingPairs, 6);
    assert.equal(cappedScan.families[0]!.possiblePairs, 6);
    assert.equal(cappedScan.families[0]!.complete, true);

    // Similarly, when buildMapData is called with edges: 3 (1 ghost + 2 unknown drawn out of 6 in the family),
    // the family still reports 4 members and 6 of 6 qualifying pairs (2 drawn + 4 undrawn).
    const cappedMapData = buildMapData(ctx, { edges: 3, kinds: scanOpts.kinds, uncheckedCap: 2 });
    assert.equal(cappedMapData.edges.length, 3);
    assert.equal(cappedMapData.families?.length, 1);
    const mapFam = cappedMapData.families![0]!;
    assert.equal(mapFam.members.length, 4);
    assert.equal(mapFam.qualifyingPairs, 6);
    assert.equal(mapFam.possiblePairs, 6);
    assert.equal(mapFam.complete, true);
    assert.equal(mapFam.edgeIndices.length, 2);
    assert.equal(mapFam.undrawnPairs?.length, 4);

    // Mount the map HTML, enable unknown links, select the family, and verify undrawn pairs are labelled "qualifies (not drawn)"
    const html = renderMapHtml(cappedMapData);
    const { elementsById } = mountMapDom(html);
    const unknownToggle = elementsById.toggles!.findAll((el) => el.className.includes('toggle')).find((b) => b.textContent.includes('Unchecked'));
    assert.ok(unknownToggle);
    unknownToggle.listeners.click?.[0]?.();

    const allTabBtn = elementsById.panel!.findAll((el) => el.className.includes('tab-btn')).find((b) => b.textContent.includes('All links'));
    allTabBtn?.listeners.click?.[0]?.();

    const famCard = elementsById.panel!.findAll((el) => el.className.includes('family-card'))[0];
    assert.ok(famCard, 'Expected family card even when only 2 of 6 pairs were drawn');
    assert.match(famCard.textContent, /Related family · 4 files/);
    assert.match(famCard.textContent, /6 of 6 pairs/);

    famCard.listeners.click?.[0]?.();
    const detailText = elementsById.panel!.textContent;
    assert.match(detailText, /Qualifying pairwise relationships \(6 of 6 possible\)/);
    assert.match(detailText, /qualifies \(not drawn\)/);
    assert.match(detailText, /Supporting commits \(2\+ members via a qualifying pair\)/);

    // P2 regression: when edges: 1 leaves the family with 0 drawn edges (all 6 pairs undrawn),
    // mounting the page and enabling all kinds still renders a reachable .family-card that opens to undrawn pairs!
    const zeroDrawnFamilyMap = buildMapData(ctx, { edges: 1, kinds: scanOpts.kinds });
    assert.equal(zeroDrawnFamilyMap.edges.length, 1);
    assert.equal(zeroDrawnFamilyMap.families?.length, 1);
    assert.equal(zeroDrawnFamilyMap.families![0]!.edgeIndices.length, 0);
    assert.equal(zeroDrawnFamilyMap.families![0]!.undrawnPairs?.length, 6);

    const zeroDrawnHtml = renderMapHtml(zeroDrawnFamilyMap);
    const { elementsById: zeroDrawnEls } = mountMapDom(zeroDrawnHtml);
    for (const btn of zeroDrawnEls.toggles!.findAll((el) => el.className.includes('toggle'))) {
      if (btn.attributes['aria-pressed'] === 'false') btn.listeners.click?.[0]?.();
    }
    const undrawnFamCard = zeroDrawnEls.panel!.findAll((el) => el.className.includes('family-card'))[0];
    assert.ok(undrawnFamCard, 'Expected reachable .family-card even when family has 0 drawn edges');
    undrawnFamCard.listeners.click?.[0]?.();
    const undrawnDetailText = zeroDrawnEls.panel!.textContent;
    assert.match(undrawnDetailText, /Qualifying pairwise relationships \(6 of 6 possible\)/);
    assert.match(undrawnDetailText, /qualifies \(not drawn\)/);
  });

  it('18. P2 regression: diff detects a family when two members are edited and one changed member qualifies only in the reverse direction', async () => {
    const r = createRepo();
    // All 3 sibling handlers p/{a,b,c}/h.ts change together in 4 commits
    for (let i = 1; i <= 4; i++) {
      r.commit({
        message: `all three handlers ${i}`,
        write: {
          'p/a/h.ts': `export const a = ${i};\n`,
          'p/b/h.ts': `export const b = ${i};\n`,
          'p/c/h.ts': `export const c = ${i};\n`,
        },
      });
    }
    // p/a/h.ts also changes on its own in 8 solo commits:
    // - conf(a -> c) = 4 / 12 = 0.333 (< 0.5, so a does NOT suggest c in forward direction)
    // - conf(c -> a) = 4 / 4 = 1.0 (>= 0.5, so (a, c) DOES qualify in reverse direction!)
    // - conf(b -> c) = 4 / 4 = 1.0 (>= 0.5, so b DOES suggest c!)
    // - conf(b -> a) = 4 / 4 = 1.0 (>= 0.5, so (a, b) DOES qualify!)
    for (let i = 1; i <= 8; i++) {
      r.commit({
        message: `solo a ${i}`,
        write: {
          'p/a/h.ts': `export const a = ${100 + i};\n`,
        },
      });
    }

    const ctx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.5 });
    const scanRes = scan(ctx, scanOpts);
    assert.equal(scanRes.families.length, 1);
    assert.equal(scanRes.families[0]!.qualifyingPairs, 3);
    assert.equal(scanRes.families[0]!.possiblePairs, 3);
    assert.equal(scanRes.families[0]!.complete, true);

    // Edit both `p/a/h.ts` and `p/b/h.ts`: `diff` suggests `p/c/h.ts` AND must surface the 3-member family!
    const diffRes = suggestMissing(
      ctx,
      [
        { path: 'p/a/h.ts', deleted: false, sources: ['unstaged'] },
        { path: 'p/b/h.ts', deleted: false, sources: ['unstaged'] },
      ],
      diffOpts,
    );
    assert.equal(diffRes.suggestions.length, 1);
    assert.equal(diffRes.suggestions[0]!.to, 'p/c/h.ts');
    assert.equal(diffRes.families.length, 1, 'Expected diff to report the 3-member family when 2 of 3 members are edited');
    assert.equal(diffRes.families[0]!.id, 'p/*/h');
    assert.deepEqual(diffRes.families[0]!.changedMembers, ['p/a/h.ts', 'p/b/h.ts']);
    assert.deepEqual(diffRes.families[0]!.suggestedMembers, ['p/c/h.ts']);
    assert.equal(diffRes.families[0]!.qualifyingPairs, 3);
    assert.equal(diffRes.families[0]!.possiblePairs, 3);
    assert.equal(diffRes.families[0]!.complete, true);
  });
});
