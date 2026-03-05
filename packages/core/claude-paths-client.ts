// Client-safe utility functions (no Node.js imports)

export function decodeProjectName(encoded: string): string {
  const parts = encoded.replace(/^-/, '').split('-');
  const gitIdx = parts.lastIndexOf('git');
  if (gitIdx >= 0 && gitIdx < parts.length - 1) {
    return parts.slice(gitIdx + 1).join('-');
  }
  return parts.slice(-2).join('-') || encoded;
}
