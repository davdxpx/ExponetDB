import { cn } from '@exponetdb/ui'
import { type ReactNode, useState } from 'react'
import { type AvatarRef, avatarSrcOf, initialsOf } from './profile-model.ts'

/**
 * A person's picture, or their initials in a neutral tile. The picture is
 * loaded only from the same-origin path the server named (`avatarSrcOf`),
 * with an empty `alt` (the name is always beside it) and never from a
 * remote address. A picture that fails to load falls back to the initials.
 */
export function ProfileAvatar({
  avatar,
  name,
  src,
  size = 'md',
  className,
}: {
  readonly avatar?: AvatarRef | null | undefined
  /** The name or address the initials come from (untrusted; only letters and digits are used). */
  readonly name: string
  /** A `data:` URL of a picture chosen but not saved yet (the preview); wins over `avatar`. */
  readonly src?: string | undefined
  readonly size?: 'sm' | 'md' | 'lg'
  readonly className?: string
}): ReactNode {
  const address = src ?? avatarSrcOf(avatar)
  const [failed, setFailed] = useState<string | undefined>(undefined)
  const box =
    size === 'sm' ? 'size-7 text-xs' : size === 'lg' ? 'size-24 text-2xl' : 'size-10 text-sm'
  const showPicture = address !== undefined && failed !== address
  return (
    <span
      data-slot="profile-avatar"
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-default bg-surface-200 font-medium text-foreground-light',
        box,
        className,
      )}
    >
      {showPicture ? (
        <img
          src={address}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(address)}
        />
      ) : (
        <span aria-hidden="true">{initialsOf(name)}</span>
      )}
    </span>
  )
}
