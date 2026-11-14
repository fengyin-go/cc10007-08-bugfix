/**
 * 测试用 ESM loader：
 * 1. 把 Vite 的 `@/` 别名映射到 src/；
 * 2. 为无扩展名的相对/别名导入尝试 .ts 与 /index.ts，配合 --experimental-strip-types 运行。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolvePath(here, '..', 'src')

function resolveWithExtension(basePath) {
  const candidates = [basePath, `${basePath}.ts`, `${basePath}.vue`, resolvePath(basePath, 'index.ts')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) {
      return pathToFileURL(candidate).href
    }
  }
  return null
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const basePath = resolvePath(srcRoot, specifier.slice(2))
    const resolved = resolveWithExtension(basePath)
    if (resolved) {
      return nextResolve(resolved, context)
    }
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const parentDir = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd()
    const basePath = resolvePath(parentDir, specifier)
    const resolved = resolveWithExtension(basePath)
    if (resolved) {
      return nextResolve(resolved, context)
    }
  }
  return nextResolve(specifier, context)
}
