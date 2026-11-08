import { posix } from 'node:path';
import { globToRegExp } from '../util/glob.js';
import type { RepoFiles } from './tree-files.js';

/**
 * Strips a trailing YAML `# ...` comment when `#` is outside single or double quotes
 * and is at column 0 or preceded by whitespace.
 */
function stripYamlComment(line: string): { content: string; unclosedQuote: boolean } {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inSingle) {
      if (ch === "'") {
        if (line[i + 1] === "'") {
          i++; // escaped '' inside single-quoted YAML scalar
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        i++; // escaped character inside double-quoted YAML scalar
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '#') {
      const prev = i === 0 ? ' ' : line[i - 1]!;
      if (prev === ' ' || prev === '\t') {
        return { content: line.slice(0, i).trimEnd(), unclosedQuote: false };
      }
    }
  }

  return { content: line.trimEnd(), unclosedQuote: inSingle || inDouble };
}

/**
 * Unquotes a single- or double-quoted YAML scalar (after comments have already been stripped).
 */
function unquoteYamlScalar(raw: string): { value: string; valid: boolean } {
  const trimmed = raw.trim();
  if (trimmed === '') return { value: '', valid: true };
  if (trimmed.startsWith("'")) {
    if (trimmed.length < 2 || !trimmed.endsWith("'")) {
      return { value: '', valid: false };
    }
    return { value: trimmed.slice(1, -1).replace(/''/g, "'"), valid: true };
  }
  if (trimmed.startsWith('"')) {
    if (trimmed.length < 2 || !trimmed.endsWith('"')) {
      return { value: '', valid: false };
    }
    const inner = trimmed.slice(1, -1).replace(/\\(["\\/bfnrt])/g, '$1');
    return { value: inner, valid: true };
  }
  // Unquoted scalar must not contain unmatched quotes or flow brackets
  if (trimmed.includes('[') || trimmed.includes(']')) {
    return { value: '', valid: false };
  }
  return { value: trimmed, valid: true };
}

/**
 * Splits the interior of a YAML flow sequence `a, "b,c", 'd'` on commas outside quotes.
 */
function parseFlowSequenceItems(inner: string): { items: string[]; valid: boolean } {
  const items: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (inSingle) {
      current += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") {
          current += "'";
          i++;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '\\' && i + 1 < inner.length) {
        current += inner[i + 1]!;
        i++;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
    } else if (ch === '"') {
      inDouble = true;
      current += ch;
    } else if (ch === ',') {
      const token = current.trim();
      if (token === '') {
        current = '';
        continue;
      }
      const unquoted = unquoteYamlScalar(token);
      if (!unquoted.valid || !unquoted.value) return { items: [], valid: false };
      items.push(unquoted.value);
      current = '';
    } else {
      current += ch;
    }
  }

  if (inSingle || inDouble) {
    return { items: [], valid: false };
  }

  const tail = current.trim();
  if (tail !== '') {
    const unquoted = unquoteYamlScalar(tail);
    if (!unquoted.valid || !unquoted.value) return { items: [], valid: false };
    items.push(unquoted.value);
  }

  return { items, valid: true };
}

/**
 * Finds the index of the closing `]` outside quotes in `buffer` starting after the opening `[`.
 */
function findFlowSequenceEnd(buffer: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i]!;
    if (inSingle) {
      if (ch === "'") {
        if (buffer[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === ']') return i;
  }
  return -1;
}

/**
 * Parses `pnpm-workspace.yaml` without external dependencies.
 * Supports:
 * - Leading/trailing `---` and `...` YAML document markers
 * - Quoted and unquoted `packages:` list items with trailing `#` comments (`- "packages/*" # libs`)
 * - Indented and indent-0 `- item` block sequence entries under `packages:`
 * - Single-line and multi-line flow sequences (`packages: [\n  "packages/*",\n  "apps/*"\n]`)
 * - `catalog:` and `catalogs:` dependency keys
 */
export function parsePnpmWorkspaceYaml(text: string): {
  packages: string[];
  catalogDeps: string[];
  malformed: boolean;
} {
  const packages: string[] = [];
  const catalogDeps: string[] = [];
  const cleanText = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const lines = cleanText.split(/\r?\n/);

  let section: 'none' | 'packages' | 'catalog' | 'catalogs' | 'other' = 'none';
  let sawPackagesKey = false;
  let malformed = false;
  let flowBuffer: string | undefined;

  const consumeFlowChunk = (chunk: string): void => {
    flowBuffer = flowBuffer === undefined ? chunk : `${flowBuffer}\n${chunk}`;
    const closeIdx = findFlowSequenceEnd(flowBuffer);
    if (closeIdx !== -1) {
      const inner = flowBuffer.slice(0, closeIdx);
      const after = flowBuffer.slice(closeIdx + 1).trim();
      flowBuffer = undefined;
      if (after !== '') {
        malformed = true;
        return;
      }
      const parsed = parseFlowSequenceItems(inner);
      if (!parsed.valid) {
        malformed = true;
        return;
      }
      packages.push(...parsed.items);
      section = 'none';
    }
  };

  for (const rawLine of lines) {
    if (rawLine.startsWith('\t')) {
      malformed = true;
      continue;
    }

    const { content, unclosedQuote } = stripYamlComment(rawLine);
    if (unclosedQuote) {
      malformed = true;
      continue;
    }
    const trimmed = content.trim();
    if (trimmed === '') continue;

    // Inside a multi-line `packages: [ ... ]` flow sequence
    if (flowBuffer !== undefined) {
      consumeFlowChunk(trimmed);
      continue;
    }

    const indent = content.match(/^(\s*)/)?.[1]?.length ?? 0;

    // Document markers (`---` or `...`) at column 0
    if (indent === 0 && (trimmed === '---' || trimmed === '...')) {
      section = 'none';
      continue;
    }

    // Indent-0 sequence item `- ...` immediately under `packages:` is valid YAML
    if (indent === 0 && section === 'packages' && (trimmed === '-' || trimmed.startsWith('- ') || trimmed.startsWith("-'") || trimmed.startsWith('-"'))) {
      const scalarRaw = trimmed.slice(1).trim();
      const unquoted = unquoteYamlScalar(scalarRaw);
      if (!unquoted.valid || !unquoted.value) {
        malformed = true;
      } else {
        packages.push(unquoted.value);
      }
      continue;
    }

    if (indent === 0) {
      const topMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed);
      if (!topMatch) {
        malformed = true;
        continue;
      }
      const key = topMatch[1] ?? '';
      const rest = (topMatch[2] ?? '').trim();
      if (key === 'packages') {
        sawPackagesKey = true;
        section = 'packages';
        if (rest !== '') {
          if (rest.startsWith('[')) {
            consumeFlowChunk(rest.slice(1));
          } else {
            malformed = true;
          }
        }
      } else if (key === 'catalog') {
        section = 'catalog';
      } else if (key === 'catalogs') {
        section = 'catalogs';
      } else {
        section = 'other';
      }
      continue;
    }

    if (section === 'packages') {
      if (trimmed.startsWith('[') && packages.length === 0) {
        consumeFlowChunk(trimmed.slice(1));
      } else if (trimmed === '-' || trimmed.startsWith('-')) {
        const scalarRaw = trimmed.slice(1).trim();
        const unquoted = unquoteYamlScalar(scalarRaw);
        if (!unquoted.valid || !unquoted.value) {
          malformed = true;
        } else {
          packages.push(unquoted.value);
        }
      } else {
        malformed = true;
      }
    } else if (section === 'catalog' || section === 'catalogs') {
      const depMatch = /^(['"]?[@A-Za-z0-9._/-]+['"]?)\s*:/.exec(trimmed);
      if (depMatch?.[1]) {
        const unquoted = unquoteYamlScalar(depMatch[1]);
        if (unquoted.valid && unquoted.value && indent >= 2) {
          catalogDeps.push(unquoted.value);
        }
      }
    }
  }

  if (flowBuffer !== undefined) {
    malformed = true;
  }

  if (!sawPackagesKey && cleanText.trim() !== '') {
    malformed = true;
  }

  return { packages, catalogDeps, malformed };
}

/**
 * Matches workspace directory globs anchored at the repository root, applying `!` negations
 * after all positive globs.
 *
 * Unlike `.gitignore`, npm/pnpm/lerna workspace globs without a `/` (such as `"tools"`)
 * are anchored at the repository root and must NOT match nested paths like `"a/b/tools"`.
 */
export function matchWorkspaceDirectories(globs: readonly string[], candidateDirs: readonly string[]): Set<string> {
  const included = new Set<string>();
  const positiveGlobs: string[] = [];
  const negativeGlobs: string[] = [];

  for (const raw of globs) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const isNegated = trimmed.startsWith('!');
    const clean = (isNegated ? trimmed.slice(1) : trimmed)
      .trim()
      .replace(/^\.\//, '')
      .replace(/^\/+/, '')
      .replace(/\/package\.json$/, '')
      .replace(/\/+$/, '');
    if (!clean) continue;
    if (isNegated) negativeGlobs.push(clean);
    else positiveGlobs.push(clean);
  }

  for (const pattern of positiveGlobs) {
    // Prefix with `/` so `globToRegExp` anchors slashless patterns (`"tools"`) at repo root
    const regex = globToRegExp(`/${pattern}`);
    for (const dir of candidateDirs) {
      if (!dir) continue;
      if (regex.test(dir)) {
        included.add(dir);
      }
    }
  }

  for (const pattern of negativeGlobs) {
    const regex = globToRegExp(`/${pattern}`);
    const trimmedWildcard = pattern.endsWith('/**') ? pattern.slice(0, -3) : undefined;
    const trimmedRegex = trimmedWildcard ? globToRegExp(`/${trimmedWildcard}`) : undefined;
    for (const dir of [...included]) {
      if (
        regex.test(dir) ||
        dir === pattern ||
        dir.startsWith(`${pattern}/`) ||
        (trimmedRegex !== undefined && trimmedRegex.test(dir))
      ) {
        included.delete(dir);
      }
    }
  }

  return included;
}

export function extractPackageJsonWorkspaces(workspaces: unknown): string[] | undefined {
  if (Array.isArray(workspaces)) {
    if (workspaces.every((item) => typeof item === 'string')) {
      return workspaces as string[];
    }
    return undefined;
  }
  if (workspaces && typeof workspaces === 'object') {
    const pkgs = (workspaces as Record<string, unknown>).packages;
    if (Array.isArray(pkgs) && pkgs.every((item) => typeof item === 'string')) {
      return pkgs as string[];
    }
  }
  return undefined;
}

export interface DiscoveredWorkspaces {
  allPackageJsonFiles: string[];
  anyManifest: boolean;
  hasExplicitWorkspaceManifest: boolean;
  workspaceConfigError: boolean;
  activeWorkspaceDirs: Set<string>;
  conflictingDirs: Set<string>;
  catalogDeps: string[];
  rootPackageEntry?: { dir: ''; json?: Record<string, unknown>; malformed?: boolean };
}

export function discoverWorkspaces(files: RepoFiles): DiscoveredWorkspaces {
  const allPackageJsonFiles: string[] = [];
  let hasPnpmWorkspace = false;
  let hasLernaJson = false;
  let anyManifest = false;
  let hasExplicitWorkspaceManifest = false;
  let workspaceConfigError = false;
  const catalogDeps: string[] = [];
  let rootPackageEntry: { dir: ''; json?: Record<string, unknown>; malformed?: boolean } | undefined;

  for (const file of files.list()) {
    if (file.includes('node_modules/') || file.startsWith('.git/')) continue;
    if (file === 'package.json' || file.endsWith('/package.json')) {
      allPackageJsonFiles.push(file);
      anyManifest = true;
    } else if (file === 'pnpm-workspace.yaml') {
      hasPnpmWorkspace = true;
      anyManifest = true;
      hasExplicitWorkspaceManifest = true;
    } else if (file === 'lerna.json') {
      hasLernaJson = true;
      anyManifest = true;
      hasExplicitWorkspaceManifest = true;
    }
  }

  const candidateDirs = allPackageJsonFiles
    .map((f) => (posix.dirname(f) === '.' ? '' : posix.dirname(f)))
    .filter((d) => d !== '');

  const manifestSources: { name: string; globs: string[]; matched: Set<string> }[] = [];

  // 1. Parse root `package.json` if present
  if (files.exists('package.json')) {
    const raw = files.read('package.json');
    try {
      const json = JSON.parse(raw ?? '') as Record<string, unknown>;
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        workspaceConfigError = true;
        rootPackageEntry = { dir: '', malformed: true };
      } else {
        rootPackageEntry = { dir: '', json };
        if ('workspaces' in json && json.workspaces !== undefined) {
          hasExplicitWorkspaceManifest = true;
          const wsGlobs = extractPackageJsonWorkspaces(json.workspaces);
          if (wsGlobs === undefined) {
            workspaceConfigError = true;
          } else {
            manifestSources.push({
              name: 'package.json',
              globs: wsGlobs,
              matched: matchWorkspaceDirectories(wsGlobs, candidateDirs),
            });
          }
        }
      }
    } catch {
      workspaceConfigError = true;
      rootPackageEntry = { dir: '', malformed: true };
    }
  }

  // 2. Parse `pnpm-workspace.yaml` if present
  if (hasPnpmWorkspace) {
    const raw = files.read('pnpm-workspace.yaml') ?? '';
    const parsed = parsePnpmWorkspaceYaml(raw);
    for (const dep of parsed.catalogDeps) {
      catalogDeps.push(dep);
    }
    if (parsed.malformed) {
      workspaceConfigError = true;
    } else {
      manifestSources.push({
        name: 'pnpm-workspace.yaml',
        globs: parsed.packages,
        matched: matchWorkspaceDirectories(parsed.packages, candidateDirs),
      });
    }
  }

  // 3. Parse `lerna.json` if present
  if (hasLernaJson) {
    const raw = files.read('lerna.json') ?? '';
    try {
      const json = JSON.parse(raw) as Record<string, unknown>;
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        workspaceConfigError = true;
      } else if ('packages' in json && json.packages !== undefined) {
        if (Array.isArray(json.packages) && json.packages.every((p) => typeof p === 'string')) {
          const globs = json.packages as string[];
          manifestSources.push({
            name: 'lerna.json',
            globs,
            matched: matchWorkspaceDirectories(globs, candidateDirs),
          });
        } else {
          workspaceConfigError = true;
        }
      } else {
        // Default lerna packages glob when omitted is `["packages/*"]` if `useWorkspaces` is not true
        if (!json.useWorkspaces) {
          const globs = ['packages/*'];
          manifestSources.push({
            name: 'lerna.json',
            globs,
            matched: matchWorkspaceDirectories(globs, candidateDirs),
          });
        }
      }
    } catch {
      workspaceConfigError = true;
    }
  }

  // 4. Reconcile workspace manifests and detect conflicting workspace declarations
  let activeWorkspaceDirs = new Set<string>();
  const conflictingDirs = new Set<string>();

  if (manifestSources.length === 1) {
    activeWorkspaceDirs = manifestSources[0]!.matched;
  } else if (manifestSources.length > 1) {
    activeWorkspaceDirs = new Set(manifestSources[0]!.matched);
    const firstSet = manifestSources[0]!.matched;
    for (let i = 1; i < manifestSources.length; i++) {
      const otherSet = manifestSources[i]!.matched;
      for (const d of firstSet) {
        if (!otherSet.has(d)) conflictingDirs.add(d);
      }
      for (const d of otherSet) {
        if (!firstSet.has(d)) conflictingDirs.add(d);
      }
    }
    if (conflictingDirs.size > 0) {
      workspaceConfigError = true;
    }
  }

  return {
    allPackageJsonFiles,
    anyManifest,
    hasExplicitWorkspaceManifest,
    workspaceConfigError,
    activeWorkspaceDirs,
    conflictingDirs,
    catalogDeps,
    rootPackageEntry,
  };
}
