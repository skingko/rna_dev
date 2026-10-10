/**
 * Settings form kit: sections, grouped rows, fields, inputs, switches,
 * selects, disclosures and a save bar. Built on the design tokens and Radix
 * primitives; visual language after the Harness settings panel (hairline
 * groups on the elevated surface, 13px labels, 12px help).
 */
import { forwardRef, useCallback, useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { Collapsible, Select as RSelect, Switch as RSwitch } from 'radix-ui'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronRight, Info, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { t, intlTag } from '@/i18n'

/* ------------------------------------------------------------- structure */

export function SettingsSection({ title, description, action, children, className, id }: { title?: ReactNode; description?: ReactNode; action?: ReactNode; children?: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={cn('mb-8 last:mb-2', className)}>
      {(title || action) && (
        <div className="mb-3 flex items-end gap-3">
          <div className="min-w-0 flex-1">
            {title && <h3 className="text-[14px] font-semibold leading-5 text-fg">{title}</h3>}
            {description && <p className="mt-1 text-[12.5px] leading-[1.6] text-fg-3">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

/** A hairline-separated group of rows on a quiet surface. */
export function Group({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('overflow-hidden rounded-xl bg-base shadow-[0_0_0_1px_var(--line)] [&>*+*]:border-t [&>*+*]:border-line-faint', className)}>{children}</div>
}

export function Row({ label, description, children, className, htmlFor }: { label: ReactNode; description?: ReactNode; children?: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={cn('flex min-h-12 items-center gap-4 px-4 py-2.5', className)}>
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="block text-[13px] font-medium leading-5 text-fg">{label}</label>
        {description && <p className="mt-0.5 text-[12px] leading-[1.55] text-fg-3">{description}</p>}
      </div>
      {children !== undefined && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

export function ValueRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-4 px-4 py-2 text-[13px]">
      <span className="flex-1 text-fg-3">{label}</span>
      <span className="min-w-0 truncate text-right font-medium text-fg-2">{value}</span>
    </div>
  )
}

export function Field({ label, help, children, className, htmlFor, error }: { label: ReactNode; help?: ReactNode; children: ReactNode; className?: string; htmlFor?: string; error?: ReactNode }) {
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={htmlFor} className="mb-1.5 block text-[12.5px] font-medium text-fg-2">{label}</label>
      {children}
      {error ? <p className="mt-1.5 text-[12px] leading-[1.55] text-danger">{error}</p> : help && <p className="mt-1.5 text-[12px] leading-[1.55] text-fg-4">{help}</p>}
    </div>
  )
}

export function FieldRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-3 sm:grid-cols-2', className)}>{children}</div>
}

/* ---------------------------------------------------------------- inputs */

const inputClass =
  'h-9 w-full min-w-0 rounded-lg bg-base px-3 text-[13px] text-fg outline-none shadow-[inset_0_0_0_1px_var(--line-strong)] transition-shadow duration-150 placeholder:text-fg-4 hover:shadow-[inset_0_0_0_1px_var(--text-caption)] focus:shadow-[inset_0_0_0_1.5px_var(--accent)] disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-subtle aria-[invalid=true]:shadow-[inset_0_0_0_1.5px_var(--state-danger)]'

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(inputClass, rest.type === 'number' && 'tabular-nums', className)} {...rest} />
})

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(inputClass, 'h-auto resize-y py-2 leading-[1.6]', className)} {...rest} />
})

/* ---------------------------------------------------------------- switch */

export function Switch({ checked, onChange, disabled, id, label }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; id?: string; label?: string }) {
  return (
    <RSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      className="relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full bg-[var(--line-strong)] p-[2px] transition-colors duration-200 data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
    >
      <RSwitch.Thumb className="block size-[18px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2),0_0_0_0.5px_rgb(0_0_0/0.04)] transition-transform duration-200 ease-[var(--ease-out)] data-[state=checked]:translate-x-4" />
    </RSwitch.Root>
  )
}

export function ToggleRow({ label, description, checked, onChange, disabled }: { label: ReactNode; description?: ReactNode; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  const id = useId()
  return (
    <Row label={label} description={description} htmlFor={id}>
      <Switch id={id} checked={checked} onChange={onChange} disabled={disabled} />
    </Row>
  )
}

/* ---------------------------------------------------------------- select */

export interface Option<T extends string = string> { value: T; label: ReactNode; description?: ReactNode; disabled?: boolean; group?: string }

const EMPTY = '__rna_empty__'

export function Select<T extends string>({ value, onChange, options, disabled, id, placeholder, className, contentClassName, 'aria-label': ariaLabel }: {
  value: T; onChange: (value: T) => void; options: Option<T>[]; disabled?: boolean; id?: string; placeholder?: string; className?: string; contentClassName?: string; 'aria-label'?: string
}) {
  // Radix Select forbids '' as an item value; map it to a sentinel.
  const wrap = (v: string) => (v === '' ? EMPTY : v)
  const groups: [string | undefined, Option<T>[]][] = []
  for (const option of options) {
    const last = groups.at(-1)
    if (last && last[0] === option.group) last[1].push(option)
    else groups.push([option.group, [option]])
  }
  const current = options.find(o => o.value === value)
  return (
    <RSelect.Root value={wrap(value)} onValueChange={v => onChange((v === EMPTY ? '' : v) as T)} disabled={disabled}>
      <RSelect.Trigger id={id} aria-label={ariaLabel} className={cn(inputClass, 'flex items-center justify-between gap-2 text-left data-[placeholder]:text-fg-4', className)}>
        <span className="min-w-0 flex-1 truncate">{current ? current.label : placeholder ?? t('请选择')}</span>
        <RSelect.Icon><ChevronDown className="size-3.5 shrink-0 text-fg-4" /></RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content position="popper" sideOffset={6} collisionPadding={12} className={cn('menu-content z-[70] max-h-[min(380px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl bg-elevated p-1 text-[13px] text-fg shadow-lg', contentClassName)}>
          <RSelect.Viewport className="max-h-[inherit] overflow-y-auto">
            {groups.map(([group, items], index) => (
              <RSelect.Group key={`${group ?? ''}-${index}`}>
                {group && <RSelect.Label className="px-2.5 pb-1 pt-2 text-[11.5px] font-medium text-fg-4">{group}</RSelect.Label>}
                {items.map(option => (
                  <RSelect.Item
                    key={option.value}
                    value={wrap(option.value)}
                    disabled={option.disabled}
                    className="relative flex min-h-8 cursor-default select-none items-center gap-2.5 rounded-lg py-1.5 pl-2.5 pr-8 outline-none transition-colors duration-100 data-[disabled]:opacity-40 data-[highlighted]:bg-hover"
                  >
                    <span className="min-w-0 flex-1">
                      <RSelect.ItemText><span className="block truncate">{option.label}</span></RSelect.ItemText>
                      {option.description && <span className="block text-[12px] leading-4 text-fg-4">{option.description}</span>}
                    </span>
                    <RSelect.ItemIndicator className="absolute right-2.5 text-accent"><Check className="size-3.5" strokeWidth={2.2} /></RSelect.ItemIndicator>
                  </RSelect.Item>
                ))}
              </RSelect.Group>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  )
}

/* ------------------------------------------------------------ disclosure */

export function Disclosure({ summary, children, defaultOpen = false, open: controlled, onOpenChange, className, meta }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void; className?: string; meta?: ReactNode }) {
  const [inner, setInner] = useState(defaultOpen)
  const open = controlled ?? inner
  const set = (next: boolean) => { setInner(next); onOpenChange?.(next) }
  return (
    <Collapsible.Root open={open} onOpenChange={set} className={cn('min-w-0', className)}>
      <Collapsible.Trigger className="group flex h-8 w-full items-center gap-1.5 rounded-md text-left text-[12.5px] font-medium text-fg-3 transition-colors hover:text-fg">
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform duration-200', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {meta && <span className="shrink-0 text-[12px] font-normal text-fg-4">{meta}</span>}
      </Collapsible.Trigger>
      <AnimatePresence initial={false}>
        {open && (
          <Collapsible.Content forceMount asChild>
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <div className="pb-2 pl-5 pt-1">{children}</div>
            </motion.div>
          </Collapsible.Content>
        )}
      </AnimatePresence>
    </Collapsible.Root>
  )
}

/* ------------------------------------------------------------------ note */

export type NoteTone = 'default' | 'success' | 'warning' | 'danger'

export function Note({ tone = 'default', children, className, icon = true, action }: { tone?: NoteTone; children: ReactNode; className?: string; icon?: boolean; action?: ReactNode }) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'danger' || tone === 'warning' ? AlertTriangle : Info
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-[12.5px] leading-[1.6]',
        tone === 'default' && 'bg-subtle text-fg-3',
        tone === 'success' && 'bg-success-soft text-[color-mix(in_srgb,var(--state-success)_80%,var(--text-primary))]',
        tone === 'warning' && 'bg-warning-soft text-[color-mix(in_srgb,var(--state-warning)_85%,var(--text-primary))]',
        tone === 'danger' && 'bg-danger-soft text-danger',
        className,
      )}
    >
      {icon && <Icon className="mt-[3px] size-3.5 shrink-0" />}
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  )
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl px-4 py-8 text-center text-[13px] leading-[1.7] text-fg-3 shadow-[inset_0_0_0_1px_var(--line)] [background:repeating-linear-gradient(135deg,transparent_0_6px,var(--bg-hover)_6px_7px)]">
      <p className="mx-auto max-w-sm">{children}</p>
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  )
}

export function Badge({ children, tone = 'default', className }: { children: ReactNode; tone?: 'default' | 'accent' | 'success' | 'warning' | 'danger'; className?: string }) {
  return (
    <span className={cn(
      'inline-flex h-5 shrink-0 items-center rounded-[5px] px-1.5 text-[11px] font-medium leading-none',
      tone === 'default' && 'bg-muted text-fg-3',
      tone === 'accent' && 'bg-accent-soft text-accent-text',
      tone === 'success' && 'bg-success-soft text-success',
      tone === 'warning' && 'bg-warning-soft text-warning',
      tone === 'danger' && 'bg-danger-soft text-danger',
      className,
    )}>{children}</span>
  )
}

/* --------------------------------------------------------- choice cards */

export interface ChoiceOption<T extends string> { value: T; label: ReactNode; hint?: ReactNode }
/**
 * A few mutually exclusive ways of doing one thing, as cards (the 判断方式 selector's pattern): the selected card is
 * outlined and checked, the saved one carries a badge so an unsaved change is visible. A radio group: Tab reaches the
 * selected card, arrow keys move the selection.
 */
export function ChoiceCards<T extends string>({ value, saved, options, onChange, disabled, columns = 2, name, className, 'aria-label': ariaLabel }: {
  value: T; saved?: T; options: ChoiceOption<T>[]; onChange: (value: T) => void; disabled?: boolean; columns?: 2 | 3; name: string; className?: string; 'aria-label': string
}) {
  const cards = useRef<(HTMLButtonElement | null)[]>([])
  const step = (index: number, by: number) => { const next = (index + by + options.length) % options.length; onChange(options[next].value); cards.current[next]?.focus() }
  return (
    <div role="radiogroup" aria-label={ariaLabel} data-choice-group={name} className={cn('grid gap-2', columns === 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : 'sm:grid-cols-2', className)}>
      {options.map((option, index) => {
        const selected = value === option.value
        return (
          <button key={option.value} ref={node => { cards.current[index] = node }} type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1} disabled={disabled} data-choice={option.value}
            onClick={() => { if (!selected) onChange(option.value) }}
            onKeyDown={event => { const by = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0; if (by) { event.preventDefault(); step(index, by) } }}
            className={cn('rounded-xl p-3 text-left outline-none transition-colors focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] disabled:opacity-60', selected ? 'bg-accent-softer shadow-[inset_0_0_0_1.5px_var(--accent)]' : 'shadow-[inset_0_0_0_1px_var(--line)] hover:bg-hover')}>
            <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
              <span className={cn('grid size-5 shrink-0 place-items-center rounded-full text-[11px] tabular-nums', selected ? 'bg-accent text-accent-contrast' : 'bg-subtle text-fg-3')}>{selected ? <Check className="size-3" /> : index + 1}</span>
              <span className="min-w-0 truncate">{option.label}</span>
              {saved === option.value && <Badge tone="success" className="ml-auto">{t('当前')}</Badge>}
            </span>
            {option.hint && <span className="mt-1 block text-[12px] leading-[1.5] text-fg-3">{option.hint}</span>}
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------ form state */

export type FormStatus = { text: string; tone: 'default' | 'saved' | 'error' } | null

/**
 * Mirrors the legacy managed form: dirty tracking, a single in-flight save,
 * inline status ("有未保存的更改" / "正在保存…" / "已保存" / error).
 */
export function useFormState() {
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<FormStatus>(null)
  const busyRef = useRef(false)
  const touch = useCallback(() => { setDirty(true); setStatus(s => (s?.tone === 'error' ? s : { text: t('有未保存的更改'), tone: 'default' })) }, [])
  const submit = useCallback(async <R,>(task: () => Promise<R>, done?: (result: R) => void | Promise<void>, savedText = t('已保存')) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setStatus({ text: t('正在保存…'), tone: 'default' })
    try {
      const result = await task()
      setDirty(false)
      setStatus({ text: savedText, tone: 'saved' })
      await done?.(result)
      return result
    } catch (error) {
      setStatus({ text: (error as Error).message || t('保存失败'), tone: 'error' })
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])
  const reset = useCallback(() => { setDirty(false); setStatus(null) }, [])
  return { dirty, busy, status, setStatus, touch, submit, reset }
}

export function FormStatusText({ status }: { status: FormStatus }) {
  if (!status) return <span className="flex-1" />
  return (
    <span role="status" aria-live="polite" className={cn('flex min-w-0 flex-1 items-center gap-1.5 text-[12px]', status.tone === 'error' ? 'text-danger' : status.tone === 'saved' ? 'text-success' : 'text-fg-3')}>
      {status.text === t('正在保存…') && <Loader2 className="spin size-3.5" />}
      {status.tone === 'saved' && <Check className="size-3.5" />}
      <span className="min-w-0 truncate">{status.text}</span>
    </span>
  )
}

export function SaveBar({ status, busy, dirty, submitLabel = t('保存更改'), extras, onSubmit, alwaysEnabled }: { status: FormStatus; busy: boolean; dirty?: boolean; submitLabel?: string; extras?: ReactNode; onSubmit?: () => void; alwaysEnabled?: boolean }) {
  return (
    <div className="mt-4 flex items-center gap-2">
      <FormStatusText status={status} />
      {extras}
      <Button variant="primary" type={onSubmit ? 'button' : 'submit'} onClick={onSubmit} disabled={busy || (!alwaysEnabled && dirty === false)}>
        {busy && <Loader2 className="spin size-3.5" />}{submitLabel}
      </Button>
    </div>
  )
}

/** Two-step confirm for destructive inline buttons (legacy "确认删除"). */
export function useConfirmStep(timeout = 5000) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const arm = () => { setArmed(true); clearTimeout(timer.current); timer.current = setTimeout(() => setArmed(false), timeout) }
  const disarm = () => { clearTimeout(timer.current); setArmed(false) }
  return { armed, arm, disarm }
}

export function formatDateTime(value?: string | number | null, fallback = t('尚未使用')) {
  if (value === undefined || value === null || value === '') return fallback
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString(intlTag(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : fallback
}
