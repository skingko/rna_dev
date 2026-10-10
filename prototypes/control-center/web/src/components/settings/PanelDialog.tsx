/**
 * Large modal surface for the global panels (settings, memory, capabilities,
 * archive, new project). Viewport-sized height so the panel never resizes
 * under the pointer while switching sections; on narrow screens it becomes a
 * full-height sheet. `guard` keeps it open while a write is in flight.
 */
import { type ReactNode } from 'react'
import { Dialog as RDialog, VisuallyHidden } from 'radix-ui'
import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { toast } from '@/store/ui-store'
import { useReturnFocus } from '@/components/ui/overlays'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

export function PanelDialog({ open, onClose, title, description, children, size = 'lg', guard, className, hideHeader }: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  size?: 'md' | 'lg' | 'xl'
  /** Return a message to block dismissal (e.g. a save in flight). */
  guard?: () => string | null
  className?: string
  hideHeader?: boolean
}) {
  const tryClose = () => {
    const reason = guard?.()
    if (reason) { toast(reason); return }
    onClose()
  }
  // Focus back to what opened it (a menu item's menu button, a row) when it closes: there is no Dialog.Trigger.
  const returnFocus = useReturnFocus(open)
  const width = size === 'md' ? 'min(640px,calc(100vw - 32px))' : size === 'xl' ? 'min(1040px,calc(100vw - 32px))' : 'min(880px,calc(100vw - 32px))'
  return (
    <RDialog.Root open={open} onOpenChange={next => { if (!next) tryClose() }}>
      <AnimatePresence>
        {open && (
          <RDialog.Portal forceMount>
            <RDialog.Overlay asChild forceMount>
              <motion.div className="fixed inset-0 z-50 bg-[var(--bg-overlay)] backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
            </RDialog.Overlay>
            <RDialog.Content asChild forceMount aria-describedby={description ? undefined : undefined} onOpenAutoFocus={e => { e.preventDefault(); (e.currentTarget as HTMLElement | null)?.focus?.() }} onCloseAutoFocus={returnFocus}>
              <motion.div
                style={{ width }}
                className={cn(
                  'fixed left-1/2 top-1/2 z-50 flex', size === 'md' ? 'h-[min(620px,calc(100dvh-48px))]' : 'h-[min(760px,calc(100dvh-48px))]', ' -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[20px] bg-elevated text-fg shadow-lg outline-none max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:h-[calc(100dvh-24px)] max-md:w-full! max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none',
                  className,
                )}
                initial={{ opacity: 0, scale: 0.975, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.985, y: 6, transition: { duration: 0.14 } }}
                transition={{ type: 'spring', stiffness: 460, damping: 38, mass: 0.85 }}
                tabIndex={-1}
              >
                {hideHeader ? (
                  <VisuallyHidden.Root><RDialog.Title>{title}</RDialog.Title></VisuallyHidden.Root>
                ) : (
                  <div className="flex shrink-0 items-start gap-4 px-6 pb-3 pt-5">
                    <div className="min-w-0 flex-1">
                      <RDialog.Title className="text-[16px] font-semibold leading-6 text-fg">{title}</RDialog.Title>
                      {description && <RDialog.Description className="mt-0.5 text-[12.5px] leading-5 text-fg-3">{description}</RDialog.Description>}
                    </div>
                    <CloseButton onClick={tryClose} />
                  </div>
                )}
                {!description && <VisuallyHidden.Root><RDialog.Description>{typeof title === 'string' ? title : ''}</RDialog.Description></VisuallyHidden.Root>}
                {children}
              </motion.div>
            </RDialog.Content>
          </RDialog.Portal>
        )}
      </AnimatePresence>
    </RDialog.Root>
  )
}

export function CloseButton({ onClick, label = t('关闭') }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="-mr-1.5 grid size-8 shrink-0 place-items-center rounded-lg text-fg-3 transition-colors hover:bg-hover hover:text-fg">
      <X className="size-4" />
    </button>
  )
}
