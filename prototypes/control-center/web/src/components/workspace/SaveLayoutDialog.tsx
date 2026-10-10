/**
 * 保存当前布局… (design 1.3 item 3): name the panels' current arrangement so
 * the group menu's 布局 can bring it back. A name already in the list replaces
 * that layout (the button says so); past MAX_SAVED_LAYOUTS one has to be
 * deleted first.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { Dialog } from '@/components/ui/overlays'
import { Button } from '@/components/ui/primitives'
import { TextInput } from '@/components/views/kit'
import { LAYOUT_NAME_MAX, MAX_SAVED_LAYOUTS, sameLayoutName, type SavedLayout } from '@/store/layout-persist'
import { listSavedLayouts, saveLayout, useSavedLayouts } from '@/store/side-panel-store'
import { toast } from '@/store/ui-store'
import { t as tr, useT } from '@/i18n'

/** 布局 1, 布局 2, …: the first number no saved layout is named with. */
export function suggestLayoutName(saved: SavedLayout[]): string {
  for (let n = saved.length + 1; ; n++) {
    const name = tr('布局 {n}', { n })
    if (!saved.some(layout => sameLayoutName(layout.name, name))) return name
  }
}

export function SaveLayoutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const saved = useSavedLayouts()
  const [name, setName] = useState('')
  useEffect(() => { if (open) setName(suggestLayoutName(listSavedLayouts())) }, [open])
  const clean = name.trim()
  const same = clean ? saved.find(layout => sameLayoutName(layout.name, clean)) : undefined
  const full = !same && saved.length >= MAX_SAVED_LAYOUTS
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (!clean || full) return
    const result = saveLayout(clean)
    if (!result) { toast(t('这个布局没能保存。'), 'danger'); return }
    toast(t('已保存布局「{name}」。', { name: clean.slice(0, LAYOUT_NAME_MAX) }))
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('保存当前布局')}
      description={t('之后在面板菜单的「布局」里选它，面板就会回到现在的样子。')}
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>{t('取消')}</Button><Button variant="primary" disabled={!clean || full} onClick={() => submit()}>{same ? t('替换') : t('保存')}</Button></>}>
      <form onSubmit={submit} data-save-layout>
        <TextInput autoFocus value={name} maxLength={LAYOUT_NAME_MAX} aria-label={t('布局名称')} onFocus={e => e.currentTarget.select()} onChange={e => setName(e.target.value)} />
        {full
          ? <p role="status" className="mt-2 text-[12.5px] leading-5 text-danger">{t('最多保存 {max} 个布局。先删除一个不用的，再保存新的。', { max: MAX_SAVED_LAYOUTS })}</p>
          : same ? <p role="status" className="mt-2 text-[12.5px] leading-5 text-fg-3">{t('已有同名的布局，保存会替换它。')}</p> : null}
      </form>
    </Dialog>
  )
}
