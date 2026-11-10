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

const targetsOf = (analysis: FileAnalysis) => [...new Set(analysis.edges.flatMap((edge) => edge.targets.map((target) => target.path)))].sort();

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
  it('src/ layout: imports resolve inside src and include the package initializers on the path', () => {
    const files = {
      'src/myapp/__init__.py': '',
      'src/myapp/db.py': '',
      'src/myapp/api.py': 'import myapp.db\nimport requests\n',
      'tests/test_api.py': 'from myapp import api\n',
    };
    const api = analyze(files, 'src/myapp/api.py').analysis;
    assert.deepEqual(edgesOf(api), ['myapp.db -> src/myapp/__init__.py', 'myapp.db -> src/myapp/db.py']);
    // An undeclared third-party import is external and does not make the file incomplete.
    assert.equal(api.external, 1);
    assert.equal(api.incomplete, false);
    assert.deepEqual(edgesOf(analyze(files, 'tests/test_api.py').analysis), ['myapp -> src/myapp/__init__.py', 'myapp -> src/myapp/api.py']);
  });

  it('flat layout resolves from the repository root', () => {
    const files = { 'myapp/__init__.py': '', 'myapp/core.py': '', 'main.py': 'from myapp.core import run\n' };
    assert.deepEqual(edgesOf(analyze(files, 'main.py').analysis), ['myapp.core -> myapp/__init__.py', 'myapp.core -> myapp/core.py']);
  });

  it('pyproject setuptools where, poetry from and hatch packages layouts', () => {
    const setuptools = {
      'pyproject.toml': '[tool.setuptools.packages.find]\nwhere = ["lib"]\n',
      'lib/pkg/__init__.py': '',
      'lib/pkg/mod.py': '',
      'app.py': 'import pkg.mod\n',
    };
    assert.deepEqual(edgesOf(analyze(setuptools, 'app.py').analysis), ['pkg.mod -> lib/pkg/__init__.py', 'pkg.mod -> lib/pkg/mod.py']);
    const poetry = {
      'pyproject.toml': '[tool.poetry]\nname = "x"\npackages = [{ include = "pkg", from = "source" }]\n',
      'source/pkg/__init__.py': '',
      'source/pkg/mod.py': '',
      'app.py': 'import pkg.mod\n',
    };
    assert.deepEqual(edgesOf(analyze(poetry, 'app.py').analysis), ['pkg.mod -> source/pkg/__init__.py', 'pkg.mod -> source/pkg/mod.py']);
    const hatch = {
      'pyproject.toml': '[tool.hatch.build.targets.wheel]\npackages = ["code/foo"]\n',
      'code/foo/__init__.py': '',
      'code/foo/bar.py': '',
      'app.py': 'from foo import bar\n',
    };
    assert.deepEqual(edgesOf(analyze(hatch, 'app.py').analysis), ['foo -> code/foo/__init__.py', 'foo -> code/foo/bar.py']);
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
    assert.deepEqual(edgesOf(analyze(files, 'apps/web/views.py').analysis), [
      'core.models -> libs/core/src/core/__init__.py',
      'core.models -> libs/core/src/core/models.py',
    ]);
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

  it('namespace packages (no __init__.py) resolve their modules and have no initializer', () => {
    const files = { 'src/ns/plugins/a.py': '', 'src/app.py': 'import ns.plugins.a\nfrom ns.plugins import a\nimport ns\n' };
    const { analysis } = analyze(files, 'src/app.py');
    assert.deepEqual(edgesOf(analysis), ['ns.plugins -> src/ns/plugins/a.py', 'ns.plugins.a -> src/ns/plugins/a.py']);
    assert.equal(analysis.incomplete, false);
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
    assert.deepEqual(edgesOf(analysis), [
      '.. -> src/pkg/__init__.py',
      '.. -> src/pkg/sub/__init__.py',
      '...util -> src/pkg/__init__.py',
      '...util -> src/pkg/util.py',
    ]);
    assert.deepEqual(analysis.unresolved, [{ specifier: '.....', reasonCode: 'target-missing' }]);
    assert.deepEqual(analyze(files, 'src/top.py').analysis.unresolved, [{ specifier: '.', reasonCode: 'target-missing' }]);
  });

  it('literal importlib loads resolve with kind dynamic (initializers included); computed loads make the file incomplete', () => {
    const files = {
      'myapp/__init__.py': '',
      'myapp/plugins.py': '',
      'loader.py': 'import importlib\nimportlib.import_module("myapp.plugins")\n',
      'computed.py': 'from importlib import import_module\nimport_module(name)\n',
    };
    const loader = analyze(files, 'loader.py').analysis;
    assert.deepEqual(loader.edges, [
      {
        specifier: 'myapp.plugins',
        kind: 'dynamic',
        targets: [
          { path: 'myapp/__init__.py', via: 'python-module' },
          { path: 'myapp/plugins.py', via: 'python-module' },
        ],
      },
    ]);
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

  it('reads setup.py only as text (never executed) and treats layout declarations there as unmodeled', () => {
    const plain = buildPythonIndex(memoryFiles({ 'pkgs/a/setup.py': 'raise SystemExit("never run")\n', 'pkgs/a/a/__init__.py': '' }));
    assert.ok(plain.roots.includes('pkgs/a'));
    assert.deepEqual(plain.nameRoots.get('a'), ['pkgs/a']);
    assert.deepEqual(plain.layoutUncertain, []);
    const remapped = buildPythonIndex(memoryFiles({ 'setup.py': 'setup(package_dir={"public": "impl"})\n', 'impl/__init__.py': '' }));
    assert.equal(remapped.layoutUncertain.length, 1);
  });
});

describe('Python import semantics (RA-10 review regressions)', () => {
  it('importing a submodule runs every regular-package initializer on the path (absolute, from, nested, dynamic)', () => {
    const files = {
      'pkg/__init__.py': 'VALUE = 1\n',
      'pkg/child.py': '',
      'pkg/sub/__init__.py': '',
      'pkg/sub/leaf.py': '',
      'main.py': 'import pkg.child\n',
      'from_main.py': 'from pkg import child\n',
      'nested.py': 'import pkg.sub.leaf\n',
      'dynamic.py': 'import importlib\nimportlib.import_module("pkg.sub.leaf")\n',
    };
    assert.deepEqual(targetsOf(analyze(files, 'main.py').analysis), ['pkg/__init__.py', 'pkg/child.py']);
    assert.deepEqual(targetsOf(analyze(files, 'from_main.py').analysis), ['pkg/__init__.py', 'pkg/child.py']);
    assert.deepEqual(targetsOf(analyze(files, 'nested.py').analysis), ['pkg/__init__.py', 'pkg/sub/__init__.py', 'pkg/sub/leaf.py']);
    assert.deepEqual(targetsOf(analyze(files, 'dynamic.py').analysis), ['pkg/__init__.py', 'pkg/sub/__init__.py', 'pkg/sub/leaf.py']);
    // A package's own modules do not get a self edge, and relative imports include the package initializer.
    const inside = analyze({ ...files, 'pkg/other.py': 'from . import child\n' }, 'pkg/other.py').analysis;
    assert.deepEqual(targetsOf(inside), ['pkg/__init__.py', 'pkg/child.py']);
    const self = analyze({ ...files, 'pkg/__init__.py': 'from . import child\n' }, 'pkg/__init__.py').analysis;
    assert.deepEqual(targetsOf(self), ['pkg/child.py']);
  });

  it('a regular package wins over a same-named module; a module wins over a namespace directory', () => {
    const regular = analyze({ 'main.py': 'import pkg\n', 'pkg.py': '', 'pkg/__init__.py': '' }, 'main.py').analysis;
    assert.deepEqual(targetsOf(regular), ['pkg/__init__.py']);
    const namespace = analyze({ 'main.py': 'import pkg\n', 'pkg.py': '', 'pkg/inner.py': '' }, 'main.py').analysis;
    assert.deepEqual(targetsOf(namespace), ['pkg.py']);
    // `pkg` is the module pkg.py, which is not a package, so pkg.inner cannot be imported.
    const through = analyze({ 'main.py': 'import pkg.inner\n', 'pkg.py': '', 'pkg/inner.py': '' }, 'main.py').analysis;
    assert.deepEqual(through.edges, []);
    assert.deepEqual(through.unresolved, [{ specifier: 'pkg.inner', reasonCode: 'target-missing' }]);
  });

  it('from pkg import name: an attribute bound by __init__.py makes the submodule uncertain, never a direct claim', () => {
    const base = { 'pkg/child.py': '', 'main.py': 'from pkg import child\n' };
    const cases: [string, string, boolean][] = [
      ['explicit attribute', 'child = 42\n', true],
      ['re-exported attribute', 'from .impl import thing as child\n', true],
      ['other submodule under the name', 'from . import other as child\n', true],
      ['module __getattr__', 'def __getattr__(name):\n    return 1\n', true],
      ['star import', 'from .impl import *\n', true],
      ['function named child', 'def child():\n    pass\n', true],
      ['genuine child module', 'VALUE = 1\n', false],
      ['explicit submodule import', 'from . import child\n', false],
    ];
    for (const [label, init, ambiguous] of cases) {
      const analysis = analyze({ ...base, 'pkg/__init__.py': init }, 'main.py').analysis;
      if (ambiguous) {
        assert.deepEqual(targetsOf(analysis), ['pkg/__init__.py'], label);
        assert.equal(analysis.incomplete, true, label);
        assert.match(analysis.incompleteReason ?? '', /child may be an attribute of pkg\/__init__\.py or the submodule/, label);
      } else {
        assert.deepEqual(targetsOf(analysis), ['pkg/__init__.py', 'pkg/child.py'], label);
        assert.equal(analysis.incomplete, false, label);
      }
    }
  });

  it('setuptools package-dir maps a package name to a differently named directory', () => {
    const files = {
      'pyproject.toml': '[tool.setuptools]\npackage-dir = {public = "impl"}\n',
      'impl/__init__.py': '',
      'impl/core.py': 'from . import helpers\n',
      'impl/helpers.py': '',
      'main.py': 'import public\nimport public.core\n',
    };
    const main = analyze(files, 'main.py').analysis;
    assert.deepEqual(targetsOf(main), ['impl/__init__.py', 'impl/core.py']);
    assert.equal(main.incomplete, false);
    assert.deepEqual(targetsOf(analyze(files, 'impl/core.py').analysis), ['impl/__init__.py', 'impl/helpers.py']);
  });

  it('unsupported, unreadable, oversized and limit-exceeding manifests keep non-local imports unresolved, not external', () => {
    const layouts: [string, Record<string, string>][] = [
      ['dotted package-dir key', { 'pyproject.toml': '[tool.setuptools]\npackage-dir = {"public.sub" = "impl"}\n' }],
      ['TOML outside the subset', { 'pyproject.toml': '[tool.x]\nvalue = @nope\n' }],
      ['oversized pyproject', { 'pyproject.toml': `# ${'x'.repeat(70_000)}\n` }],
      ['setup.py package_dir', { 'setup.py': 'setup(package_dir={"public": "impl"})\n' }],
      ['hatch sources remap', { 'pyproject.toml': '[tool.hatch.build.targets.wheel.sources]\n"impl" = "public"\n' }],
    ];
    for (const [label, manifest] of layouts) {
      const files = { ...manifest, 'impl/__init__.py': '', 'main.py': 'import public\nimport os\n' };
      const { analysis, session } = analyze(files, 'main.py');
      assert.deepEqual(analysis.unresolved, [{ specifier: 'public', reasonCode: 'unsupported-config' }], label);
      assert.equal(analysis.external, 1, `${label}: the standard library stays external`);
      assert.equal(analysis.incomplete, true, label);
      assert.ok(session.indexWarnings().some((warning) => warning.includes('unsupported-config')), label);
    }
    const unreadable: RepoFiles = { ...memoryFiles({ 'pyproject.toml': 'x', 'main.py': 'import public\n' }), read: (path) => (path === 'pyproject.toml' ? undefined : path === 'main.py' ? 'import public\n' : '') };
    const session = new AnalysisSession(unreadable);
    assert.deepEqual(analyzeFile('main.py', unreadable, session).unresolved, [{ specifier: 'public', reasonCode: 'unsupported-config' }]);
  });

  it('import calls inside f-string replacement fields are loads; literal text and escaped braces are not', () => {
    const files = { 'helper.py': '', 'other.py': '' };
    const literal = analyze({ ...files, 'main.py': `value = f"{__import__('helper')}"\n` }, 'main.py').analysis;
    assert.deepEqual(targetsOf(literal), ['helper.py']);
    const computed = analyze({ ...files, 'main.py': 'import importlib\nvalue = f"{importlib.import_module(name)}"\n' }, 'main.py').analysis;
    assert.equal(computed.dynamicLoads, 1);
    assert.equal(computed.incomplete, true);
    const spec = analyze({ ...files, 'main.py': `w = 3\nvalue = f"{x:>{__import__('other') and w}}"\n` }, 'main.py').analysis;
    assert.deepEqual(targetsOf(spec), ['other.py']);
    const nested = analyze({ ...files, 'main.py': `value = f"{f'{__import__("helper")}'}"\n` }, 'main.py').analysis;
    assert.deepEqual(targetsOf(nested), ['helper.py']);
    const text = analyze({ ...files, 'main.py': `value = f"{{__import__('helper')}} import other"\nq = "__import__('other')"\n` }, 'main.py').analysis;
    assert.deepEqual(text.edges, []);
    assert.equal(text.dynamicLoads, 0);
    assert.equal(text.incomplete, false);
  });

  it('aliased loaders are followed; rebound or escaping names are uncertain, never invented edges', () => {
    const files = { 'helper.py': '' };
    const fn = analyze({ ...files, 'main.py': "from importlib import import_module as load\nload('helper')\nload(name)\n" }, 'main.py').analysis;
    assert.deepEqual(targetsOf(fn), ['helper.py']);
    assert.equal(fn.dynamicLoads, 1);
    const mod = analyze({ ...files, 'main.py': "import importlib as il\nil.import_module('helper')\n" }, 'main.py').analysis;
    assert.deepEqual(targetsOf(mod), ['helper.py']);
    const builtin = analyze({ ...files, 'main.py': "from builtins import __import__ as imp\nimp('helper')\n" }, 'main.py').analysis;
    assert.deepEqual(targetsOf(builtin), ['helper.py']);
    // A rebound alias could be any function: its calls are uncertain loads, not edges.
    const rebound = analyze({ ...files, 'main.py': "from importlib import import_module as load\ndef load(x):\n    return x\nload('helper')\n" }, 'main.py').analysis;
    assert.deepEqual(rebound.edges, []);
    assert.equal(rebound.incomplete, true);
    const param = analyze({ ...files, 'main.py': "def run(import_module):\n    import_module('helper')\n" }, 'main.py').analysis;
    assert.deepEqual(param.edges, []);
    assert.equal(param.incomplete, true);
    // An unrelated function with another name is not a loader.
    const unrelated = analyze({ ...files, 'main.py': "def load(x):\n    return x\nload('helper')\n" }, 'main.py').analysis;
    assert.deepEqual(unrelated.edges, []);
    assert.equal(unrelated.incomplete, false);
    // A loader stored for later use cannot be followed.
    const escaped = analyze({ ...files, 'main.py': 'import importlib\nloaders = [importlib.import_module]\n' }, 'main.py').analysis;
    assert.equal(escaped.dynamicLoads, 1);
  });
});

describe('Python relationships', () => {
  async function relationships(write: Record<string, string>, pairs: [string, string][]): Promise<string[]> {
    const repo = new FixtureRepo();
    try {
      repo.commit({ message: 'initial', write });
      const ctx = await loadContext(repo.dir, { cache: false } as never, { silent: true });
      try {
        return pairs.map(([a, b]) => ctx.classifier.classify(a, b));
      } finally {
        ctx.close?.();
      }
    } finally {
      repo.cleanup();
    }
  }

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
        assert.deepEqual(
          graph.edges.map((edge) => `${edge.from} -> ${edge.to} (${edge.specifier}, ${edge.via})`),
          ['src/shop/cart.py -> src/shop/__init__.py (shop, python-module)', 'src/shop/cart.py -> src/shop/pricing.py (shop, python-module)'],
        );
        assert.equal(graph.meta.imports?.dynamicLoads, 1);
        assert.equal(graph.meta.imports?.external, 2);
        assert.equal(graph.meta.imports?.heuristicEdges, 0);
      } finally {
        ctx.close?.();
      }
    } finally {
      repo.cleanup();
    }
  });

  it('review reproductions classify as the import system behaves', async () => {
    assert.deepEqual(
      await relationships({ 'main.py': 'import pkg.child\n', 'pkg/__init__.py': 'VALUE = 1\n', 'pkg/child.py': '' }, [['main.py', 'pkg/__init__.py']]),
      ['direct'],
    );
    assert.deepEqual(await relationships({ 'main.py': `value = f"{__import__('helper')}"\n`, 'helper.py': '' }, [['main.py', 'helper.py']]), ['direct']);
    assert.deepEqual(
      await relationships({ 'main.py': "from importlib import import_module as load\nload('helper')\n", 'helper.py': '' }, [['main.py', 'helper.py']]),
      ['direct'],
    );
    assert.deepEqual(
      await relationships(
        { 'pyproject.toml': '[tool.setuptools]\npackage-dir = {public = "impl"}\n', 'impl/__init__.py': '', 'main.py': 'import public\n' },
        [['main.py', 'impl/__init__.py']],
      ),
      ['direct'],
    );
    assert.deepEqual(
      await relationships({ 'main.py': 'import pkg\n', 'pkg.py': '', 'pkg/__init__.py': '' }, [['main.py', 'pkg/__init__.py'], ['main.py', 'pkg.py']]),
      ['direct', 'ghost'],
    );
    assert.deepEqual(
      await relationships({ 'main.py': 'from pkg import child\n', 'pkg/__init__.py': 'child = 42\n', 'pkg/child.py': '' }, [['main.py', 'pkg/child.py']]),
      ['unknown'],
    );
    assert.deepEqual(
      await relationships(
        { 'pyproject.toml': '[tool.setuptools]\npackage-dir = {"public.sub" = "impl"}\n', 'impl/__init__.py': '', 'main.py': 'import public\n' },
        [['main.py', 'impl/__init__.py']],
      ),
      ['unknown'],
    );
  });

  it('a dependency imported by a package initializer is one step removed (indirect)', async () => {
    assert.deepEqual(
      await relationships(
        { 'main.py': 'import pkg.child\n', 'pkg/__init__.py': 'from helpers import setup\n', 'pkg/child.py': '', 'helpers.py': '' },
        [['main.py', 'helpers.py']],
      ),
      ['indirect'],
    );
  });
});
