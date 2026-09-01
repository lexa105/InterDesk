import type { BluetoothDevice } from '../electron-api'

export type View = 'devices' | 'dongle' | 'switching'

function BluetoothIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M7 7l10 10-5 5V2l5 5L7 17" />
    </svg>
  )
}

function DongleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="8" y="2" width="8" height="7" rx="1" />
      <rect x="6" y="9" width="12" height="13" rx="2" />
      <path d="M10.5 4.5h.01M13.5 4.5h.01" />
    </svg>
  )
}

function SwitchingIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="2" y="5" width="11" height="8" rx="1.5" />
      <rect x="15" y="9" width="7" height="6" rx="1.5" />
      <path d="M7.5 13v4m-2 0h4" />
    </svg>
  )
}

interface NavItemProps {
  selected: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  sublabel?: string
  trailing?: React.ReactNode
}

function NavItem({ selected, onClick, icon, label, sublabel, trailing }: NavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
        selected ? 'bg-accent text-white' : 'text-ink-dim hover:bg-white/5 hover:text-ink'
      }`}
    >
      <span className={`flex size-5 shrink-0 items-center justify-center ${selected ? 'text-white' : 'text-accent'}`}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate leading-4">{label}</span>
        {sublabel && (
          <span className={`block truncate text-[11px] leading-4 ${selected ? 'text-white/75' : 'text-ink-faint'}`}>
            {sublabel}
          </span>
        )}
      </span>
      {trailing}
    </button>
  )
}

interface SidebarProps {
  view: View
  onSelect: (view: View) => void
  connectedDevice: BluetoothDevice | null
  monitoring: boolean
  available: boolean | null
}

export function Sidebar({ view, onSelect, connectedDevice, monitoring, available }: SidebarProps) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-sidebar">
      <div className="px-4 pt-5 pb-4">
        <h1 className="text-[15px] font-semibold tracking-tight text-ink">BKMD</h1>
        <p className="mt-0.5 text-[11px] font-medium tracking-wider text-ink-faint uppercase">Control Center</p>
      </div>

      <nav className="flex-1 space-y-0.5 px-2.5">
        <NavItem
          selected={view === 'devices'}
          onClick={() => onSelect('devices')}
          icon={<BluetoothIcon className="size-4" />}
          label="Devices"
        />

        <NavItem
          selected={view === 'switching'}
          onClick={() => onSelect('switching')}
          icon={<SwitchingIcon className="size-4" />}
          label="Switching"
        />

        {connectedDevice && (
          <NavItem
            selected={view === 'dongle'}
            onClick={() => onSelect('dongle')}
            icon={<DongleIcon className="size-4" />}
            label={connectedDevice.name}
            sublabel="Connected"
            trailing={<span className={`size-2 shrink-0 rounded-full ${monitoring ? 'bg-ok' : 'bg-ink-faint'}`} />}
          />
        )}
      </nav>

      <div className="border-t border-line px-4 py-3 text-[11px] leading-5 text-ink-faint">
        <div className="flex items-center gap-2">
          <span className={`size-1.5 rounded-full ${available ? 'bg-ok' : 'bg-danger'}`} />
          Bluetooth {available === null ? 'checking…' : available ? 'on' : 'off'}
        </div>
        <div className="flex items-center gap-2">
          <span className={`size-1.5 rounded-full ${monitoring ? 'bg-ok' : 'bg-ink-faint'}`} />
          Forwarding {monitoring ? 'active' : 'off'}
        </div>
      </div>
    </aside>
  )
}
