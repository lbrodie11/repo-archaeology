/** RA-18 corpora, exactly as preregistered in docs/research/surface-pilot.md §3. */
import type { PositiveKind } from './mutate.js';

export interface CorpusRepo {
  id: string;
  url: string;
  pin: string;
  corpusA: boolean;
  corpusB?: { horizon: string; prs: 'gutter-stage0' | 'squash-subjects' };
  positiveKinds: readonly PositiveKind[];
  /** Oracle defaults when the repository has no root tsconfig. */
  commonJs?: boolean;
}

export const CORPORA: readonly CorpusRepo[] = [
  {
    id: 'hono',
    url: 'https://github.com/honojs/hono.git',
    pin: 'eb754bd5ef22c63f1634a4c374a86be086f85710',
    corpusA: true,
    corpusB: { horizon: '61f7c59e50244ab4d2dd83c151928cf7ea448510', prs: 'gutter-stage0' },
    positiveKinds: ['remove-export', 'add-required-param', 'add-required-prop'],
  },
  {
    id: 'eslint',
    url: 'https://github.com/eslint/eslint.git',
    pin: '11c66ba08381cb7cff7679d662c9f6654b6fe712',
    corpusA: true,
    corpusB: { horizon: '0146008d6e99aa31dc62153c200e714f5afdcd0e', prs: 'squash-subjects' },
    positiveKinds: ['remove-export', 'add-required-param'],
    commonJs: true,
  },
  {
    id: 'vue-core',
    url: 'https://github.com/vuejs/core.git',
    pin: '8b479a89445868d474f17e2d837765e7c9ece5e4',
    corpusA: true,
    positiveKinds: ['remove-export', 'add-required-param', 'add-required-prop'],
  },
];

export const PRS_PER_REPO = 200;
export const FOLLOW_UP_DAYS = 7;
