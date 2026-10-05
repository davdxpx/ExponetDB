import type { ControlStore } from '@exponetdb/control-store'
import type { Clock } from '@exponetdb/kernel'
import type { Keyring } from '@exponetdb/secrets'
import type { AuthConfig } from './config.ts'
import type { InstallationKeys } from './keys.ts'
import type { NotificationChannel } from './notifications.ts'

/**
 * What the auth services need from the process that hosts them (serve):
 * the Control Store under the serve login, the keyring for the `auth`
 * consumer's secrets, the clock for ids, the trusted configuration, the
 * installation keys for keyed pseudonyms and the notification channel
 * (absent when none is configured; delivery is then reported as such).
 */
export interface AuthDeps {
  readonly store: ControlStore
  readonly keyring: Keyring
  readonly clock: Clock
  readonly config: AuthConfig
  readonly keys: InstallationKeys
  readonly channel: NotificationChannel | undefined
}

export type { RequestMeta } from './request.ts'
