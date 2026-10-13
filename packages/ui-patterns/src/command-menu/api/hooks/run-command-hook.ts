import { useCallback } from 'react'
import { isAppPath, useNavigate, useTelemetry } from '../../../seams/index.ts'
import { type ICommand, isActionCommand } from '../../internal/types.ts'
import { useSetCommandMenuOpen } from './view-hooks.ts'

/**
 * Runs a command the way the menu does: an action is called, a path is handed to
 * the navigate seam, and the menu closes after a navigation. A path that is not
 * an app path is refused. The telemetry event carries the kind only, never the
 * name of the command or the text that was typed (C-20).
 */
export function useRunCommand(): (command: ICommand, via: 'menu' | 'shortcut') => void {
  const navigate = useNavigate()
  const telemetry = useTelemetry()
  const setOpen = useSetCommandMenuOpen()

  return useCallback(
    (command, via) => {
      if (isActionCommand(command)) {
        telemetry({ name: 'command_menu.command_run', properties: { kind: 'action', via } })
        command.action()
        if (command.closeOnSelect) setOpen(false)
        return
      }
      if (!isAppPath(command.href)) return
      telemetry({ name: 'command_menu.command_run', properties: { kind: 'href', via } })
      navigate(command.href)
      setOpen(false)
    },
    [navigate, telemetry, setOpen],
  )
}
