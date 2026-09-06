'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/', label: 'Book' },
  { href: '/record', label: 'P&L' },
]

/**
 * The only client component on the site. It exists for `aria-current`: the
 * layout renders once for every route and cannot know which one it is wrapping,
 * and a lit tab is worth a few hundred bytes of JavaScript. Everything else here
 * is server-rendered HTML.
 */
export function Nav() {
  const pathname = usePathname()
  return (
    <nav className="tabs">
      {LINKS.map(({ href, label }) => (
        <Link key={href} href={href} aria-current={pathname === href ? 'page' : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  )
}
