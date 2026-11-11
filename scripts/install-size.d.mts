/** `name@version` of every package under a `node_modules` (including nested and scoped ones). */
export function installedPackages(nm: string): string[];
/** Apparent bytes and file count of a directory tree (symlinks not followed). */
export function measureTree(dir: string): { bytes: number; files: number };
