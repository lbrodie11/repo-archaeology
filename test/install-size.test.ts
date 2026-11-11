/**
 * RA-21 · `scripts/install-size.mjs` reports the install-size delta of a dependency change.
 * The full run packs and installs both versions (it needs the registry); this checks the
 * measuring helpers offline, on a fake `node_modules`.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { installedPackages, measureTree } from '../scripts/install-size.mjs';

describe('RA-21 · install-size script helpers', () => {
  it('lists top-level, scoped and nested packages and measures the tree', () => {
    const nm = mkdtempSync(join(tmpdir(), 'ra21-size-'));
    try {
      const pkg = (dir: string, name: string, version: string, extra = '') => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
        if (extra) writeFileSync(join(dir, 'index.js'), extra);
      };
      pkg(join(nm, 'commander'), 'commander', '13.1.0', 'x'.repeat(100));
      pkg(join(nm, '@frame12', 'terminal'), '@frame12/terminal', '0.1.0', 'y'.repeat(50));
      pkg(join(nm, '@frame12', 'terminal', 'node_modules', '@frame12', 'tokens'), '@frame12/tokens', '0.2.0');
      mkdirSync(join(nm, '.bin'));
      assert.deepEqual(installedPackages(nm), ['@frame12/terminal@0.1.0', '@frame12/tokens@0.2.0', 'commander@13.1.0']);
      const { bytes, files } = measureTree(nm);
      assert.equal(files, 5);
      assert.ok(bytes >= 150);
    } finally {
      rmSync(nm, { recursive: true, force: true });
    }
  });
});
