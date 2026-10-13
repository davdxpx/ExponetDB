// Derived from supabase/supabase packages/ui/src/components/TreeView/TreeView.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { ChevronRight, Dot, FolderClosed, FolderOpen, Loader2 } from '@exponetdb/icons'
import { cva, type VariantProps } from 'class-variance-authority'
import {
  type ComponentPropsWithoutRef,
  type FocusEvent,
  forwardRef,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import TreeViewPrimitive, {
  flattenTree,
  type INodeRendererProps,
  type ITreeViewProps,
} from 'react-accessible-treeview'

import { Input } from './input.tsx'
import { cn } from './lib/utils.ts'

type TreeViewProps = ITreeViewProps & {
  /** Names the tree. One of the two is needed, as for any `role="tree"`. */
  'aria-label'?: string
  'aria-labelledby'?: string
}

/**
 * The tree of `react-accessible-treeview` (MIT): `ul[role=tree]`, a `li[role=treeitem]` per branch
 * and a `div[role=treeitem]` per leaf, with `aria-level`, `aria-setsize`, `aria-posinset`,
 * `aria-expanded` and roving focus on the arrow keys. `TreeViewItem` renders what goes inside.
 * Extra props such as `aria-label` reach the `ul`.
 */
const TreeView = forwardRef<HTMLUListElement, TreeViewProps>((props, ref) => (
  <TreeViewPrimitive ref={ref} {...props} />
))
TreeView.displayName = 'TreeView'

const CHEVRON_ICON_SIZE = 14
const ENTITY_ICON_SIZE = 16
// Focus that arrives this soon after editing starts is a menu closing, not the person leaving.
const ACCIDENTAL_BLUR_MS = 400

export type TreeViewItemVariantProps = VariantProps<typeof TreeViewItemVariant>
export const TreeViewItemVariant = cva(
  // `data-selected` and `data-state` carry the state for styling: a branch row is not itself the
  // treeitem (the library renders that `li` around it), so `aria-*` cannot be used on it.
  'group relative transition-colors h-[28px] flex items-center gap-3 text-sm cursor-pointer select-none text-foreground-light hover:bg-control data-[state=open]:bg-transparent',
  {
    variants: {
      isSelected: {
        true: 'text-foreground bg-selection!',
        false: '',
      },
      isOpened: {
        true: 'bg-control',
        false: '',
      },
      isPreview: {
        true: 'bg-control text-foreground',
        false: '',
      },
    },
  },
)

/** Props `react-accessible-treeview` hands to the node renderer that the row does not render. */
interface TreeViewRendererProps {
  isDisabled?: boolean
  isHalfSelected?: boolean
  handleSelect?: unknown
  handleExpand?: unknown
  treeState?: unknown
  dispatch?: unknown
  setsize?: number
  posinset?: number
  /** From `getNodeProps()` on a leaf; the state is `aria-disabled`. */
  disabled?: boolean
}

type TreeViewItemProps = Omit<ComponentPropsWithoutRef<'div'>, 'children'> &
  TreeViewRendererProps & {
    /** The level of the item in the tree */
    level: number
    /** Specifies if the item is expanded */
    isExpanded?: boolean
    /** Specifies if the item is opened somewhere */
    isOpened?: boolean
    /** Specifies if the item is a preview */
    isPreview?: boolean
    /** Specifies if the item is a branch */
    isBranch?: boolean
    /** The padding for each level of the item */
    levelPadding?: number
    /** Specifies if the item is selected */
    isSelected?: boolean
    /** The horizontal padding of the item */
    xPadding?: number
    /** Name of the entity; rendered as text. */
    name: string | ReactNode
    /** Optional description of the entity, shown with the name as a tooltip. */
    description?: string
    /** Text for the tooltip and the rename field when `name` is not a string */
    nameForTitle?: string
    /** Icon of a leaf */
    icon?: ReactNode
    /** Specifies if the item is being renamed, shows an input */
    isEditing?: boolean
    /** Accessible name of the rename input */
    editLabel?: string
    /** Called with the new name when the rename is submitted (or with the old one when it is cancelled) */
    onEditSubmit?: (value: string) => void
    /** For asynchronous loading */
    isLoading?: boolean
    /** Actions to render on the right end of the item */
    actions?: ReactNode
  }

const TreeViewItem = forwardRef<HTMLDivElement, TreeViewItemProps>(
  (
    {
      level = 1,
      levelPadding = 38,
      isExpanded = false,
      isOpened = false,
      isBranch = false,
      isSelected = false,
      isPreview = false,
      isLoading = false,
      xPadding = 16,
      name = '',
      description,
      nameForTitle,
      icon,
      isEditing = false,
      editLabel = 'Name',
      onEditSubmit,
      actions,
      // Renderer props that must not reach the DOM.
      isDisabled: _isDisabled,
      isHalfSelected: _isHalfSelected,
      handleSelect: _handleSelect,
      handleExpand: _handleExpand,
      treeState: _treeState,
      dispatch: _dispatch,
      setsize: _setsize,
      posinset: _posinset,
      disabled: _disabled,
      className,
      style,
      ...divProps
    },
    ref,
  ) => {
    const nameString = nameForTitle ?? (typeof name === 'string' ? name : '')
    const [localValueState, setLocalValueState] = useState(nameString)
    const inputRef = useRef<HTMLInputElement>(null)
    const editStartedAt = useRef(0)

    useEffect(() => {
      if (!isEditing) return

      // Focus the field at once and select the name. A menu that started the rename gives focus
      // back as it closes and would end the rename; so focus is taken again once the menu is gone,
      // and a blur that comes early is ignored (see handleBlur).
      editStartedAt.current = Date.now()
      const input = inputRef.current
      input?.focus()
      input?.select()
      const refocusTimer = window.setTimeout(() => {
        if (inputRef.current && document.activeElement !== inputRef.current) {
          inputRef.current.focus()
          inputRef.current.select()
        }
      }, 200)

      return () => window.clearTimeout(refocusTimer)
    }, [isEditing])

    useEffect(() => {
      if (!isEditing && !isLoading) {
        setLocalValueState(nameString)
      }
    }, [isEditing, isLoading, nameString])

    const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
      if (Date.now() - editStartedAt.current < ACCIDENTAL_BLUR_MS) {
        e.preventDefault()
        inputRef.current?.focus()
      } else {
        onEditSubmit?.(localValueState)
      }
    }

    const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      onEditSubmit?.(localValueState)
    }

    const trimmedDescription = description?.trim()
    const titleText = trimmedDescription ? `${nameString}\n${trimmedDescription}` : nameString
    // A leaf is the treeitem itself and states its selection; a branch row sits inside the
    // library's `li[role=treeitem]`, which carries `aria-expanded` and `aria-selected`.
    const isChecked = 'aria-checked' in divProps
    const leafSelected = !isBranch && !isChecked ? isSelected : undefined

    return (
      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: a leaf row is the treeitem; the library's getNodeProps() sets role="treeitem" on it at run time, and a branch row gets no aria-selected
      <div
        ref={ref}
        title={titleText || undefined}
        {...divProps}
        aria-selected={leafSelected}
        data-selected={isSelected || undefined}
        data-state={isBranch ? (isExpanded ? 'open' : 'closed') : undefined}
        className={cn(
          TreeViewItemVariant({ isSelected, isOpened, isPreview }),
          !!actions && 'pr-2',
          !isEditing && !!actions && 'justify-between',
          className,
        )}
        style={{
          paddingLeft: xPadding + ((level - 1) * levelPadding) / 2,
          ...style,
        }}
        data-treeview-is-branch={isBranch}
        data-treeview-level={level}
      >
        {Array.from({ length: level - 1 }, (_, guide) => guide).map((guide) => (
          <div
            key={guide}
            aria-hidden="true"
            style={{
              left: xPadding + (guide * levelPadding) / 2 + CHEVRON_ICON_SIZE / 2,
            }}
            className="absolute h-full w-px bg-border-strong"
          />
        ))}

        {isSelected && (
          <div aria-hidden="true" className="absolute left-0 h-full w-0.5 bg-foreground" />
        )}

        <div className="flex items-center gap-x-3 truncate">
          {isBranch ? (
            <>
              {isLoading ? (
                <Loader2
                  aria-hidden="true"
                  className={cn('text-foreground-muted animate-spin motion-reduce:animate-none')}
                  size={14}
                />
              ) : (
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    'text-foreground-muted',
                    'group-data-[selected]:text-foreground-light',
                    'group-data-[state=open]:text-foreground-light',
                    'transition-transform duration-200 motion-reduce:transition-none',
                    'group-data-[state=open]:rotate-90',
                  )}
                  size={CHEVRON_ICON_SIZE}
                  strokeWidth={1.5}
                />
              )}
              <TreeViewFolderIcon
                aria-hidden="true"
                className={cn(
                  'transition-colors',
                  ' text-foreground-muted',
                  'group-data-[selected]:text-foreground-light',
                  'group-data-[state=open]:text-foreground-light',
                )}
                isOpen={isExpanded}
                size={ENTITY_ICON_SIZE}
                strokeWidth={1.5}
              />
            </>
          ) : (
            icon || (
              <Dot
                aria-hidden="true"
                className={cn(
                  'transition-colors',
                  'text-foreground-muted',
                  'group-data-[selected]:text-foreground',
                  'w-5 h-5 shrink-0',
                )}
                size={ENTITY_ICON_SIZE}
                strokeWidth={1.5}
              />
            )
          )}
          {!isEditing && <span className="truncate text-sm">{name}</span>}
        </div>

        {!isEditing && actions}

        {isEditing && (
          <form onSubmit={handleSubmit}>
            <Input
              ref={inputRef}
              aria-label={editLabel}
              // A click in the field must not reach the row: the row would select itself and take
              // focus, which ends the rename.
              onClick={(event) => event.stopPropagation()}
              onChange={(e) => {
                setLocalValueState(e.target.value)
              }}
              onBlur={handleBlur}
              onKeyDownCapture={(e) => {
                // The keys of the field must not reach the tree (arrows, type-ahead). Enter ends the
                // edit through the blur; Escape puts the old name back.
                if (e.key === 'Enter') {
                  inputRef.current?.blur()
                } else if (e.key === 'Escape') {
                  setLocalValueState(nameString)
                  onEditSubmit?.(nameString)
                } else {
                  e.stopPropagation()
                }
              }}
              className="block w-full text-sm px-2 py-1 h-7"
              value={localValueState}
            />
          </form>
        )}
      </div>
    )
  },
)
TreeViewItem.displayName = 'TreeViewItem'

interface IconSVGProps extends Omit<React.SVGProps<SVGSVGElement>, 'ref'> {
  size?: number
}

const TreeViewFolderIcon = forwardRef<SVGSVGElement, IconSVGProps & { isOpen?: boolean }>(
  ({ isOpen, ...props }, ref) => {
    const Icon = isOpen ? FolderOpen : FolderClosed

    return <Icon ref={ref} {...props} />
  },
)
TreeViewFolderIcon.displayName = 'TreeViewFolderIcon'

export { flattenTree, type INodeRendererProps, TreeView, TreeViewFolderIcon, TreeViewItem }
