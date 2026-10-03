import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, BluetoothDevice, ConnectionState } from './electron-api'
import { DevicesPage } from './components/DevicesPage'
import { DongleSettingsPage } from './components/DongleSettingsPage'
import { Sidebar, type View } from './components/Sidebar'
import { SwitchingPage } from './components/SwitchingPage'

function App() {
  const [view, setView] = useState<View>('devices')
  const [available, setAvailable] = useState<boolean | null>(null)
  const [scanning, setScanning] = useState(false)
  const [devices, setDevices] = useState<BluetoothDevice[]>([])
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected')
  const [connectedDevice, setConnectedDevice] = useState<BluetoothDevice | null>(null)
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [monitoring, setMonitoring] = useState(false)

  useEffect(() => {
    let cancelled = false

    Promise.all([
      window.bkmd.isBluetoothAvailable(),
      window.bkmd.isScanning(),
      window.bkmd.getConnectionState(),
      window.bkmd.getDevices(),
      window.bkmd.getSettings(),
      window.bkmd.getMonitorState(),
      window.bkmd.getConnectedDevice(),
    ]).then(([isAvailable, isScanning, state, initialDevices, initialSettings, monitorState, device]) => {
      if (cancelled) return
      setAvailable(isAvailable)
      setScanning(isScanning)
      setConnectionState(state)
      setDevices(initialDevices)
      setSettings(initialSettings)
      setMonitoring(monitorState)
      setConnectedDevice(device)
    }).catch((error: unknown) => {
      if (!cancelled) setError(error instanceof Error ? error.message : String(error))
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

    const unsubscribeMonitor = window.bkmd.onMonitorStateChanged(setMonitoring)
    const unsubscribeAvailable = window.bkmd.onAvailabilityChanged(setAvailable)
    const unsubscribeError = window.bkmd.onConnectionError(setError)

    return () => {
      cancelled = true
      unsubscribeDiscovered()
      unsubscribeScan()
      unsubscribeConnection()
      unsubscribeMonitor()
      unsubscribeAvailable()
      unsubscribeError()
    }
  }, [])

  // The dongle page only exists while connected - fall back to Devices
  // when the connection goes away. Switching is a local setting, so it stays
  // reachable with no dongle attached.
  useEffect(() => {
    if (connectionState !== 'connected') {
      setView((prev) => (prev === 'switching' ? prev : 'devices'))
    }
  }, [connectionState])

  const toggleScan = useCallback(async () => {
    setError(null)
    try {
      if (scanning) {
        await window.bkmd.stopScan()
      } else {
        setDevices([])
        await window.bkmd.startScan()
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }, [scanning])

  const handleConnect = useCallback(async (deviceId: string) => {
    setError(null)
    setConnectingId(deviceId)
    try {
      const result = await window.bkmd.connect(deviceId)
      if (!result.ok) setError(result.error)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setConnectingId(null)
    }
  }, [])

  const handleDisconnect = useCallback(async () => {
    setError(null)
    try {
      await window.bkmd.disconnect()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-win text-ink">
      <Sidebar
        view={view}
        onSelect={setView}
        connectedDevice={connectedDevice}
        monitoring={monitoring}
        available={available}
      />

      <main className="flex-1 overflow-y-auto">
        {view === 'switching' && settings ? (
          <SwitchingPage settings={settings} onSettingsChange={setSettings} />
        ) : view === 'dongle' && connectedDevice && settings ? (
          <DongleSettingsPage
            device={connectedDevice}
            settings={settings}
            monitoring={monitoring}
            onSettingsChange={setSettings}
            onDisconnect={handleDisconnect}
          />
        ) : (
          <DevicesPage
            available={available}
            scanning={scanning}
            devices={devices}
            connectionState={connectionState}
            connectedDevice={connectedDevice}
            connectingId={connectingId}
            error={error}
            onToggleScan={toggleScan}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
          />
        )}
      </main>
    </div>
  )
}

export default App
