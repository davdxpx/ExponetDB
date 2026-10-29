/** S4: sign the owner in (cookie session, CSRF), write the session cookie values to $S4/sessions.json (0600) as canaries, then use the session. */
import { writeFileSync } from 'node:fs'
import { Human } from '../human.ts'
const S4 = process.env['S4'] ?? '/srv/work/s4'
const h = Human.load()
await h.signIn()
const jar: Record<string, string> = {}
for (const [k, v] of h.browser.jar) if (v.length >= 20) jar[k.replace(/[^A-Za-z0-9]/g, '')] = v
writeFileSync(`${S4}/sessions.json`, JSON.stringify(jar), { mode: 0o600 })
await h.reauth()
for (const p of ['/api/v1/me', '/api/v1/me/sessions', '/api/v1/me/factors', '/api/v1/targets', '/api/v1/audit-events?limit=100']) await h.call('GET', p)
console.log(JSON.stringify({ cookies: Object.keys(jar).length }))
