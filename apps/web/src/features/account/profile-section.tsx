import { Button, Input } from '@exponetdb/ui'
import { ConfirmDialog } from '@exponetdb/ui-patterns'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { RawBody } from '../../lib/api/client.ts'
import { useApi } from '../../lib/api/context.tsx'
import { ApiError } from '../../lib/api/errors.ts'
import { t } from '../../lib/i18n/i18n.ts'
import type { Feedback } from '../sign-in/feedback.tsx'
import { ProfileAvatar } from './avatar.tsx'
import {
  AVATAR_PATH,
  AVATAR_TYPES,
  checkAvatarFile,
  DISPLAY_NAME_MAX,
  displayNameOf,
  PROFILE_PATH,
  type ProfileMe,
  type ProfileView,
  profileRevisionOf,
  reasonSentence,
  refusalOf,
} from './profile-model.ts'
import { AccountCard, AccountSection, CardRow } from './section.tsx'
import type { AccountWriter } from './writer.ts'

/**
 * The profile of the signed-in person (identity.md §12): the display name
 * they chose (`PUT /me/profile` at the revision they read; a stale revision
 * is a `409`, answered with a note and a fresh read) and the profile picture
 * (`PUT /me/avatar` with the raw bytes and the file's exact type,
 * `DELETE /me/avatar` behind a confirmation). A file is checked in the
 * browser first (type and 256 KiB; nothing is sent when it fails); the
 * server's refusal reasons are shown as sentences. The preview of a chosen
 * file is a `data:` URL (the page's `img-src` allows `'self' data:` and no
 * `blob:`), and the saved picture loads from the server's same-origin path.
 */
export function ProfileSection({
  me,
  writer,
  feedback,
}: {
  readonly me: ProfileMe
  readonly writer: AccountWriter
  readonly feedback: Feedback
}): ReactNode {
  return (
    <>
      <NameSection
        // A new revision (after a save, or a change made elsewhere) resets the field to the stored name.
        key={profileRevisionOf(me)}
        me={me}
        writer={writer}
        feedback={feedback}
      />
      <PictureSection me={me} writer={writer} feedback={feedback} />
    </>
  )
}

function NameSection({
  me,
  writer,
  feedback,
}: {
  readonly me: ProfileMe
  readonly writer: AccountWriter
  readonly feedback: Feedback
}): ReactNode {
  const { client } = useApi()
  const inputId = useId()
  const hintId = useId()
  const [name, setName] = useState(me.displayName ?? '')
  const revision = profileRevisionOf(me)
  const busy = writer.busy === 'profile-name'

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const text = name.trim()
    if (Array.from(text).length > DISPLAY_NAME_MAX) {
      feedback.warn(t('profile.name.tooLong'))
      return
    }
    writer.write('profile-name', async (reauth) => {
      try {
        await reauth(() =>
          client.send<ProfileView>('PUT', PROFILE_PATH, {
            displayName: text === '' ? null : text,
            revision,
          }),
        )
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          feedback.warn(t('profile.name.conflict'))
          return undefined
        }
        throw error
      }
      return text === '' ? t('profile.name.cleared') : t('profile.name.saved')
    })
  }

  return (
    <AccountSection title={t('profile.name.heading')}>
      <form id="profile-name-form" onSubmit={submit}>
        <AccountCard
          footer={
            <Button
              type="submit"
              variant="primary"
              size="small"
              loading={busy}
              disabled={writer.busy !== undefined && !busy}
            >
              {t('profile.name.save')}
            </Button>
          }
        >
          <CardRow
            label={t('profile.name.label')}
            htmlFor={inputId}
            description={t('profile.name.hint')}
            descriptionId={hintId}
          >
            <Input
              id={inputId}
              name="displayName"
              autoComplete="nickname"
              value={name}
              aria-describedby={hintId}
              onChange={(event) => setName(event.target.value)}
            />
          </CardRow>
        </AccountCard>
      </form>
    </AccountSection>
  )
}

function readAsDataUrl(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined)
    reader.onerror = () => resolve(undefined)
    reader.readAsDataURL(file)
  })
}

function PictureSection({
  me,
  writer,
  feedback,
}: {
  readonly me: ProfileMe
  readonly writer: AccountWriter
  readonly feedback: Feedback
}): ReactNode {
  const { client } = useApi()
  const inputId = useId()
  const hintId = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const [chosen, setChosen] = useState<{ file: File; preview: string | undefined } | undefined>(
    undefined,
  )
  const hasPicture = me.avatar !== null && me.avatar !== undefined
  const name = displayNameOf(me)
  const uploading = writer.busy === 'avatar-upload'

  const reset = (): void => {
    setChosen(undefined)
    if (fileInput.current !== null) fileInput.current.value = ''
  }

  const choose = (file: File | undefined): void => {
    if (file === undefined) {
      setChosen(undefined)
      return
    }
    const reason = checkAvatarFile(file)
    if (reason !== undefined) {
      // Refused here: nothing is sent, nothing is previewed.
      feedback.warn(reasonSentence(reason))
      reset()
      return
    }
    feedback.clear()
    setChosen({ file, preview: undefined })
    void readAsDataUrl(file).then((preview) =>
      setChosen((current) => (current?.file === file ? { file, preview } : current)),
    )
  }

  const upload = (): void => {
    if (chosen === undefined) return
    const { file } = chosen
    writer.write('avatar-upload', async (reauth) => {
      try {
        await reauth(() =>
          client.sendRaw<ProfileView>('PUT', AVATAR_PATH, new RawBody(file, file.type)),
        )
      } catch (error) {
        const sentence = refusalOf(error)
        if (sentence === undefined) throw error
        feedback.warn(sentence)
        return undefined
      }
      reset()
      return t('profile.picture.uploaded')
    })
  }

  const remove = (): void =>
    writer.write('avatar-remove', async (reauth) => {
      await reauth(() => client.send<ProfileView>('DELETE', AVATAR_PATH))
      return t('profile.picture.removed')
    })

  return (
    <AccountSection title={t('profile.picture.heading')}>
      <AccountCard
        footer={
          <>
            {hasPicture ? (
              <ConfirmDialog
                trigger={
                  <Button
                    type="button"
                    variant="default"
                    size="small"
                    disabled={writer.busy !== undefined}
                  >
                    {t('profile.picture.remove')}
                  </Button>
                }
                title={t('profile.picture.remove.title')}
                description={t('profile.picture.remove.description')}
                actionLabel={t('profile.picture.remove.action')}
                destructive
                onConfirm={remove}
              />
            ) : null}
            <Button
              type="button"
              variant="primary"
              size="small"
              loading={uploading}
              disabled={chosen === undefined || (writer.busy !== undefined && !uploading)}
              onClick={upload}
            >
              {t('profile.picture.upload')}
            </Button>
          </>
        }
      >
        <CardRow label={t('profile.picture.shown')}>
          <div className="flex flex-wrap items-center gap-4">
            <ProfileAvatar avatar={me.avatar} name={name} size="lg" />
            <p id="avatar-state" className="max-w-md text-sm text-foreground-light">
              {hasPicture ? t('profile.picture.current') : t('profile.picture.none')}
            </p>
          </div>
        </CardRow>
        <CardRow
          label={t('profile.picture.label')}
          htmlFor={inputId}
          description={t('profile.picture.hint')}
          descriptionId={hintId}
        >
          <input
            ref={fileInput}
            id={inputId}
            type="file"
            accept={AVATAR_TYPES.join(',')}
            aria-describedby={hintId}
            className="block w-full text-sm text-foreground-light file:mr-3 file:rounded-md file:border file:border-default file:bg-surface-100 file:px-3 file:py-1.5 file:text-sm file:text-foreground"
            onChange={(event) => choose(event.target.files?.[0])}
          />
          {chosen?.preview === undefined ? null : (
            <div className="flex items-center gap-3">
              <ProfileAvatar name={name} src={chosen.preview} size="lg" />
              <span className="text-sm text-foreground-light">{t('profile.picture.preview')}</span>
            </div>
          )}
        </CardRow>
      </AccountCard>
    </AccountSection>
  )
}
