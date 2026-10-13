// Derived from supabase/supabase packages/ui/src/components/Menu/MenuContext.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { createContext, type ReactNode, useContext } from 'react'

export type MenuType = 'text' | 'pills' | 'border'

interface ContextProps {
  type: MenuType
}

interface Provider extends ContextProps {
  children?: ReactNode
}

const MenuContext = createContext<ContextProps>({
  type: 'text',
})

export const MenuContextProvider = ({ type, children }: Provider) => {
  return <MenuContext.Provider value={{ type }}>{children}</MenuContext.Provider>
}

// context helper to avoid using a consumer component
export const useMenuContext = () => useContext(MenuContext)
