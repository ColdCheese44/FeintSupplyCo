import path from "node:path";

export const PROJECT_ROOT = path.resolve(process.cwd());

/**
 * Resolves a stored asset path against the active project root and repairs stale absolute roots when possible.
 */
export function resolveAssetPath(storedPath: string): string {
  if (!storedPath) {
    return storedPath;
  }

  if (!path.isAbsolute(storedPath)) {
    return path.join(PROJECT_ROOT, storedPath);
  }

  if (storedPath.startsWith(PROJECT_ROOT)) {
    return storedPath;
  }

  const dataMatch = storedPath.match(/[\\/]data[\\/](.+)$/);
  if (dataMatch) {
    return path.join(PROJECT_ROOT, "data", dataMatch[1]);
  }

  return storedPath;
}

/**
 * Converts an absolute in-project path to a repo-relative form before storing it in SQLite metadata.
 */
export function toRelativePath(absolutePath: string): string {
  if (!absolutePath) {
    return absolutePath;
  }

  if (absolutePath.startsWith(PROJECT_ROOT)) {
    return path.relative(PROJECT_ROOT, absolutePath);
  }

  const dataMatch = absolutePath.match(/[\\/]data[\\/](.+)$/);
  if (dataMatch) {
    return path.join("data", dataMatch[1]);
  }

  return absolutePath;
}
