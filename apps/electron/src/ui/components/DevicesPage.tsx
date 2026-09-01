import type { BluetoothDevice, ConnectionState } from '../electron-api'

interface DevicesPageProps {
  available: boolean | null
  scanning: boolean
  devices: BluetoothDevice[]
  connectionState: ConnectionState
  connectedDevice: BluetoothDevice | null
  connectingId: string | null
  error: string | null
  onToggleScan: () => void
  onConnect: (deviceId: string) => void
  onDisconnect: () => void
}

function signalLabel(rssi: number): string {
  if (rssi >= -55) return 'Strong'
  if (rssi >= -70) return 'Good'
  if (rssi >= -85) return 'Weak'
  return 'Poor'
}

export function DevicesPage({
  available,
  scanning,
  devices,
  connectionState,
  connectedDevice,
  connectingId,
  error,
  onToggleScan,
  onConnect,
  onDisconnect,
}: DevicesPageProps) {
  const sortedDevices = [...devices].sort((a, b) => b.rssi - a.rssi)

  return (
    <div className="mx-auto max-w-2xl px-8 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-ink">Devices</h2>
          <p className="mt-1 text-[13px] text-ink-dim">
            Scan for an InterDesk dongle nearby and connect to start forwarding input.
          </p>
        </div>
        <button
          type="button"
          onClick={onToggleScan}
          disabled={available === false}
          className={`shrink-0 rounded-md border px-3.5 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            scanning
              ? 'border-line bg-surface-2 text-ink hover:border-ink-faint'
              : 'border-accent bg-accent text-white hover:bg-accent/85'
          }`}
        >
          {scanning ? 'Stop Scanning' : 'Scan for Devices'}
        </button>
      </header>

      {available === false && (
        <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-[13px] text-danger">
          Bluetooth is not available or powered off on this machine.
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      )}

      <div className="divide-y divide-line rounded-lg border border-line bg-surface">
        {sortedDevices.length === 0 && (
          <div className="px-4 py-10 text-center text-[13px] text-ink-faint">
            {scanning ? (
              <span className="inline-flex items-center gap-2">
                <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                Scanning for nearby devices…
              </span>
            ) : (
              'No devices found. Start a scan to discover nearby devices.'
            )}
          </div>
        )}

        {sortedDevices.map((device) => {
          const isConnected = connectedDevice?.id === device.id
          const isConnecting = connectingId === device.id
          return (
            <div key={device.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] text-ink">{device.name}</span>
                  {isConnected && <span className="size-1.5 shrink-0 rounded-full bg-ok" />}
                </div>
                <div className="mt-0.5 text-xs text-ink-dim">
                  {signalLabel(device.rssi)} · {device.rssi} dBm
                </div>
              </div>
              <div className="shrink-0">
                {isConnected ? (
                  <button
                    type="button"
                    onClick={onDisconnect}
                    className="rounded-md border border-line bg-surface-2 px-3 py-1 text-[13px] text-danger transition-colors hover:border-danger/50"
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => onConnect(device.id)}
                    disabled={isConnecting || connectionState === 'connecting' || !device.connectable}
                    className="rounded-md border border-line bg-surface-2 px-3 py-1 text-[13px] text-accent transition-colors hover:border-accent/50 disabled:cursor-not-allowed disabled:text-ink-faint"
                  >
                    {isConnecting ? 'Connecting…' : 'Connect'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
