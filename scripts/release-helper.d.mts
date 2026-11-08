export interface ParsedReleaseTag {
  tag: string;
  version: string;
  prereleaseId: string | null;
  isPrerelease: boolean;
  npmDistTag: 'latest' | 'next';
}

export interface ChangelogSection {
  version: string;
  date: string;
  body: string;
}

export interface PrepareReleaseOptions {
  tag: string;
  pkgJsonPath?: string;
  changelogPath?: string;
  notesOutPath?: string;
  githubOutputPath?: string;
}

export interface PrepareReleaseResult extends ParsedReleaseTag {
  packageName: string;
  date: string;
  body: string;
}

export interface TarballDigests {
  shasum: string;
  integrity: string;
}

export type PublishedArtifactState =
  | { status: 'not-published' }
  | { status: 'already-published-matching'; integrity: string; shasum: string };

export type PublishOrSkipResult =
  | { status: 'published'; integrity: string; shasum: string }
  | { status: 'already-published-matching'; integrity: string; shasum: string };

export function parseReleaseTag(rawTag: string): ParsedReleaseTag;

export function extractChangelogSection(changelogText: string, version: string): ChangelogSection;

export function prepareRelease(options: PrepareReleaseOptions): PrepareReleaseResult;

export function computeTarballDigests(tarballPath: string): TarballDigests;

export function evaluatePublishedArtifact(options: {
  packageName: string;
  version: string;
  localDigests: TarballDigests;
  registryDist: { integrity?: unknown; shasum?: unknown } | null | undefined;
}): PublishedArtifactState;

export function publishOrSkip(options: {
  tarballPath: string;
  packageName: string;
  version: string;
  distTag: string;
  provenance?: boolean;
  dryRun?: boolean;
  queryDistFn?: (
    packageName: string,
    version: string,
  ) => { integrity?: unknown; shasum?: unknown } | null;
  runPublishFn?: (args: string[]) => { status: number | null; stdout?: string; stderr?: string };
}): PublishOrSkipResult;

export function resolveNpmCliJs(env?: NodeJS.ProcessEnv): string | undefined;
