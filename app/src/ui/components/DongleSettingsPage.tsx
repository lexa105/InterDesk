import { useCallback } from 'react'
import type { AppSettings, BluetoothDevice } from '../electron-api'
import { KeybindRecorder } from './KeybindRecorder'
import { SettingsGroup, SettingsRow } from './SettingsGroup'
import { Toggle } from './Toggle'

interface DongleSettingsPageProps {
  device: BluetoothDevice
  settings: AppSettings
  monitoring: boolean
  onSettingsChange: (settings: AppSettings) => void
  onDisconnect: () => void
}

export function DongleSettingsPage({
  device,
  settings,
  monitoring,
  onSettingsChange,
  onDisconnect,
}: DongleSettingsPageProps) {
  const setForwarding = useCallback(
    async (patch: { forwardKeyboard?: boolean; forwardMouse?: boolean }) => {
      onSettingsChange(await window.bkmd.setForwarding(patch))
    },
    [onSettingsChange],
  )

  const setMonitoring = useCallback(async (active: boolean) => {
    await window.bkmd.setMonitorState(active)
  }, [])

  return (
    <div className="mx-auto max-w-2xl px-8 py-8">
      {/* Device header */}
      <header className="mb-8 flex items-center gap-4">
        <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-line bg-surface">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-7 text-accent">
            <rect x="8" y="2" width="8" height="7" rx="1" />
            <rect x="6" y="9" width="12" height="13" rx="2" />
            <path d="M10.5 4.5h.01M13.5 4.5h.01" />
          </svg>
        </div>
        <div className="min-w-0">
          <h2 className="truncate text-xl font-semibold tracking-tight text-ink">{device.name}</h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-ink-dim">
            <span className="size-1.5 rounded-full bg-ok" />
            Connected · InterDesk dongle
          </p>
        </div>
      </header>

      <div className="space-y-7">
        <SettingsGroup title="Input forwarding">
          <SettingsRow
            label="Forwarding active"
            description="Master switch — also toggled by the shortcut below"
          >
            <Toggle checked={monitoring} onChange={setMonitoring} />
          </SettingsRow>
          <SettingsRow label="Forward keyboard" description="Send keystrokes to the target computer">
            <Toggle
              checked={settings.forwardKeyboard}
              onChange={(checked) => setForwarding({ forwardKeyboard: checked })}
            />
          </SettingsRow>
          <SettingsRow label="Forward mouse" description="Send mouse movement, clicks and scrolling">
            <Toggle
              checked={settings.forwardMouse}
              onChange={(checked) => setForwarding({ forwardMouse: checked })}
            />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Switch keybind">
          <SettingsRow
            label="Toggle forwarding"
            description="Global shortcut that turns input forwarding on and off"
          >
            <KeybindRecorder value={settings.switchKeybind} onChange={onSettingsChange} />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Connection">
          <SettingsRow label="Signal strength">
            <span className="text-[13px] text-ink-dim">{device.rssi} dBm</span>
          </SettingsRow>
          <SettingsRow label="Device ID">
            <span className="max-w-56 truncate font-mono text-xs text-ink-faint">{device.id}</span>
          </SettingsRow>
          <button
            type="button"
            onClick={onDisconnect}
            className="w-full px-4 py-3 text-left text-[13px] text-danger transition-colors hover:bg-white/5"
          >
            Disconnect
          </button>
        </SettingsGroup>
      </div>
    </div>
  )
}
