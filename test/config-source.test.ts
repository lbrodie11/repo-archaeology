/**
 * RA-19: `--no-config` and `--config-from <ref>` (library: `useConfigFile: false`, `configRef`).
 *
 * The fixture reproduces the trust-boundary case from Gutter's GU-05 review: a pull request
 * branch adds its own `.repo-archaeology.json` that ignores the file it forgot to change, so a
 * review that reads the PR's config would hide the PR's own omission.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ConfigError, openRepository, UsageError } from '../src/api/index.js';
import { MAX_CONFIG_BYTES } from '../src/config.js';
import { loadContext } from '../src/context.js';
import { sanitizeGitEnv } from '../scripts/schema-validator.mjs';
import { FixtureRepo } from './helpers.js';

const ROOT_DIR = join(import.meta.dirname, '..');
const CLI = join(ROOT_DIR, 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const CONFIG = '.repo-archaeology.json';

function runCli(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: sanitizeGitEnv(process.env, { NO_COLOR: '1' }),
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function json(args: string[], cwd: string) {
  const res = runCli([...args, '--json', '--no-cache'], cwd);
  assert.equal(res.code, 0, `${args.join(' ')} exited ${res.code}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function hasPair(result: { relationships: { from: string; to: string }[] }, a: string, b: string): boolean {
  return result.relationships.some((r) => (r.from === a && r.to === b) || (r.from === b && r.to === a));
}

function suggests(result: { suggestions: { to: string }[] }, file: string): boolean {
  return result.suggestions.some((s) => s.to === file);
}

describe('RA-19: choosing which .repo-archaeology.json applies', () => {
  let repo: FixtureRepo;
  let rootSha: string;
  let mainSha: string;
  let prSha: string;

  const gitIn = (args: string[], input?: string): string =>
    execFileSync('git', args, { cwd: repo.dir, encoding: 'utf8', input, env: sanitizeGitEnv(process.env) });

  /** A branch off `main` whose only change is `.repo-archaeology.json` with the given mode and content (no checkout). */
  const branchWithConfig = (name: string, mode: '100644' | '120000', content: string): string => {
    const blob = gitIn(['hash-object', '-w', '--stdin'], content).trim();
    const entries = gitIn(['ls-tree', 'main'])
      .split('\n')
      .filter((line) => line !== '' && !line.endsWith(`\t${CONFIG}`));
    entries.push(`${mode} blob ${blob}\t${CONFIG}`);
    const tree = gitIn(['mktree'], `${entries.join('\n')}\n`).trim();
    const commit = gitIn(['commit-tree', tree, '-p', 'main', '-m', `config: ${name}`]).trim();
    repo.git('branch', name, commit);
    return commit;
  };

  before(() => {
    repo = new FixtureRepo();
    repo.write('src/a.ts', 'export const a = 0;\n');
    repo.write('src/b.ts', 'export const b = 0;\n');
    repo.git('add', '.');
    repo.commit({ message: 'root', author: 'Alice' });
    rootSha = repo.git('rev-parse', 'HEAD').trim();
    for (let i = 1; i <= 5; i++) {
      repo.commit({
        message: `feat: update a and b ${i}`,
        author: 'Alice',
        write: { 'src/a.ts': `export const a = ${i};\n`, 'src/b.ts': `export const b = ${i};\n` },
      });
    }
    // The base branch's reviewed config: stricter minShared, no ignores.
    repo.commit({ message: 'chore: base config', author: 'Alice', write: { [CONFIG]: JSON.stringify({ minShared: 4 }) } });
    mainSha = repo.git('rev-parse', 'HEAD').trim();

    // The pull request: changes a.ts without b.ts and adds a config that hides b.ts.
    repo.git('checkout', '-q', '-b', 'pr');
    repo.commit({ message: 'chore: hide b', author: 'Mallory', write: { [CONFIG]: JSON.stringify({ ignore: ['src/b.ts'] }) } });
    repo.commit({ message: 'feat: change a only', author: 'Mallory', write: { 'src/a.ts': 'export const a = 99;\n' } });
    prSha = repo.git('rev-parse', 'HEAD').trim();
    repo.git('checkout', '-q', 'main');

    branchWithConfig('bad-json', '100644', '{ "minShared": 4, ');
    branchWithConfig('bad-schema', '100644', JSON.stringify({ minShared: 4, notASetting: true }));
    branchWithConfig('bad-big', '100644', `{"ignore": [${' '.repeat(MAX_CONFIG_BYTES)}]}`);
    branchWithConfig('bad-symlink', '120000', 'elsewhere.json');
  });

  after(() => {
    repo.cleanup();
  });

  it('default: the working tree config applies and meta.config.source is "working-tree"', () => {
    repo.git('checkout', '-q', 'pr');
    try {
      const scan = json(['scan', '--kinds', 'all'], repo.dir);
      assert.equal(hasPair(scan, 'src/a.ts', 'src/b.ts'), false, "the PR's own config hides b.ts");
      assert.deepEqual(scan.meta.settings.ignore, ['src/b.ts']);
      assert.deepEqual(scan.meta.config, { source: 'working-tree' });
    } finally {
      repo.git('checkout', '-q', 'main');
    }
  });

  it('--no-config: a working-tree config that would ignore a file has no effect; meta.config.source is "none"', () => {
    repo.git('checkout', '-q', 'pr');
    try {
      const scan = json(['scan', '--kinds', 'all', '--no-config'], repo.dir);
      assert.equal(hasPair(scan, 'src/a.ts', 'src/b.ts'), true);
      assert.deepEqual(scan.meta.settings.ignore, []);
      assert.equal(scan.meta.settings.minShared, 3, 'defaults, not any config file');
      assert.deepEqual(scan.meta.config, { source: 'none' });

      const diff = json(['diff', '--no-config'], repo.dir);
      assert.deepEqual(diff.meta.config, { source: 'none' });
    } finally {
      repo.git('checkout', '-q', 'main');
    }
  });

  it('--config-from <base>: the base config applies even when the working tree config differs; meta.config records ref and SHA', () => {
    repo.git('checkout', '-q', 'pr');
    // A dirty edit on top of the PR config must not matter either.
    writeFileSync(join(repo.dir, CONFIG), JSON.stringify({ ignore: ['src/**'] }));
    try {
      const scan = json(['scan', '--kinds', 'all', '--config-from', 'main'], repo.dir);
      assert.equal(hasPair(scan, 'src/a.ts', 'src/b.ts'), true, 'base config does not hide b.ts');
      assert.equal(scan.meta.settings.minShared, 4, "base config's minShared applies");
      assert.deepEqual(scan.meta.settings.ignore, []);
      assert.deepEqual(scan.meta.config, { source: 'ref', ref: 'main', sha: mainSha });

      // Explicit CLI flags still override config values.
      const flagged = json(['scan', '--kinds', 'all', '--config-from', 'main', '--min-shared', '7'], repo.dir);
      assert.equal(flagged.meta.settings.minShared, 7);
      assert.equal(hasPair(flagged, 'src/a.ts', 'src/b.ts'), false, 'a and b share 6 commits (root + 5)');
    } finally {
      repo.git('checkout', '-q', '--force', 'main');
    }
  });

  it('--head <pr> --config-from <base>: the base config applies to the head analysis', () => {
    // Without --config-from, --head reads the PR's own tree and the omission is hidden.
    const prOwn = json(['diff', '--head', 'pr', '--base', 'main'], repo.dir);
    assert.deepEqual(prOwn.meta.config, { source: 'ref', ref: 'pr', sha: prSha });
    assert.equal(suggests(prOwn, 'src/b.ts'), false);

    const reviewed = json(['diff', '--head', 'pr', '--base', 'main', '--config-from', 'main'], repo.dir);
    assert.deepEqual(reviewed.meta.config, { source: 'ref', ref: 'main', sha: mainSha });
    assert.deepEqual(reviewed.meta.head, { ref: 'pr', sha: prSha });
    assert.equal(reviewed.meta.settings.minShared, 4);
    assert.ok(suggests(reviewed, 'src/b.ts'), `expected src/b.ts to be suggested, got ${JSON.stringify(reviewed.suggestions.map((s: { to: string }) => s.to))}`);

    const scan = json(['scan', '--kinds', 'all', '--head', 'pr', '--config-from', mainSha.slice(0, 10)], repo.dir);
    assert.deepEqual(scan.meta.config, { source: 'ref', ref: mainSha.slice(0, 10), sha: mainSha });
    assert.equal(hasPair(scan, 'src/a.ts', 'src/b.ts'), true);
  });

  it('--head <pr> --no-config reads no config at all', () => {
    const scan = json(['scan', '--kinds', 'all', '--head', 'pr', '--no-config'], repo.dir);
    assert.deepEqual(scan.meta.config, { source: 'none' });
    assert.equal(scan.meta.settings.minShared, 3);
    assert.equal(hasPair(scan, 'src/a.ts', 'src/b.ts'), true);
  });

  it('a ref without the file means no config (defaults apply, no warning)', () => {
    const scan = json(['scan', '--kinds', 'all', '--config-from', rootSha], repo.dir);
    assert.deepEqual(scan.meta.config, { source: 'ref', ref: rootSha, sha: rootSha });
    assert.equal(scan.meta.settings.minShared, 3);
    assert.ok(!scan.meta.warnings.some((w: string) => w.includes(CONFIG)), scan.meta.warnings.join('; '));
  });

  it('invalid config at the ref: invalid JSON, unknown setting, oversized file and symlink fail with the same errors as the working-tree file (exit 2)', (t) => {
    const workingTreeError = (prepare: () => boolean): string | undefined => {
      if (!prepare()) return undefined;
      try {
        const res = runCli(['scan', '--json', '--no-cache'], repo.dir);
        assert.equal(res.code, 2, res.stderr);
        return res.stderr;
      } finally {
        rmSync(join(repo.dir, CONFIG), { force: true });
        repo.git('checkout', '-q', '--', CONFIG);
      }
    };
    const cases: { branch: string; message: RegExp; prepare: () => boolean }[] = [
      {
        branch: 'bad-json',
        message: /\.repo-archaeology\.json is not valid JSON: /,
        prepare: () => (writeFileSync(join(repo.dir, CONFIG), '{ "minShared": 4, '), true),
      },
      {
        branch: 'bad-schema',
        message: /\.repo-archaeology\.json: unknown setting "notASetting"\./,
        prepare: () => (writeFileSync(join(repo.dir, CONFIG), JSON.stringify({ minShared: 4, notASetting: true })), true),
      },
      {
        branch: 'bad-big',
        message: /\.repo-archaeology\.json is larger than 64 KB\./,
        prepare: () => (writeFileSync(join(repo.dir, CONFIG), `{"ignore": [${' '.repeat(MAX_CONFIG_BYTES)}]}`), true),
      },
      {
        branch: 'bad-symlink',
        message: /\.repo-archaeology\.json must be a regular file, not a symlink or device\./,
        prepare: () => {
          rmSync(join(repo.dir, CONFIG), { force: true });
          try {
            symlinkSync('elsewhere.json', join(repo.dir, CONFIG));
            return true;
          } catch {
            return false; // no symlink permission (Windows): the ref side is still checked below
          }
        },
      },
    ];
    for (const item of cases) {
      const fromRef = runCli(['scan', '--json', '--no-cache', '--config-from', item.branch], repo.dir);
      assert.equal(fromRef.code, 2, `${item.branch}: ${fromRef.stderr}`);
      assert.equal(fromRef.stdout, '');
      assert.match(fromRef.stderr, item.message, item.branch);

      // With --head, an explicit --config-from fails closed instead of falling back to the working tree.
      const withHead = runCli(['scan', '--json', '--no-cache', '--head', 'pr', '--config-from', item.branch], repo.dir);
      assert.equal(withHead.code, 2, `${item.branch} with --head: ${withHead.stderr}`);
      assert.equal(withHead.stderr, fromRef.stderr);

      const fromWorkingTree = workingTreeError(item.prepare);
      if (fromWorkingTree === undefined) t.diagnostic(`${item.branch}: working-tree comparison skipped (cannot create symlinks here)`);
      else assert.equal(fromRef.stderr, fromWorkingTree, `${item.branch}: same error as the working-tree path`);
    }
  });

  it('--head <ref> alone keeps falling back to the working tree for an invalid file and reports "working-tree"', () => {
    const scan = json(['scan', '--head', 'bad-json'], repo.dir);
    assert.deepEqual(scan.meta.config, { source: 'working-tree' });
    assert.equal(scan.meta.settings.minShared, 4, "the working tree (main) config's minShared");
    assert.ok(scan.meta.warnings.some((w: string) => w.startsWith(`Ignoring invalid ${CONFIG} at bad-json`)));
  });

  it('an unknown or malformed ref is a usage error (exit 2)', () => {
    const unknown = runCli(['scan', '--json', '--config-from', 'no-such-branch'], repo.dir);
    assert.equal(unknown.code, 2);
    assert.equal(unknown.stdout, '');
    assert.match(unknown.stderr, /--config-from: "no-such-branch" is not a branch, tag or commit in this repository\./);

    const dashed = runCli(['scan', '--json', '--config-from=--output=x'], repo.dir);
    assert.equal(dashed.code, 2);
    assert.match(dashed.stderr, /Invalid --config-from revision "--output=x"/);

    const tree = runCli(['scan', '--json', '--config-from', `${mainSha}^{tree}`], repo.dir);
    assert.equal(tree.code, 2, 'a tree is not a commit');
    assert.match(tree.stderr, /is not a branch, tag or commit/);
  });

  it('--no-config together with --config-from is a usage error (exit 2) on every command', () => {
    for (const args of [['scan'], ['diff'], ['file', 'src/a.ts'], ['backtest'], ['imports'], ['map', '--no-open'], []]) {
      const res = runCli([...args, '--json', '--no-config', '--config-from', 'main'], repo.dir);
      assert.equal(res.code, 2, `${args.join(' ') || '(default)'}: ${res.stderr}`);
      assert.equal(res.stdout, '');
      assert.match(res.stderr, /--no-config and --config-from cannot be used together\./);
    }
  });

  it('library: configRef matches --config-from, and configRef with useConfigFile: false is a ConfigError', async () => {
    repo.git('checkout', '-q', 'pr');
    try {
      const repoSession = await openRepository({ cwd: repo.dir, configRef: 'main', settings: { cache: { enabled: false } } });
      try {
        const scan = await repoSession.scan({ kinds: ['ghost', 'unknown', 'indirect', 'direct'] });
        assert.deepEqual(scan.meta.config, { source: 'ref', ref: 'main', sha: mainSha });
        assert.equal(scan.meta.settings.minShared, 4);
        const cli = json(['scan', '--kinds', 'all', '--config-from', 'main'], repo.dir);
        delete (cli.meta as { cache?: unknown }).cache;
        const lib = structuredClone(scan) as unknown as { meta: { cache?: unknown } };
        delete lib.meta.cache;
        assert.deepEqual(lib, cli, 'library and CLI --json agree');
      } finally {
        await repoSession.close();
      }

      const none = await openRepository({ cwd: repo.dir, useConfigFile: false, settings: { cache: { enabled: false } } });
      try {
        assert.deepEqual((await none.scan()).meta.config, { source: 'none' });
      } finally {
        await none.close();
      }

      const def = await openRepository({ cwd: repo.dir, settings: { cache: { enabled: false } } });
      try {
        assert.deepEqual((await def.scan()).meta.config, { source: 'working-tree' });
      } finally {
        await def.close();
      }

      const headed = await openRepository({ cwd: repo.dir, head: 'pr', base: 'main', configRef: 'main', settings: { cache: { enabled: false } } });
      try {
        const diff = await headed.diff();
        assert.deepEqual(diff.meta.config, { source: 'ref', ref: 'main', sha: mainSha });
        assert.ok(suggests(diff, 'src/b.ts'));
      } finally {
        await headed.close();
      }
    } finally {
      repo.git('checkout', '-q', 'main');
    }

    await assert.rejects(openRepository({ cwd: repo.dir, configRef: 'main', useConfigFile: false }), ConfigError);
    await assert.rejects(loadContext(repo.dir, {}, { configRef: 'main', useConfigFile: false, silent: true }), ConfigError);
    await assert.rejects(openRepository({ cwd: repo.dir, configRef: 'no-such-branch' }), UsageError);
    await assert.rejects(openRepository({ cwd: repo.dir, configRef: 'bad-json' }), ConfigError);
  });
});
