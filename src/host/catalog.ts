import { readdir, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Json } from './types.ts'
import { checkedPath } from './owner.ts'

/** List bounded KiCad files under deployment-owned roots without following symlinks. */
export async function designCatalog(roots: readonly string[]): Promise<Json> {
  const files: Json[] = []
  let visited = 0
  const canonical = await Promise.all(roots.map(root => realpath(root)))
  const inside = (path: string): boolean => canonical.some(root => {
    const rel = relative(root, path)
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  })
  const visit = async (directory: string, depth: number, root: string): Promise<void> => {
    if (depth > 4 || visited >= 2000 || files.length >= 400) return
    const actual = await realpath(directory)
    if (!inside(actual)) return
    const entries = await readdir(actual, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 2000 || files.length >= 400) return
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue
      const path = resolve(actual, entry.name)
      if (entry.isDirectory()) await visit(path, depth + 1, root)
      else if (entry.isFile()) {
        const extension = extname(entry.name).toLowerCase()
        const kind = extension === '.kicad_pro' ? 'project' : extension === '.kicad_sch' ? 'schematic' : extension === '.kicad_pcb' ? 'board' : undefined
        if (kind === undefined) continue
        const checked = await checkedPath(path, canonical, 'file')
        files.push({ path: checked, name: basename(checked), directory: dirname(checked), relativePath: relative(root, checked), kind })
      }
    }
  }
  for (const root of canonical) await visit(root, 0, root)
  return { files, defaultOutput: canonical[0] ? resolve(canonical[0], 'runs') : '' }
}
