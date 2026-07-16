import { useCallback, useEffect, useState } from 'react'
import type { BluetoothDevice, ConnectionState } from './electron-api'

function statusLabel(available: boolean | null, scanning: boolean, connectionState: ConnectionState) {
  if (available === null) return 'Checking...'
  if (!available) return 'Bluetooth unavailable'
  if (connectionState === 'connected') return 'Connected'
  if (connectionState === 'connecting') return 'Connecting...'
  if (scanning) return 'Scanning...'
  return 'Idle'
}

function App() {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [scanning, setScanning] = useState(false)
  const [devices, setDevices] = useState<BluetoothDevice[]>([])
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected')
  const [connectedDevice, setConnectedDevice] = useState<BluetoothDevice | null>(null)
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    Promise.all([
      window.bkmd.isBluetoothAvailable(),
      window.bkmd.isScanning(),
      window.bkmd.getConnectionState(),
      window.bkmd.getDevices(),
    ]).then(([isAvailable, isScanning, state, initialDevices]) => {
      if (cancelled) return
      setAvailable(isAvailable)
      setScanning(isScanning)
      setConnectionState(state)
      setDevices(initialDevices)
    })

    const unsubscribeDiscovered = window.bkmd.onDeviceDiscovered((device) => {
      setDevices((prev) => {
        const idx = prev.findIndex((d) => d.id === device.id)
        if (idx === -1) return [...prev, device]
        const next = [...prev]
        next[idx] = device
        return next
      })
    })

    const unsubscribeScan = window.bkmd.onScanStateChanged(setScanning)

    const unsubscribeConnection = window.bkmd.onConnectionStateChanged((state, device) => {
      setConnectionState(state)
      setConnectedDevice(device)
      if (state !== 'connecting') setConnectingId(null)
    })

    return () => {
      cancelled = true
      unsubscribeDiscovered()
      unsubscribeScan()
      unsubscribeConnection()
    }
  }, [])

  const toggleScan = useCallback(async () => {
    setError(null)
    if (scanning) {
      await window.bkmd.stopScan()
    } else {
      setDevices([])
      await window.bkmd.startScan()
    }
  }, [scanning])

  const handleConnect = useCallback(async (deviceId: string) => {
    setError(null)
    setConnectingId(deviceId)
    const result = await window.bkmd.connect(deviceId)
    if (!result.ok) {
      setError(result.error)
      setConnectingId(null)
    }
  }, [])

  const handleDisconnect = useCallback(async () => {
    setError(null)
    await window.bkmd.disconnect()
  }, [])

  const sortedDevices = [...devices].sort((a, b) => b.rssi - a.rssi)

  return (

    <div className="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-200">
      {/* Sidebar */}
      <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col">
        <div className="p-6">
          <h1 className="text-2xl font-bold text-blue-500 tracking-tight">BKMD</h1>
          <p className="text-xs text-slate-500 uppercase font-semibold mt-1">Control Center</p>
        </div>

        <nav className="flex-1 px-4 space-y-2">
          <button className="w-full text-left px-4 py-2 rounded-lg bg-slate-800 text-white font-medium transition-colors">
            Devices
          </button>
          <button className="w-full text-left px-4 py-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors" disabled>
            Keylogs
          </button>
          <button className="w-full text-left px-4 py-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors" disabled>
            Settings
          </button>
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-auto">
        {/* Top Header */}
        <header className="h-16 border-b border-slate-800 flex items-center justify-between px-8 bg-slate-900/50 backdrop-blur-md sticky top-0 z-10">
          <h2 className="text-lg font-semibold">Device Manager</h2>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-400">
              Status: <span className="text-blue-400 font-mono">{statusLabel(available, scanning, connectionState)}</span>
            </span>
            <button
              onClick={toggleScan}
              disabled={available === false}
              className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white px-4 py-1.5 rounded-md text-sm font-medium transition-colors shadow-lg shadow-blue-900/20"
            >
              {scanning ? 'Stop Scan' : 'Scan for Devices'}
            </button>
          </div>
        </header>

        {/* Dashboard Content */}
        <div className="p-8 space-y-8">

          {available === false && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg px-4 py-3 text-sm">
              Bluetooth is not available or powered off on this machine.
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg px-4 py-3 text-sm">
              {error}
            </div>
          )}

          {/* Device Table */}
          <section>
            <h3 className="text-xl font-bold mb-4">Nearby Devices</h3>
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-left">
                <thead className="bg-slate-800/50 border-b border-slate-800 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-6 py-4 font-semibold tracking-wider">Device Name</th>
                    <th className="px-6 py-4 font-semibold tracking-wider">Signal</th>
                    <th className="px-6 py-4 font-semibold tracking-wider">Status</th>
                    <th className="px-6 py-4 font-semibold tracking-wider text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {sortedDevices.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-6 py-8 text-center text-slate-500 text-sm">
                        {scanning ? 'Scanning for nearby devices…' : 'No devices found. Start a scan to discover nearby devices.'}
                      </td>
                    </tr>
                  )}
                  {sortedDevices.map((device) => {
                    const isConnected = connectedDevice?.id === device.id
                    const isConnecting = connectingId === device.id
                    return (
                      <tr key={device.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="px-6 py-4 font-medium">{device.name}</td>
                        <td className="px-6 py-4 text-slate-400 text-sm font-mono">{device.rssi} dBm</td>
                        <td className="px-6 py-4">
                          <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase ${
                            isConnected ? 'bg-green-500/10 text-green-500' : isConnecting ? 'bg-yellow-500/10 text-yellow-500' : 'bg-slate-700 text-slate-400'
                          }`}>
                            {isConnected ? 'Connected' : isConnecting ? 'Connecting' : 'Available'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          {isConnected ? (
                            <button
                              onClick={handleDisconnect}
                              className="text-red-400 hover:text-red-300 text-sm font-medium"
                            >
                              Disconnect
                            </button>
                          ) : (
                            <button
                              onClick={() => handleConnect(device.id)}
                              disabled={isConnecting || connectionState === 'connecting' || !device.connectable}
                              className="text-blue-400 hover:text-blue-300 disabled:text-slate-600 disabled:cursor-not-allowed text-sm font-medium"
                            >
                              {isConnecting ? 'Connecting…' : 'Connect'}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

        </div>
      </main>
    </div>
  )
}

export default App
