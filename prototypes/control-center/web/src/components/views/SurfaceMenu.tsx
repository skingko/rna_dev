/** The ⋯ menu in a 文件 / 进化 panel's header: 在主视图中打开 (the page takes over, with what the panel shows). */
import { AppWindow, MoreHorizontal } from 'lucide-react'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/overlays'
import { useT } from '@/i18n'

export function SurfaceMenu({ onShowInMain }: { onShowInMain: () => void }) {
  const t = useT()
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" aria-label={t('更多')} data-surface-menu
          className="grid size-7 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] data-[state=open]:bg-active [&_svg]:size-4">
          <MoreHorizontal />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-48">
        <MenuItem icon={<AppWindow />} onSelect={onShowInMain}>{t('在主视图中打开')}</MenuItem>
      </MenuContent>
    </Menu>
  )
}
