import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { importGraph } from '../src/commands/imports.js';
import { loadContext } from '../src/context.js';
import { AnalysisSession, analyzeFile, type FileAnalysis } from '../src/imports/analysis.js';
import { buildPythonIndex, extractPythonImports } from '../src/imports/python.js';
import { parseTomlSubset, TomlScalar, TomlSubsetError } from '../src/imports/toml.js';
import type { RepoFiles } from '../src/imports/resolve.js';
import { FixtureRepo } from './helpers.js';

function memoryFiles(files: Record<string, string>): RepoFiles {
  return {
    exists: (path) => Object.hasOwn(files, path),
    read: (path) => (Object.hasOwn(files, path) ? files[path] : undefined),
    list: () => Object.keys(files),
  };
}

function analyze(files: Record<string, string>, path: string): { analysis: FileAnalysis; session: AnalysisSession } {
  const repo = memoryFiles(files);
  const session = new AnalysisSession(repo);
  return { analysis: analyzeFile(path, repo, session), session };
}

const edgesOf = (analysis: FileAnalysis) =>
  analysis.edges.flatMap((edge) => edge.targets.map((target) => `${edge.specifier} -> ${target.path}${target.heuristic ? ' (heuristic)' : ''}`)).sort();

describe('Python import extraction', () => {
  it('reads import forms at any statement start', () => {
    const parsed = extractPythonImports(`import os, json, myapp.db
import myapp.models as m
from myapp.services import (
    client,
    billing as b,  # trailing comment
)
from . import sibling; from ..pkg import thing
from .mod import *
x = 1; import late
try:
    import fast_json as json
except ImportError:
    import json
def handler():
    from myapp.lazy import load
    return load
if True: import inline
`);
    assert.equal(parsed.error, undefined);
    assert.deepEqual(
      parsed.imports.map((item) => (item.names ? `${item.specifier}:${item.names.join(',')}` : item.specifier)),
      [
        'os',
        'json',
        'myapp.db',
        'myapp.models',
        'myapp.services:client,billing',
        '.:sibling',
        '..pkg:thing',
        '.mod:*',
        'late',
        'fast_json',
        'json',
        'myapp.lazy:load',
        'inline',
      ],
    );
  });

  it('ignores import text inside strings, f-strings and comments', () => {
    const parsed = extractPythonImports(`query = """from payments import charge"""
other = 'import os'
raw = rb"import x\\" import y"
msg = f"{'import nested'} from {value!r:>{width}} import z {{import literal}}"
nested = f"{f'{x}'} import q"
# import commented
s = "a" \\
    "import b"
`);
    assert.deepEqual(parsed.imports, []);
    assert.equal(parsed.error, undefined);
  });

  it('flags unterminated strings and brackets as incomplete', () => {
    assert.match(extractPythonImports('x = """never closed\nimport os\n').error ?? '', /unterminated triple-quoted string/);
    assert.match(extractPythonImports("x = 'oops\nimport os\n").error ?? '', /unterminated string/);
    assert.match(extractPythonImports('x = (1,\nimport os\n').error ?? '', /unterminated bracket/);
    assert.match(extractPythonImports('from import x\n').error ?? '', /unparsed from statement/);
  });

  it('resolves literal importlib/__import__ calls as dynamic and counts computed ones', () => {
    const parsed = extractPythonImports(`import importlib
plugin = importlib.import_module("myapp.plugins")
other = __import__('myapp.extra')
from importlib import import_module
mod = import_module(name)
rel = import_module(".local", package=__name__)
joined = import_module("myapp." + name)
def import_module(x): pass
`);
    assert.deepEqual(
      parsed.imports.filter((item) => item.kind === 'dynamic').map((item) => item.specifier),
      ['myapp.plugins', 'myapp.extra'],
    );
    assert.equal(parsed.dynamicLoads, 3);
  });
});

describe('minimal TOML subset reader', () => {
  it('reads tables, dotted keys, strings, arrays and inline tables', () => {
    const toml = parseTomlSubset(`# comment
[project]
name = "demo"
version = '1.0'
requires-python = ">=3.9"
dependencies = [
  "requests>=2",  # inline comment
  'click',
]
classifiers = """
multi
line"""

[tool.setuptools.packages.find]
where = ["src"]

[tool.poetry]
packages = [{ include = "foo", from = "lib" }, { include = "bar" }]

[tool.black]
line-length = 88
preview = true
target.version = "py311"

[[tool.mypy.overrides]]
module = "x.*"
`);
    const project = toml.project as Record<string, unknown>;
    assert.equal(project.name, 'demo');
    assert.deepEqual(project.dependencies, ['requests>=2', 'click']);
    assert.equal(project.classifiers, 'multi\nline');
    const tool = toml.tool as Record<string, Record<string, unknown>>;
    assert.deepEqual((tool.setuptools!.packages as Record<string, Record<string, unknown>>).find!.where, ['src']);
    assert.ok(tool.black!['line-length'] instanceof TomlScalar);
    assert.equal((tool.black!.target as Record<string, unknown>).version, 'py311');
    assert.equal(Object.getPrototypeOf(toml), null);
  });

  it('rejects what it does not understand, and __proto__ is just a key', () => {
    assert.throws(() => parseTomlSubset('key = "unterminated\n'), TomlSubsetError);
    assert.throws(() => parseTomlSubset('[table\n'), TomlSubsetError);
    assert.throws(() => parseTomlSubset('a = [1, 2\n'), TomlSubsetError);
    assert.throws(() => parseTomlSubset('a = @\n'), TomlSubsetError);
    const parsed = parseTomlSubset('[__proto__]\npolluted = "yes"\n');
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal((parsed.__proto__ as unknown as Record<string, unknown>).polluted, 'yes');
  });
});

describe('Python source roots and resolution', () => {
  it('src/ layout: absolute imports resolve inside src', () => {
    const files = {
      'src/myapp/__init__.py': '',
      'src/myapp/db.py': '',
      'src/myapp/api.py': 'import myapp.db\nimport requests\n',
      'tests/test_api.py': 'from myapp import api\n',
    };
    assert.deepEqual(edgesOf(analyze(files, 'src/myapp/api.py').analysis), ['myapp.db -> src/myapp/db.py']);
    const api = analyze(files, 'src/myapp/api.py').analysis;
    // An undeclared third-party import is external and does not make the file incomplete.
    assert.equal(api.external, 1);
    assert.equal(api.incomplete, false);
    assert.deepEqual(edgesOf(analyze(files, 'tests/test_api.py').analysis), ['myapp -> src/myapp/api.py']);
  });

  it('flat layout resolves from the repository root', () => {
    const files = { 'myapp/__init__.py': '', 'myapp/core.py': '', 'main.py': 'from myapp.core import run\n' };
    assert.deepEqual(edgesOf(analyze(files, 'main.py').analysis), ['myapp.core -> myapp/core.py (heuristic)']);
  });

  it('pyproject setuptools where, poetry from and hatch packages layouts', () => {
    const setuptools = {
      'pyproject.toml': '[tool.setuptools.packages.find]\nwhere = ["lib"]\n',
      'lib/pkg/__init__.py': '',
      'lib/pkg/mod.py': '',
      'app.py': 'import pkg.mod\n',
    };
    assert.deepEqual(edgesOf(analyze(setuptools, 'app.py').analysis), ['pkg.mod -> lib/pkg/mod.py']);
    const poetry = {
      'pyproject.toml': '[tool.poetry]\nname = "x"\npackages = [{ include = "pkg", from = "source" }]\n',
      'source/pkg/__init__.py': '',
      'source/pkg/mod.py': '',
      'app.py': 'import pkg.mod\n',
    };
    assert.deepEqual(edgesOf(analyze(poetry, 'app.py').analysis), ['pkg.mod -> source/pkg/mod.py']);
    const hatch = {
      'pyproject.toml': '[tool.hatch.build.targets.wheel]\npackages = ["code/foo"]\n',
      'code/foo/__init__.py': '',
      'code/foo/bar.py': '',
      'app.py': 'from foo import bar\n',
    };
    assert.deepEqual(edgesOf(analyze(hatch, 'app.py').analysis), ['foo -> code/foo/bar.py']);
    const packageDir = {
      'pyproject.toml': '[tool.setuptools]\npackage-dir = {"" = "python"}\n',
      'python/pkg/__init__.py': '',
      'app.py': 'import pkg\n',
    };
    assert.deepEqual(edgesOf(analyze(packageDir, 'app.py').analysis), ['pkg -> python/pkg/__init__.py']);
  });

  it('nested pyproject projects are their own roots (monorepos)', () => {
    const files = {
      'libs/core/pyproject.toml': '[project]\nname = "core"\n',
      'libs/core/src/core/__init__.py': '',
      'libs/core/src/core/models.py': '',
      'apps/web/views.py': 'from core.models import User\n',
    };
    assert.deepEqual(edgesOf(analyze(files, 'apps/web/views.py').analysis), ['core.models -> libs/core/src/core/models.py (heuristic)']);
  });

  it('unsupported TOML is a warning and falls back to the project directory', () => {
    const files = { 'pyproject.toml': '[tool.x]\nvalue = @nope\n', 'pkg/__init__.py': '', 'app.py': 'import pkg\n' };
    const { analysis, session } = analyze(files, 'app.py');
    assert.deepEqual(edgesOf(analysis), ['pkg -> pkg/__init__.py']);
    assert.ok(session.indexWarnings().some((warning) => /pyproject\.toml uses TOML outside the supported subset \(unsupported-config/.test(warning)));
    const big = { 'pyproject.toml': `# ${'x'.repeat(70_000)}\n`, 'app.py': 'import os\n' };
    assert.ok(analyze(big, 'app.py').session.indexWarnings().some((warning) => warning.includes('larger than 64 KiB')));
  });

  it('a local module shadows the stdlib', () => {
    const files = { 'src/json.py': '', 'src/app.py': 'import json\n' };
    assert.deepEqual(edgesOf(analyze(files, 'src/app.py').analysis), ['json -> src/json.py']);
  });

  it('the same top-level name in two roots is ambiguous-package', () => {
    const files = {
      'pyproject.toml': '[tool.setuptools.packages.find]\nwhere = ["src", "lib"]\n',
      'src/shared/__init__.py': '',
      'lib/shared/__init__.py': '',
      'app.py': 'import shared\n',
    };
    const { analysis } = analyze(files, 'app.py');
    assert.deepEqual(analysis.edges, []);
    assert.deepEqual(analysis.unresolved, [{ specifier: 'shared', reasonCode: 'ambiguous-package' }]);
    assert.equal(analysis.incomplete, true);
  });

  it('namespace packages (no __init__.py) resolve their modules', () => {
    const files = { 'src/ns/plugins/a.py': '', 'src/app.py': 'import ns.plugins.a\nfrom ns.plugins import a\nimport ns\n' };
    const { analysis } = analyze(files, 'src/app.py');
    assert.deepEqual(edgesOf(analysis), ['ns.plugins -> src/ns/plugins/a.py', 'ns.plugins.a -> src/ns/plugins/a.py']);
    assert.equal(analysis.incomplete, false);
  });

  it('from services import client: the submodule when present, else a heuristic edge to __init__.py', () => {
    const withSubmodule = { 'services/__init__.py': '', 'services/client.py': '', 'app.py': 'from services import client\n' };
    assert.deepEqual(edgesOf(analyze(withSubmodule, 'app.py').analysis), ['services -> services/client.py']);
    const attribute = { 'services/__init__.py': 'client = 1\n', 'app.py': 'from services import client\n' };
    const { analysis } = analyze(attribute, 'app.py');
    assert.deepEqual(edgesOf(analysis), ['services -> services/__init__.py (heuristic)']);
  });

  it('relative imports climb packages but never above the root', () => {
    const files = {
      'src/pkg/__init__.py': '',
      'src/pkg/util.py': '',
      'src/pkg/sub/__init__.py': '',
      'src/pkg/sub/deep/__init__.py': '',
      'src/pkg/sub/deep/mod.py': 'from ...util import helper\nfrom .. import sub_helper\nfrom ..... import nothing\n',
      'src/top.py': 'from . import x\n',
    };
    const { analysis } = analyze(files, 'src/pkg/sub/deep/mod.py');
    assert.deepEqual(edgesOf(analysis), ['.. -> src/pkg/sub/__init__.py (heuristic)', '...util -> src/pkg/util.py (heuristic)']);
    assert.deepEqual(analysis.unresolved, [{ specifier: '.....', reasonCode: 'target-missing' }]);
    assert.deepEqual(analyze(files, 'src/top.py').analysis.unresolved, [{ specifier: '.', reasonCode: 'target-missing' }]);
  });

  it('literal importlib loads resolve with kind dynamic; computed loads make the file incomplete', () => {
    const files = {
      'myapp/__init__.py': '',
      'myapp/plugins.py': '',
      'loader.py': 'import importlib\nimportlib.import_module("myapp.plugins")\n',
      'computed.py': 'from importlib import import_module\nimport_module(name)\n',
    };
    const loader = analyze(files, 'loader.py').analysis;
    assert.deepEqual(loader.edges, [{ specifier: 'myapp.plugins', kind: 'dynamic', targets: [{ path: 'myapp/plugins.py', via: 'python-module' }] }]);
    assert.equal(loader.incomplete, false);
    const computed = analyze(files, 'computed.py').analysis;
    assert.equal(computed.dynamicLoads, 1);
    assert.equal(computed.incomplete, true);
  });

  it('an unterminated triple quote makes the file incomplete', () => {
    const { analysis } = analyze({ 'app.py': 'import os\nx = """oops\n' }, 'app.py');
    assert.equal(analysis.analyzable, true);
    assert.equal(analysis.incomplete, true);
    assert.match(analysis.incompleteReason ?? '', /unterminated triple-quoted string/);
  });

  it('a package outside every known root, or a script sibling, is unknown-package rather than external', () => {
    const files = {
      'tools/vendor/thing/__init__.py': '',
      'scripts/run.py': 'import helper\nimport thing\nimport requests\n',
      'scripts/helper.py': '',
    };
    const { analysis } = analyze(files, 'scripts/run.py');
    assert.deepEqual(analysis.unresolved, [
      { specifier: 'helper', reasonCode: 'unknown-package' },
      { specifier: 'thing', reasonCode: 'unknown-package' },
    ]);
    assert.equal(analysis.external, 1);
  });

  it('builds roots without executing or reading setup.py', () => {
    let readSetup = false;
    const base = memoryFiles({ 'pkgs/a/setup.py': 'raise SystemExit("never run")\n', 'pkgs/a/a/__init__.py': '' });
    const files: RepoFiles = { ...base, read: (path) => ((readSetup ||= path.endsWith('setup.py')), base.read(path)) };
    const index = buildPythonIndex(files);
    assert.equal(readSetup, false);
    assert.ok(index.roots.includes('pkgs/a'));
    assert.deepEqual(index.nameRoots.get('a'), ['pkgs/a']);
  });
});

describe('Python relationships', () => {
  it('direct with an import, ghost without, unknown when unsure', async () => {
    const repo = new FixtureRepo();
    try {
      repo.commit({
        message: 'initial',
        write: {
          'src/shop/__init__.py': '',
          'src/shop/cart.py': 'from shop import pricing\nimport requests\n',
          'src/shop/pricing.py': 'RATE = 1\n',
          'src/shop/emails.py': 'TEMPLATE = "from shop import cart"\n',
          'src/shop/reports.py': 'import importlib\nmod = importlib.import_module(name)\n',
        },
      });
      const ctx = await loadContext(repo.dir, { cache: false } as never, { silent: true });
      try {
        const c = ctx.classifier;
        assert.equal(c.classify('src/shop/cart.py', 'src/shop/pricing.py'), 'direct');
        assert.equal(c.explain('src/shop/cart.py', 'src/shop/pricing.py', 'direct'), 'cart.py imports pricing.py');
        assert.equal(c.classify('src/shop/pricing.py', 'src/shop/emails.py'), 'ghost');
        assert.equal(c.classify('src/shop/reports.py', 'src/shop/emails.py'), 'unknown');
        const graph = importGraph(ctx);
        assert.deepEqual(graph.languages, ['python']);
        assert.deepEqual(graph.edges, [{ from: 'src/shop/cart.py', to: 'src/shop/pricing.py', specifier: 'shop', kind: 'static', via: 'python-module' }]);
        assert.equal(graph.meta.imports?.dynamicLoads, 1);
        assert.equal(graph.meta.imports?.external, 2);
      } finally {
        ctx.close?.();
      }
    } finally {
      repo.cleanup();
    }
  });
});

describe('Python heuristic wording', () => {
  it('explains a from-import of a name defined in a module as heuristic', async () => {
    const repo = new FixtureRepo();
    try {
      repo.commit({ message: 'initial', write: { 'pkg/__init__.py': '', 'pkg/app.py': 'from .models import User\n', 'pkg/models.py': 'User = 1\n' } });
      const ctx = await loadContext(repo.dir, { cache: false } as never, { silent: true });
      try {
        assert.equal(ctx.classifier.classify('pkg/app.py', 'pkg/models.py'), 'direct');
        assert.equal(
          ctx.classifier.explain('pkg/app.py', 'pkg/models.py', 'direct'),
          'app.py imports models.py (heuristic: the imported name is probably defined in it, not a submodule)',
        );
      } finally {
        ctx.close?.();
      }
    } finally {
      repo.cleanup();
    }
  });
});
