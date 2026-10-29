// S7 task 4: sign the scripted owner in with the stack's software passkey (the product's test authenticator) and write the web session
// cookies to a 0600 file, for the headless browser. Run on the server:  EXSTACK_OWNER_FILE=<owner.json> bun --conditions=@exponetdb/source s7-webcookie.ts <out>
// (the file lives in packages/stack-kit of the stack's checkout while it runs; it imports ./human.ts). Prints only the cookie NAMES.
import { chmodSync, writeFileSync } from 'node:fs'
import { Human } from './human.ts'

const out = process.argv[2] ?? '/srv/work/s7/web-cookies.json'
const human = Human.load()
await human.signIn()
const jar = [...human.browser.jar].map(([name, value]) => ({ name, value }))
writeFileSync(out, JSON.stringify(jar), { mode: 0o600 })
chmodSync(out, 0o600)
console.log(JSON.stringify({ cookies: jar.map((c) => c.name) }))
