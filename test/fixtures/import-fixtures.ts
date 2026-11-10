/**
 * Deterministic TS/JS fixture repositories for the import-analysis golden snapshots
 * (`test/golden.test.ts`) and the classifier/import-graph parity test. Changing a
 * fixture changes the golden snapshots: re-record them only for a reviewed change.
 */
import { FixtureRepo } from '../helpers.js';

let counter = 0;
/** A new revision of a file that keeps it valid (JSON manifests must stay parseable). */
function revise(path: string, content: string): string {
  counter++;
  if (path.endsWith('.json')) return `${JSON.stringify({ ...JSON.parse(content), revision: counter }, null, 2)}\n`;
  if (path.endsWith('.md')) return `${content}\nRevision ${counter}.\n`;
  if (path.endsWith('.css')) return `${content}/* revision ${counter} */\n`;
  return `${content}// ${path} revision ${counter}\n`;
}

/** A single TS/JS app: relative, `paths`, `#imports`, barrels, triple-slash, require, dynamic and missing imports. */
export function buildAppFixture(): FixtureRepo {
  counter = 0;
  const repo = new FixtureRepo();
  const base: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', type: 'module', imports: { '#lib/*': './src/lib/*.ts' }, dependencies: { react: '18' } }, null, 2),
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }, null, 2),
    'src/index.ts': "export * from './api';\nexport * from './lib/util';\n",
    'src/api.ts': "import { db } from './db';\nimport { util } from '@/lib/util';\nimport React from 'react';\nimport fs from 'node:fs';\nexport const api = [db, util, React, fs];\n",
    'src/db.ts': 'export const db = 1;\n',
    'src/lib/util.ts': "import config from '#lib/config';\nexport const util = config;\n",
    'src/lib/config.ts': 'export default { retries: 3 };\n',
    'src/billing.ts': "export const PLAN = process.env.BILLING_PLAN;\n",
    'templates/invoice.ts': "export const template = process.env.BILLING_PLAN;\n",
    'src/loader.ts': 'export async function load(name: string) {\n  return import(name);\n}\n',
    'src/types.ts': '/// <reference path="./globals.d.ts" />\nexport type Id = string;\n',
    'src/globals.d.ts': 'declare const VERSION: string;\n',
    'src/missing.ts': "import './nope';\nimport '@/nothing';\nimport '#unknown';\n",
    'src/legacy.cjs': "const helper = require('./legacy-helper.cjs');\nmodule.exports = helper;\n",
    'src/legacy-helper.cjs': 'module.exports = 1;\n',
    'src/ui/button.tsx': "import { api } from '../index';\nexport const Button = () => api;\n",
    'src/ui/panel.tsx': "import { Button } from './button';\nexport const Panel = Button;\n",
    'src/api.test.ts': "import { api } from './api';\nconsole.log(api);\n",
    'README.md': '# app\n',
    'styles/main.css': 'body { margin: 0; }\n',
  };
  repo.commit({ message: 'initial', write: base });
  const groups: string[][] = [
    ['src/billing.ts', 'templates/invoice.ts'],
    ['src/api.ts', 'src/db.ts', 'src/api.test.ts'],
    ['src/ui/panel.tsx', 'src/db.ts'],
    ['src/loader.ts', 'src/lib/config.ts'],
    ['src/types.ts', 'src/globals.d.ts', 'styles/main.css'],
    ['src/legacy.cjs', 'src/missing.ts'],
    ['src/ui/button.tsx', 'src/lib/util.ts', 'README.md'],
  ];
  for (let round = 0; round < 5; round++) {
    for (const group of groups) {
      const write: Record<string, string> = {};
      for (const path of group) write[path] = revise(path, base[path]!);
      repo.commit({ message: `update ${group.join(' + ')} (${round})`, write });
    }
  }
  return repo;
}

/** An npm-workspaces monorepo: `exports`, subpaths, not-exported and unknown packages. */
export function buildWorkspaceFixture(): FixtureRepo {
  counter = 0;
  const repo = new FixtureRepo();
  const base: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }, null, 2),
    'packages/core/package.json': JSON.stringify({ name: '@acme/core', exports: { '.': './src/index.ts', './util': './src/util.ts' } }, null, 2),
    'packages/core/src/index.ts': "export * from './model';\n",
    'packages/core/src/model.ts': 'export interface Model { id: string }\nexport const MODEL_EVENT = "model:saved";\n',
    'packages/core/src/util.ts': 'export const slug = (s: string) => s.toLowerCase();\n',
    'packages/core/src/internal.ts': 'export const secret = 1;\n',
    'packages/web/package.json': JSON.stringify({ name: '@acme/web', dependencies: { '@acme/core': '*', lodash: '4' } }, null, 2),
    'packages/web/src/app.tsx': "import { MODEL_EVENT } from '@acme/core';\nimport { slug } from '@acme/core/util';\nimport { secret } from '@acme/core/internal';\nimport _ from 'lodash';\nexport const app = [MODEL_EVENT, slug, secret, _];\n",
    'packages/web/src/page.jsx': "import { app } from './app';\nexport default function Page() { return app; }\n",
    'packages/web/src/listener.js': "export const on = 'model:saved';\n",
    'packages/cli/package.json': JSON.stringify({ name: '@acme/cli', type: 'module' }, null, 2),
    'packages/cli/src/main.mjs': "import '@acme/missing';\nimport { slug } from '@acme/core/util';\nexport default slug;\n",
    'docs/guide.md': '# guide\n',
  };
  repo.commit({ message: 'initial', write: base });
  const groups: string[][] = [
    ['packages/core/src/model.ts', 'packages/web/src/listener.js'],
    ['packages/web/src/app.tsx', 'packages/core/src/util.ts'],
    ['packages/web/src/page.jsx', 'packages/core/src/model.ts', 'docs/guide.md'],
    ['packages/cli/src/main.mjs', 'packages/core/src/internal.ts'],
    ['packages/core/package.json', 'packages/core/src/index.ts'],
  ];
  for (let round = 0; round < 5; round++) {
    for (const group of groups) {
      const write: Record<string, string> = {};
      for (const path of group) write[path] = revise(path, base[path]!);
      repo.commit({ message: `update ${group.join(' + ')} (${round})`, write });
    }
  }
  return repo;
}
