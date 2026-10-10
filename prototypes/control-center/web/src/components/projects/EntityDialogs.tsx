/** Rename and delete confirmations for projects and sessions (legacy #rename-dialog / #delete-dialog). */
import { useEffect, useState, type FormEvent } from 'react'
import { Trash2 } from 'lucide-react'
import { Dialog } from '@/components/ui/overlays'
import { Button } from '@/components/ui/primitives'
import { usePanels } from '@/components/settings/panel-store'
import { deleteDescription, deleteEntity, entityName, renameEntity } from './entity-actions'
import { t } from '@/i18n'

export function RenameDialog() {
  const target = usePanels(s => s.rename)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (target) { setValue(entityName(target.kind, target.id)); setError(null) } }, [target])
  const close = () => { if (!busy) usePanels.setState({ rename: null }) }
  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!target || busy) return
    const next = value.trim()
    if (!next) { setError(t('请输入名称')); return }
    setBusy(true); setError(null)
    try { await renameEntity(target.kind, target.id, next); usePanels.setState({ rename: null }) } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <Dialog
      open={target !== null}
      onOpenChange={open => { if (!open) close() }}
      title={target?.kind === 'project' ? t('重命名项目') : t('重命名会话')}
      footer={<><Button variant="ghost" onClick={close} disabled={busy}>{t('取消')}</Button><Button variant="primary" disabled={busy} onClick={() => void submit()}>{t('保存')}</Button></>}
    >
      <form onSubmit={submit}>
        <input
          autoFocus
          onFocus={e => e.currentTarget.select()}
          value={value}
          maxLength={160}
          required
          aria-label={t('名称')}
          onChange={e => { setValue(e.target.value); setError(null) }}
          className="h-10 w-full rounded-xl bg-subtle px-3 text-[14px] text-fg outline-none shadow-[inset_0_0_0_1px_var(--line)] focus:shadow-[inset_0_0_0_1px_var(--line-focus)]"
        />
        {error && <p className="mt-2 text-[12.5px] text-danger" role="alert">{error}</p>}
      </form>
    </Dialog>
  )
}

export function DeleteDialog() {
  const target = usePanels(s => s.remove)
  const noun = target?.kind === 'project' ? t('项目') : t('会话')
  const close = () => usePanels.setState({ remove: null })
  // Deleting can take a while (stopping work, removing run files): the dialog closes at once and the
  // deletion finishes in the background; the result, or why it failed, arrives as a toast.
  const confirm = () => {
    if (!target) return
    close()
    void deleteEntity(target.kind, target.id, { confirm: Boolean(target.unapplied || target.workers?.length) }).catch(() => { /* restored and reported (or asked again) by deleteEntity */ })
  }
  return (
    <Dialog
      open={target !== null}
      onOpenChange={open => { if (!open) close() }}
      title={t('删除{noun}？', { noun })}
      description={target ? deleteDescription(target.kind, target.id) : undefined}
      footer={<><Button variant="ghost" autoFocus onClick={close}>{t('取消')}</Button><Button variant="danger" leading={<Trash2 className="size-3.5" />} onClick={confirm}>{t('删除{noun}', { noun })}</Button></>}
    >
      {target && <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger">{entityName(target.kind, target.id)}</p>}
      {target?.unapplied ? <p className="mt-2 text-[13px] text-danger" role="alert">{t('这个对话的工作树里还有 {count} 个文件的改动没有应用到项目文件夹，删除后这些改动会丢弃（最后的状态在 Git 里保留 30 天）。', { count: target.unapplied })}</p> : null}
      {target?.workers?.length ? (
        <div className="mt-2 text-[13px] text-danger" role="alert">
          <p>{t('这个对话的 {count} 个子代理的副本里还有改动没有合并到项目文件夹，删除后这些改动会丢弃（最后的状态在 Git 里保留 30 天）：', { count: target.workers.length })}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {target.workers.map(worker => <li key={worker.worktreeId}>{t('{task}（{count} 个文件）', { task: worker.task || t('子代理'), count: worker.files })}</li>)}
          </ul>
        </div>
      ) : null}
      {target?.secret ? <p className="mt-2 text-[13px] text-danger" role="alert">{t('其中 {count} 个是存放密钥的文件，不进 Git：删除后移到项目文件夹的 .rna/trash.nosync，保留 7 天。', { count: target.secret })}</p> : null}
    </Dialog>
  )
}
