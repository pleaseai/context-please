import * as path from 'node:path'

/**
 * Truncate content to specified length
 */
export function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content
  }
  return `${content.substring(0, maxLength)}...`
}

/**
 * Ensure path is absolute. If relative path is provided, resolve it properly.
 */
export function ensureAbsolutePath(inputPath: string): string {
  // If already absolute, return as is
  if (path.isAbsolute(inputPath)) {
    return inputPath
  }

  // For relative paths, resolve to absolute path
  const resolved = path.resolve(inputPath)
  return resolved
}

export function trackCodebasePath(codebasePath: string): void {
  const absolutePath = ensureAbsolutePath(codebasePath)
  console.log(`[TRACKING] Tracked codebase path: ${absolutePath} (not marked as indexed)`)
}

/**
 * Resolve a portable collection key from an absolute path and optional base_path.
 *
 * When basePath is provided, validates that it is an absolute path and a parent
 * of absolutePath, then returns the relative path between them. This relative key
 * is machine-independent and produces deterministic collection hashes across
 * different environments.
 *
 * When basePath is omitted, returns absolutePath unchanged (current behavior).
 *
 * @param absolutePath The resolved absolute path to the codebase directory
 * @param basePath Optional absolute path prefix to strip for portable naming
 * @returns The portable key (relative path) or the absolutePath if no basePath
 * @throws Error if basePath is not absolute or is not a parent of absolutePath
 */
export function resolvePortableKey(absolutePath: string, basePath?: string): string {
  if (!basePath) {
    return absolutePath
  }

  if (!path.isAbsolute(basePath)) {
    throw new Error(`base_path must be an absolute path. Received: '${basePath}'`)
  }

  // Normalize both paths to remove trailing slashes and resolve symlinks
  const normalizedBase = path.resolve(basePath)
  const normalizedAbsolute = path.resolve(absolutePath)

  // Verify basePath is a parent of absolutePath
  const relative = path.relative(normalizedBase, normalizedAbsolute)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `base_path '${basePath}' is not a parent directory of path '${absolutePath}'. `
      + `The relative resolution was '${relative}'.`,
    )
  }

  if (relative === '') {
    throw new Error(
      `base_path '${basePath}' and path '${absolutePath}' resolve to the same directory. `
      + `base_path must be a parent directory of path.`,
    )
  }

  return relative
}
