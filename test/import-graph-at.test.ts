import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openRepository, UsageError, type ImportGraphJson, type Repository } from '../src/api/index.js';
import { DIRTY_WORKTREE_HEAD_WARNING, SHALLOW_WARNING } from '../src/context.js';
import { AnalysisSession, analyzeFile, type AnalysisTarget } from '../src/imports/analysis.js';
import { RelationshipClassifier } from '../src/imports/classify.js';
import { setHistoryLoadObserverForTesting } from '../src/model/history.js';
import { loadSchema, sanitizeGitEnv, validateSchemaNode } from '../scripts/schema-validator.mjs';
import { FixtureRepo, memoryFiles } from './helpers.js';

const ROOT_DIR = join(import.meta.dirname, '..');
const SCHEMA_DIR = join(ROOT_DIR, 'schema');
const CLI = join(ROOT_DIR, 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

const SETTINGS = { cache: { enabled: false }, maxCommits: 20 } as const;
type ReuseStats = { reused: number; extracted: number };

const isSessionWarning = (warning: string): boolean =>
  warning === SHALLOW_WARNING ||
  warning === DIRTY_WORKTREE_HEAD_WARNING ||
  warning.startsWith('Only ') ||
  warning.startsWith('No usable commits');

/** Everything about a graph that describes the analyzed tree (not the session's history). */
function graphPart(json: ImportGraphJson) {
  return {
    files: json.files,
    edges: json.edges,
    unresolved: json.unresolved,
    languages: json.languages,
    imports: json.meta.imports,
    warnings: json.meta.warnings.filter((warning) => !isSessionWarning(warning)),
  };
}

async function open(cwd: string, head?: string): Promise<Repository> {
  return openRepository({ cwd, ...(head !== undefined ? { head } : {}), settings: { ...SETTINGS }, useConfigFile: false });
}

/** The graph at `at` from a fresh session there: the reference every derived result must equal. */
async function freshGraph(cwd: string, at: string, files?: string[]): Promise<ImportGraphJson> {
  const fresh = await open(cwd, at);
  try {
    return await fresh.importGraph(files ? { files } : undefined);
  } finally {
    await fresh.close();
  }
}

async function derivedGraph(
  session: Repository,
  at: string,
  files?: string[],
): Promise<{ graph: ImportGraphJson; stats?: ReuseStats }> {
  let stats: ReuseStats | undefined;
  const graph = await session.importGraph({
    ...(files ? { files } : {}),
    at,
    onReuse: (s: ReuseStats) => {
      stats = s;
    },
  } as { files?: string[]; at: string });
  return { graph, ...(stats ? { stats } : {}) };
}

const edgeKeys = (graph: ImportGraphJson) => graph.edges.map((e) => `${e.from} -> ${e.to} (${e.specifier}${e.role ? `, ${e.role}${e.name ? ` ${e.name}` : ''}` : ''}${e.heuristic ? ', heuristic' : ''})`);

const BASE_FILES: Record<string, string> = {
  // TS/JS: relative, tsconfig `paths`, a workspace package with `exports`.
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } } }),
  'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
  'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', exports: { '.': './src/index.ts', './button': './src/button.ts' } }),
  'packages/ui/src/index.ts': "export * from './button';\n",
  'packages/ui/src/button.ts': 'export const Button = 1;\n',
  'src/lib/util.ts': 'export const util = 1;\n',
  'src/lib/old.ts': 'export const old = 1;\n',
  'src/a.ts': "import { util } from '@lib/util';\nimport { old } from './lib/old';\nimport { Button } from '@acme/ui/button';\n",
  'src/b.ts': "import { old } from '@lib/old';\n",
  'src/c.ts': "import '@acme/ui';\n",
  // Go: a multi-file package.
  'go.mod': 'module example.com/app\n',
  'db/db.go': 'package db\n',
  'db/conn.go': 'package db\n',
  'db/old.go': 'package db\n',
  'main.go': 'package main\n\nimport "example.com/app/db"\n',
  'svc/svc.go': 'package svc\n\nimport "example.com/app/db"\n',
  // Python: a package, a namespace package, `from pkg import mod`, `import a.b.c`.
  'pkg/__init__.py': '',
  'pkg/mod.py': 'VALUE = 1\n',
  'pkg/sub/__init__.py': '',
  'pkg/sub/deep.py': 'from .. import mod\n',
  'ns/part.py': '',
  'app.py': 'import pkg.sub.deep\nfrom pkg import mod\nimport ns.part\n',
};

const REMOVED = ['src/lib/old.ts', 'packages/ui/src/button.ts', 'db/old.go', 'pkg/mod.py', 'ns/part.py'];

describe('importGraph({ at }) (RA-20): base-tree graph from the head session', () => {
  let repo: FixtureRepo;
  let baseSha: string;
  let headSha: string;

  before(() => {
    repo = new FixtureRepo();
    repo.commit({ message: 'base', write: BASE_FILES });
    baseSha = repo.git('rev-parse', 'HEAD').trim();
    repo.commit({
      message: 'head: remove and rename',
      move: [['packages/ui/src/button.ts', 'packages/ui/src/btn.ts']],
      write: {
        'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', exports: { '.': './src/index.ts', './button': './src/btn.ts' } }),
        'packages/ui/src/index.ts': "export * from './btn';\n",
        'src/lib/old.ts': null,
        'db/old.go': null,
        'pkg/mod.py': null,
        'ns/part.py': null,
        'src/c.ts': "import '@acme/ui';\nexport {};\n",
        'svc/svc.go': 'package svc\n\nimport (\n\t"example.com/app/db"\n)\n',
      },
    });
    headSha = repo.git('rev-parse', 'HEAD').trim();
  });

  after(() => repo.cleanup());

  it('scoped to removed paths: equals a fresh session at the base, for TS, Go and Python', async () => {
    const session = await open(repo.dir, headSha);
    try {
      await session.importGraph(); // the head graph a caller (Gutter) has already built
      const { graph, stats } = await derivedGraph(session, baseSha, REMOVED);
      const expected = await freshGraph(repo.dir, baseSha, REMOVED);
      assert.deepEqual(graphPart(graph), graphPart(expected));
      assert.deepEqual(graph.at, { ref: baseSha, sha: baseSha });
      assert.equal(expected.at, undefined);
      // The base importers of each removed path are there.
      const keys = edgeKeys(graph);
      for (const edge of [
        'src/a.ts -> src/lib/old.ts (./lib/old)',
        'src/b.ts -> src/lib/old.ts (@lib/old)',
        'src/a.ts -> packages/ui/src/button.ts (@acme/ui/button)',
        'packages/ui/src/index.ts -> packages/ui/src/button.ts (./button)',
        'main.go -> db/old.go (example.com/app/db, module)',
        'svc/svc.go -> db/old.go (example.com/app/db, module)',
        'app.py -> pkg/mod.py (pkg, name mod)',
        'pkg/sub/deep.py -> pkg/mod.py (.., name mod)',
        'app.py -> ns/part.py (ns.part, module)',
      ]) {
        assert.ok(keys.includes(edge), `missing ${edge} in:\n${keys.join('\n')}`);
      }
      // Only what differs from the head tree was parsed again; everything else was reused.
      assert.ok(stats, 'onReuse was called');
      assert.ok(stats.reused > 0, `reused ${stats.reused}`);
      // Changed or base-only analyzable files: button.ts, index.ts, old.ts, c.ts, old.go, svc.go, mod.py, part.py.
      assert.equal(stats.extracted, 8);
    } finally {
      await session.close();
    }
  });

  it('unscoped: the whole base graph equals a fresh session at the base', async () => {
    const session = await open(repo.dir, headSha);
    try {
      await session.importGraph();
      const { graph } = await derivedGraph(session, baseSha);
      assert.deepEqual(graphPart(graph), graphPart(await freshGraph(repo.dir, baseSha)));
      assert.equal(graph.meta.imports?.scope, 'repository');
    } finally {
      await session.close();
    }
  });

  it('works without a prior head graph, and from a working-tree session (dirty and untracked files included)', async () => {
    const expected = graphPart(await freshGraph(repo.dir, baseSha, REMOVED));
    const cold = await open(repo.dir, headSha);
    try {
      const { graph, stats } = await derivedGraph(cold, baseSha, REMOVED);
      assert.deepEqual(graphPart(graph), expected);
      assert.equal(stats?.reused, 0); // nothing analyzed at head yet: nothing to reuse
    } finally {
      await cold.close();
    }

    // Working tree: a tracked edit to a file unchanged between base and head, and an untracked file.
    repo.write('src/b.ts', "import { util } from '@lib/util';\n");
    repo.write('src/new.ts', "import { old } from './lib/old';\n");
    try {
      const worktree = await open(repo.dir);
      try {
        await worktree.importGraph();
        const { graph } = await derivedGraph(worktree, baseSha, REMOVED);
        assert.deepEqual(graphPart(graph), expected);
        assert.ok(edgeKeys(graph).includes('src/b.ts -> src/lib/old.ts (@lib/old)'), 'the base blob of src/b.ts is analyzed, not the working copy');
      } finally {
        await worktree.close();
      }
    } finally {
      repo.git('checkout', '--', 'src/b.ts');
      repo.git('clean', '-fq', '--', 'src/new.ts');
    }
  });

  it('loads no history for the base side and leaves the head session unchanged', async () => {
    const loads: (string | undefined)[] = [];
    setHistoryLoadObserverForTesting((_root, rev) => loads.push(rev));
    try {
      const session = await open(repo.dir, headSha);
      try {
        assert.equal(loads.length, 1, 'the session loads history once');
        const headGraph = await session.importGraph({ files: ['src/a.ts'] });
        await derivedGraph(session, baseSha, REMOVED);
        await derivedGraph(session, baseSha); // cached derived index
        assert.equal(loads.length, 1, `no history load for the base side: ${loads.join(', ')}`);
        assert.deepEqual(await session.importGraph({ files: ['src/a.ts'] }), headGraph);
      } finally {
        await session.close();
      }
    } finally {
      setHistoryLoadObserverForTesting(undefined);
    }
  });

  it('rejects a bad ref and a path absent from the base tree with UsageError', async () => {
    const session = await open(repo.dir, headSha);
    try {
      await assert.rejects(session.importGraph({ at: 'no-such-ref' }), (err) => err instanceof UsageError && /--at: "no-such-ref"/.test(err.message));
      await assert.rejects(session.importGraph({ at: '--output=x' }), UsageError);
      await assert.rejects(
        session.importGraph({ at: baseSha, files: ['packages/ui/src/btn.ts'] }),
        (err) => err instanceof UsageError && err.message.includes(`No such file in ${baseSha}: packages/ui/src/btn.ts`),
      );
    } finally {
      await session.close();
    }
  });

  it('CLI `imports --at --json` matches the library', () => {
    const res = spawnSync(
      process.execPath,
      ['--import', TSX, CLI, '--head', headSha, '--no-config', '--no-cache', '--max-commits', '20', 'imports', '--json', '--at', baseSha, '--files', ...REMOVED],
      { cwd: repo.dir, encoding: 'utf8', env: sanitizeGitEnv(process.env, { NO_COLOR: '1' }) },
    );
    assert.equal(res.status, 0, res.stderr);
    const cli = JSON.parse(res.stdout) as ImportGraphJson;
    return (async () => {
      const session = await open(repo.dir, headSha);
      try {
        const lib = await session.importGraph({ at: baseSha, files: REMOVED });
        assert.deepEqual(graphPart(cli), graphPart(lib));
        assert.deepEqual(cli.at, lib.at);
        assertSchema(cli);
      } finally {
        await session.close();
      }
    })();
  });
});

describe('importGraph({ at }): resolution-affecting files that differ are read from the base tree', () => {
  async function baseVsHead(base: Record<string, string>, head: Record<string, string | null>, files: string[]) {
    const repo = new FixtureRepo();
    try {
      repo.commit({ message: 'base', write: base });
      const baseSha = repo.git('rev-parse', 'HEAD').trim();
      repo.commit({ message: 'head', write: head });
      const headSha = repo.git('rev-parse', 'HEAD').trim();
      const session = await open(repo.dir, headSha);
      try {
        const headGraph = await session.importGraph();
        const { graph, stats } = await derivedGraph(session, baseSha, files);
        assert.deepEqual(graphPart(graph), graphPart(await freshGraph(repo.dir, baseSha, files)));
        return { head: edgeKeys(headGraph), base: edgeKeys(graph), stats: stats! };
      } finally {
        await session.close();
      }
    } finally {
      repo.cleanup();
    }
  }

  it('a tsconfig.json `paths` change', async () => {
    const { head, base, stats } = await baseVsHead(
      {
        'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } } }),
        'src/lib/x.ts': 'export const x = 1;\n',
        'src/other/x.ts': 'export const x = 2;\n',
        'src/use.ts': "import { x } from '@lib/x';\n",
      },
      { 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/other/*'] } } }) },
      ['src/lib/x.ts'],
    );
    assert.ok(head.includes('src/use.ts -> src/other/x.ts (@lib/x)'), head.join('\n'));
    assert.deepEqual(base, ['src/use.ts -> src/lib/x.ts (@lib/x)']);
    assert.equal(stats.extracted, 0, 'no source file differs: every parse is reused, only resolution reruns');
  });

  it('a go.mod module-path change', async () => {
    const { head, base, stats } = await baseVsHead(
      { 'go.mod': 'module example.com/old\n', 'db/db.go': 'package db\n', 'main.go': 'package main\n\nimport "example.com/old/db"\n' },
      { 'go.mod': 'module example.com/new\n' },
      ['db/db.go'],
    );
    assert.deepEqual(head, []);
    assert.deepEqual(base, ['main.go -> db/db.go (example.com/old/db, module)']);
    assert.equal(stats.extracted, 0);
  });

  it('a pyproject.toml package-dir change', async () => {
    const { head, base, stats } = await baseVsHead(
      {
        'pyproject.toml': '[tool.setuptools]\npackage-dir = {pub = "impl"}\n',
        'impl/__init__.py': '',
        'impl/core.py': '',
        'impl2/__init__.py': '',
        'impl2/core.py': '',
        'app.py': 'from pub import core\n',
      },
      { 'pyproject.toml': '[tool.setuptools]\npackage-dir = {pub = "impl2"}\n' },
      ['impl/core.py'],
    );
    assert.ok(head.includes('app.py -> impl2/core.py (pub, name core)'), head.join('\n'));
    assert.deepEqual(base, ['app.py -> impl/__init__.py (pub, module)', 'app.py -> impl/core.py (pub, name core)']);
    assert.equal(stats.extracted, 0);
  });
});

function pythonTargets(files: Record<string, string>, from: string): string[] {
  const reader = memoryFiles(files);
  const analysis = analyzeFile(from, reader, new AnalysisSession(reader));
  const show = (specifier: string, t: AnalysisTarget) =>
    `${specifier} -> ${t.path} ${t.role ?? '-'}${t.name !== undefined ? ` ${t.name}` : ''}${t.heuristic ? ' heuristic' : ''}`;
  return analysis.edges.flatMap((edge) => edge.targets.map((t) => show(edge.specifier, t))).sort();
}

describe('Python target roles (RA-20)', () => {
  const tree = {
    'a/__init__.py': '',
    'a/b/__init__.py': '',
    'a/b/c.py': '',
    'pkg/__init__.py': '',
    'pkg/mod.py': '',
    'pkg/sub/__init__.py': '',
    'pkg/sub/leaf.py': '',
    'ns/part.py': '',
  };

  it('import a.b.c / import a.b: the leaf is `module`, initializers on the way are `init`', () => {
    assert.deepEqual(pythonTargets({ ...tree, 'main.py': 'import a.b.c\n' }, 'main.py'), [
      'a.b.c -> a/__init__.py init',
      'a.b.c -> a/b/__init__.py init',
      'a.b.c -> a/b/c.py module',
    ]);
    assert.deepEqual(pythonTargets({ ...tree, 'main.py': 'import a.b\n' }, 'main.py'), ['a.b -> a/__init__.py init', 'a.b -> a/b/__init__.py module']);
    // Dynamic loads say the same.
    assert.deepEqual(pythonTargets({ ...tree, 'main.py': "import importlib\nimportlib.import_module('a.b.c')\n" }, 'main.py'), [
      'a.b.c -> a/__init__.py init',
      'a.b.c -> a/b/__init__.py init',
      'a.b.c -> a/b/c.py module',
    ]);
  });

  it('from pkg import mod: the package is `module`, the submodule is `name` (modules and subpackages)', () => {
    assert.deepEqual(pythonTargets({ ...tree, 'main.py': 'from pkg import mod, sub\n' }, 'main.py'), [
      'pkg -> pkg/__init__.py module',
      'pkg -> pkg/mod.py name mod',
      'pkg -> pkg/sub/__init__.py name sub',
    ]);
    // An attribute of a plain module is no submodule.
    assert.deepEqual(pythonTargets({ ...tree, 'main.py': 'from pkg.mod import VALUE\n' }, 'main.py'), [
      'pkg.mod -> pkg/__init__.py init',
      'pkg.mod -> pkg/mod.py module',
    ]);
  });

  it('relative imports: an enclosing package is never a target; names and modules keep their roles', () => {
    assert.deepEqual(pythonTargets({ ...tree, 'pkg/sub/x.py': 'from . import leaf\nfrom .. import mod\nfrom ..mod import VALUE\n' }, 'pkg/sub/x.py'), [
      '. -> pkg/sub/leaf.py name leaf',
      '.. -> pkg/mod.py name mod',
      '..mod -> pkg/mod.py module',
    ]);
  });

  it('a namespace package has no initializer: only the module', () => {
    assert.deepEqual(pythonTargets({ ...tree, 'main.py': 'import ns.part\nfrom ns import part\n' }, 'main.py'), [
      'ns -> ns/part.py name part',
      'ns.part -> ns/part.py module',
    ]);
  });

  it('package-dir mappings', () => {
    const files = { 'pyproject.toml': '[tool.setuptools]\npackage-dir = {pub = "impl"}\n', 'impl/__init__.py': '', 'impl/core.py': '', 'impl/util.py': 'from . import core\n' };
    assert.deepEqual(pythonTargets({ ...files, 'main.py': 'from pub import core\nimport pub.core\n' }, 'main.py'), [
      'pub -> impl/__init__.py module',
      'pub -> impl/core.py name core',
      'pub.core -> impl/__init__.py init',
      'pub.core -> impl/core.py module',
    ]);
    assert.deepEqual(pythonTargets(files, 'impl/util.py'), ['. -> impl/core.py name core']);
  });

  it('`from . import x` under a PEP 562 `__getattr__` (github/spec-kit): a heuristic `name` edge, graph-only', () => {
    // The shape of src/specify_cli/workflows/overlay/__init__.py in github/spec-kit.
    const init = 'from . import loader\n\n\ndef __getattr__(name):\n    if name == "Overlay":\n        from .model import Overlay\n        return Overlay\n    raise AttributeError(name)\n';
    const files = { 'overlay/__init__.py': init, 'overlay/loader.py': '', 'overlay/model.py': '', 'main.py': 'from overlay import loader\n' };
    assert.deepEqual(pythonTargets(files, 'overlay/__init__.py'), [
      '. -> overlay/loader.py name loader heuristic',
      '.model -> overlay/model.py module', // the lazy import inside __getattr__
    ]);
    assert.deepEqual(pythonTargets(files, 'main.py'), ['overlay -> overlay/__init__.py module', 'overlay -> overlay/loader.py name loader heuristic']);
    // Relationships stay conservative: the pair is unknown (possible), never direct.
    const classifier = new RelationshipClassifier(memoryFiles(files));
    assert.equal(classifier.classify('overlay/__init__.py', 'overlay/loader.py'), 'unknown');
    assert.equal(classifier.classify('main.py', 'overlay/loader.py'), 'unknown');
    // Any other dynamic namespace (star import, globals(), a second use of __getattr__) keeps it uncertain only.
    for (const other of ['from .model import *\n', 'globals()["x"] = 1\n', 'x = __getattr__\n']) {
      const targets = pythonTargets({ ...files, 'overlay/__init__.py': init + other }, 'overlay/__init__.py');
      assert.deepEqual(targets.filter((t) => t.startsWith('. ')), [], other);
    }
  });
});

function assertSchema(value: unknown): void {
  const schema = loadSchema(SCHEMA_DIR, 'import-graph.schema.json');
  const errors: string[] = [];
  validateSchemaNode(SCHEMA_DIR, value, schema, 'import-graph.schema.json', '$', errors);
  assert.deepEqual(errors, [], errors.join('\n'));
}

describe('import-graph schema: role, name and at', () => {
  it('validates with and without role/name/at, and rejects unknown roles', async () => {
    const repo = new FixtureRepo();
    try {
      repo.commit({ message: 'base', write: BASE_FILES });
      const sha = repo.git('rev-parse', 'HEAD').trim();
      const session = await open(repo.dir, sha);
      try {
        const graph = await session.importGraph();
        assert.ok(graph.edges.some((e) => e.role === 'init') && graph.edges.some((e) => e.role === 'name' && e.name === 'mod'));
        assert.ok(graph.edges.filter((e) => e.via === 'python-module' || e.via === 'go-package').every((e) => e.role !== undefined));
        assert.ok(graph.edges.filter((e) => e.via !== 'python-module' && e.via !== 'go-package').every((e) => e.role === undefined));
        assertSchema(graph);
        assertSchema({ ...graph, edges: graph.edges.map(({ role: _role, name: _name, ...rest }) => rest) });
        assertSchema(await session.importGraph({ at: sha, files: ['pkg/mod.py'] }));
        const bad = { ...graph, edges: [{ ...graph.edges[0]!, role: 'parent' }] };
        const errors: string[] = [];
        validateSchemaNode(SCHEMA_DIR, bad, loadSchema(SCHEMA_DIR, 'import-graph.schema.json'), 'import-graph.schema.json', '$', errors);
        assert.ok(errors.length > 0);
      } finally {
        await session.close();
      }
    } finally {
      repo.cleanup();
    }
  });
});

describe('importGraph({ at }) on a real repository at two commits', () => {
  // This repository at v0.10.0 (base) and v0.11.0 (head). CI checks out full history.
  const BASE = '3c5f9f7';
  const HEAD = '9d19f4d';
  const available = spawnSync('git', ['cat-file', '-e', `${BASE}^{commit}`], { cwd: ROOT_DIR }).status === 0 &&
    spawnSync('git', ['cat-file', '-e', `${HEAD}^{commit}`], { cwd: ROOT_DIR }).status === 0;

  it('whole graph and a scoped graph equal fresh sessions at the base', { skip: available ? false : 'history not available' }, async () => {
    const changed = spawnSync('git', ['diff', '--name-only', '--diff-filter=M', BASE, HEAD, '--', 'src/*.ts'], { cwd: ROOT_DIR, encoding: 'utf8' })
      .stdout.split('\n')
      .filter(Boolean)
      .slice(0, 5);
    assert.ok(changed.length > 0);
    const session = await open(ROOT_DIR, HEAD);
    try {
      await session.importGraph();
      const whole = await derivedGraph(session, BASE);
      assert.deepEqual(graphPart(whole.graph), graphPart(await freshGraph(ROOT_DIR, BASE)));
      assert.ok(whole.stats!.reused > whole.stats!.extracted, JSON.stringify(whole.stats));
      const scoped = await derivedGraph(session, BASE, changed);
      assert.deepEqual(graphPart(scoped.graph), graphPart(await freshGraph(ROOT_DIR, BASE, changed)));
    } finally {
      await session.close();
    }
  });
});

