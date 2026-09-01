import type { ReactNode } from 'react'

export function SettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section>
      {title && (
        <h3 className="mb-2 px-1 text-[11px] font-semibold tracking-wider text-ink-faint uppercase">
          {title}
        </h3>
      )}
      <div className="divide-y divide-line rounded-lg border border-line bg-surface">
        {children}
      </div>
    </section>
  )
}

interface SettingsRowProps {
  label: string
  description?: string
  children?: ReactNode
}

export function SettingsRow({ label, description, children }: SettingsRowProps) {
  return (
    <div className="flex min-h-[52px] items-center justify-between gap-6 px-4 py-3">
      <div className="min-w-0">
        <div className="text-[13px] leading-5 text-ink">{label}</div>
        {description && <div className="mt-0.5 text-xs leading-4 text-ink-dim">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  )
}
