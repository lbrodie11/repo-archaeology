import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sanitizeGitEnv } from '../scripts/schema-validator.mjs';

export interface FixtureCommit {
  message: string;
  /** path -> new content, or null to delete the file. */
  write?: Record<string, string | null>;
  /** [from, to] pairs moved with `git mv` before writing. */
  move?: [string, string][];
  /** Days after the first commit (controls author and committer dates). */
  day?: number;
  author?: string;
  email?: string;
}

const BASE_TIME = Date.UTC(2024, 0, 1) / 1000;

export class FixtureRepo {
  readonly dir: string;
  private day = 0;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'repo-archaeology-test-'));
    this.git('init', '-q', '-b', 'main');
    this.git('config', 'user.email', 'test@example.com');
    this.git('config', 'user.name', 'Test');
    this.git('config', 'commit.gpgsign', 'false');
  }

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, encoding: 'utf8', env: sanitizeGitEnv(process.env) });
  }

  write(path: string, content: string): void {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  commit(spec: FixtureCommit): this {
    for (const [from, to] of spec.move ?? []) {
      mkdirSync(dirname(join(this.dir, to)), { recursive: true });
      this.git('mv', from, to);
    }
    for (const [path, content] of Object.entries(spec.write ?? {})) {
      if (content === null) this.git('rm', '-q', path);
      else {
        this.write(path, content);
        this.git('add', '--', path);
      }
    }
    const day = spec.day ?? this.day++;
    this.day = Math.max(this.day, day + 1);
    const date = `${BASE_TIME + day * 86400} +0000`;
    const author = spec.author ?? 'Test';
    const email = spec.email ?? `${author.toLowerCase().replace(/\W+/g, '.')}@example.com`;
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', spec.message, `--author=${author} <${email}>`], {
      cwd: this.dir,
      env: sanitizeGitEnv(process.env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
    });
    return this;
  }

  /** Commits that touch every listed file with fresh content. */
  touch(files: string[], message = `change ${files.join(' ')}`, extra: Partial<FixtureCommit> = {}): this {
    const write: Record<string, string> = {};
    for (const f of files) write[f] = `${f} ${this.day} ${Math.random()}\n`;
    return this.commit({ message, write, ...extra });
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
