export function assertPackedFileList(files: Array<string | { path?: string }>): void;

export function runSmokePack(options?: {
  packOutDir?: string;
  repoDir?: string;
}): {
  filename: string;
  tarballPath?: string;
  filesCount: number;
};
