import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Prompts live as `.md` next to this module so they can be edited and reviewed as
 * prose rather than as escaped string literals — the thesis prompt is the most
 * load-bearing part of this project and gets iterated on constantly.
 *
 * `npm run build` copies `src/llm/prompts/` into `dist/llm/prompts/`; this
 * resolves relative to the compiled file either way.
 */
const here = dirname(fileURLToPath(import.meta.url))

const cache = new Map<string, string>()

export function prompt(name: 'triage' | 'thesis'): string {
  const cached = cache.get(name)
  if (cached) return cached
  const text = readFileSync(join(here, 'prompts', `${name}.md`), 'utf8')
  cache.set(name, text)
  return text
}
