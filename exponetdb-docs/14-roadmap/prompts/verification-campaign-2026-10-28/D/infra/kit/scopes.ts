/** Prints every scope the first-party CLI may hold, space separated (the stack's admin session asks for all). */
import { isScopeGrantableTo, SCOPE_IDS } from '@exponetdb/contracts'

console.log(SCOPE_IDS.filter((s) => isScopeGrantableTo(s, 'cli')).join(' '))
