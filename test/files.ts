// Read a project file in tests (paths relative to the project root, the vitest cwd).
// node:fs is imported dynamically with a local type, like test/sqlite-d1.ts: no @types/node needed.
export async function readText(path: string): Promise<string> {
  const { readFileSync } = (await import('node:fs' as string)) as { readFileSync: (p: string, enc: 'utf8') => string };
  return readFileSync(path, 'utf8');
}
