import type { ChangeReason, DeltaEntry, FileDelta, Surface, SurfaceExport } from './types.js';

const EMPTY: Surface = { status: 'known', module: 'none', exports: [], opaque: [] };

/**
 * Compares one file's surface at base and head. `base`/`head` are `undefined` when the
 * file does not exist on that side (added or deleted in the PR).
 * A removal plus an addition is never called a rename.
 */
export function surfaceDelta(file: string, base: Surface | undefined, head: Surface | undefined): FileDelta {
  const fileStatus = base === undefined ? 'added' : head === undefined ? 'deleted' : 'modified';
  const before = base ?? EMPTY;
  const after = head ?? EMPTY;
  const delta: FileDelta = { file, status: 'known', fileStatus, entries: [], opaqueAdded: [], opaqueRemoved: [] };
  for (const side of [before, after]) {
    if (side.status !== 'known') {
      delta.status = 'unknown';
      delta.reason = `${side === before ? 'base' : 'head'} surface ${side.status}${side.reason ? `: ${side.reason}` : ''}`;
      return delta;
    }
  }

  const baseByName = new Map(before.exports.map((e) => [e.name, e]));
  const headByName = new Map(after.exports.map((e) => [e.name, e]));
  const names = [...new Set([...baseByName.keys(), ...headByName.keys()])].sort();
  for (const name of names) {
    const b = baseByName.get(name);
    const h = headByName.get(name);
    if (b && !h) delta.entries.push({ name, change: 'removed', base: b });
    else if (!b && h) delta.entries.push({ name, change: 'added', head: h });
    else if (b && h) {
      const change = compareExport(b, h);
      if (change) delta.entries.push({ name, change: 'changed', ...change, base: b, head: h });
    }
  }

  const key = (o: { specifier: string; namespace?: string }) => `${o.specifier}\0${o.namespace ?? ''}`;
  const baseOpaque = new Set(before.opaque.map(key));
  const headOpaque = new Set(after.opaque.map(key));
  delta.opaqueAdded = after.opaque.filter((o) => !baseOpaque.has(key(o))).map((o) => o.specifier);
  delta.opaqueRemoved = before.opaque.filter((o) => !headOpaque.has(key(o))).map((o) => o.specifier);
  return delta;
}

function compareExport(base: SurfaceExport, head: SurfaceExport): Pick<DeltaEntry, 'reasons' | 'propsAdded' | 'propsRemoved'> | undefined {
  const reasons: ChangeReason[] = [];
  const out: Pick<DeltaEntry, 'reasons' | 'propsAdded' | 'propsRemoved'> = {};
  if (base.kind !== head.kind) reasons.push('kind-changed');
  if (base.params && head.params && head.params.required > base.params.required) reasons.push('required-params-increased');
  if (base.requiredProps && head.requiredProps) {
    const before = new Set(base.requiredProps);
    const after = new Set(head.requiredProps);
    const added = head.requiredProps.filter((p) => !before.has(p));
    const removed = base.requiredProps.filter((p) => !after.has(p));
    if (added.length > 0) {
      reasons.push('required-props-added');
      out.propsAdded = added;
    }
    if (removed.length > 0) {
      reasons.push('required-props-removed');
      out.propsRemoved = removed;
    }
  }
  if (reasons.length === 0) return undefined;
  out.reasons = reasons;
  return out;
}

/** Names whose delta gives consumers something to look at. */
export function affectedNames(delta: FileDelta): Map<string, 'removed' | 'changed'> {
  const out = new Map<string, 'removed' | 'changed'>();
  if (delta.status !== 'known') return out;
  for (const entry of delta.entries) if (entry.change !== 'added') out.set(entry.name, entry.change);
  return out;
}
