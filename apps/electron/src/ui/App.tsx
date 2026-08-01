import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  DeviceStatus,
  RemoteFile,
  SelectedFile,
  UploadProgress,
} from './electron-api'

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

function modeLabel(status: DeviceStatus | null): string {
  if (!status) return 'Not connected'
  if (status.mode === 'http_transfer') return 'HTTP Transfer'
  if (status.mode === 'usb_storage') return 'USB Storage'
  return 'Storage error'
}

function App() {
  const [baseUrl, setBaseUrl] = useState('http://192.168.4.1')
  const [status, setStatus] = useState<DeviceStatus | null>(null)
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null)
  const [files, setFiles] = useState<RemoteFile[]>([])
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const clearNotices = useCallback(() => {
    setMessage(null)
    setError(null)
  }, [])

  const refreshFiles = useCallback(async (url: string) => {
    const result = await window.bkmd.listFiles(url)
    if (result.ok) {
      setFiles([...result.value].sort((a, b) => a.name.localeCompare(b.name)))
    } else {
      setFiles([])
      setError(result.error)
    }
  }, [])

  const connect = useCallback(async () => {
    setConnecting(true)
    setFiles([])
    const result = await window.bkmd.getStatus(baseUrl)
    setConnecting(false)
    if (!result.ok) {
      setStatus(null)
      setError(result.error)
      return
    }

    setStatus(result.value)
    if (result.value.mode === 'http_transfer') {
      await refreshFiles(baseUrl)
    }
  }, [baseUrl, refreshFiles])

  useEffect(() => {
    void window.bkmd.getDefaultUrl().then(setBaseUrl)
    const unsubscribe = window.bkmd.onUploadProgress(setProgress)
    return unsubscribe
  }, [])

  const chooseFile = useCallback(async () => {
    clearNotices()
    const result = await window.bkmd.selectFile()
    if (!result.ok) {
      setError(result.error)
      return
    }
    if (result.value) {
      setSelectedFile(result.value)
      setProgress(null)
      if (result.value.size > MAX_UPLOAD_BYTES) {
        setError('This file exceeds the 10 MiB upload limit.')
      }
    }
  }, [clearNotices])

  const sendFile = useCallback(async () => {
    if (!selectedFile) return
    clearNotices()
    setUploading(true)
    setProgress({ sent: 0, total: selectedFile.size })
    const result = await window.bkmd.uploadFile(baseUrl, selectedFile.path)
    setUploading(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setMessage(`Sent ${result.value.name} (${formatBytes(result.value.size)}).`)
    await connect()
  }, [baseUrl, clearNotices, connect, selectedFile])

  const download = useCallback(async (name: string) => {
    clearNotices()
    setDownloading(name)
    const result = await window.bkmd.downloadFile(baseUrl, name)
    setDownloading(null)
    if (!result.ok) {
      if (result.error !== 'Download canceled.') setError(result.error)
      return
    }
    setMessage(`Saved ${name} to ${result.value.path}.`)
  }, [baseUrl, clearNotices])

  const progressPercent = useMemo(() => {
    if (!progress) return 0
    if (progress.total === 0) return uploading ? 0 : 100
    return Math.min(100, Math.round((progress.sent / progress.total) * 100))
  }, [progress, uploading])

  const canUpload = status?.mode === 'http_transfer'
    && selectedFile !== null
    && selectedFile.size <= (status.maxUploadBytes || MAX_UPLOAD_BYTES)
    && !uploading
    && downloading === null

  return (
    <main className="app-shell">
      <section className="panel">
        <header className="app-header">
          <div>
            <p className="eyebrow">BKMD</p>
            <h1>HTTP file transfer</h1>
            <p className="subtitle">Send a file to the ESP32-S3 SD card, then expose it over USB.</p>
          </div>
          <span className={`mode-badge mode-${status?.mode ?? 'offline'}`}>
            {modeLabel(status)}
          </span>
        </header>

        <div className="connection-row">
          <label className="field grow">
            <span>Device URL</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              disabled={connecting || uploading}
              spellCheck={false}
            />
          </label>
          <button
            className="secondary-button"
            onClick={() => {
              clearNotices()
              void connect()
            }}
            disabled={connecting || uploading}
          >
            {connecting ? 'Connecting…' : status ? 'Refresh' : 'Connect'}
          </button>
        </div>

        {!status && (
          <div className="instruction">
            Join the <strong>ESP32_IMG</strong> Wi-Fi network, then press Connect.
          </div>
        )}
        {status?.mode === 'usb_storage' && (
          <div className="instruction warning">
            The SD card is mounted over USB. Long-press the ESP32 button to enter HTTP Transfer mode, then refresh.
          </div>
        )}
        {status?.mode === 'http_transfer' && (
          <div className="instruction success">
            Transfer mode is active. Long-press the button again after transfers finish to remount USB storage.
          </div>
        )}
        {status?.mode === 'error' && (
          <div className="instruction danger">
            Storage initialization failed. Insert a FAT32 SD card and reboot the device.
          </div>
        )}

        {error && <div className="notice error-notice">{error}</div>}
        {message && <div className="notice success-notice">{message}</div>}

        <section className="transfer-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Upload</p>
              <h2>Choose one file</h2>
            </div>
            <span className="limit">Maximum 10 MiB</span>
          </div>

          <div className="file-picker">
            <div className="file-description">
              <strong>{selectedFile?.name ?? 'No file selected'}</strong>
              <span>{selectedFile ? formatBytes(selectedFile.size) : 'Any file type'}</span>
            </div>
            <button className="secondary-button" onClick={() => void chooseFile()} disabled={uploading}>
              Choose file
            </button>
          </div>

          {progress && (
            <div className="progress-block" aria-live="polite">
              <div className="progress-label">
                <span>{uploading ? 'Sending…' : 'Transfer progress'}</span>
                <span>{progressPercent}%</span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}

          <button className="primary-button" onClick={() => void sendFile()} disabled={!canUpload}>
            {uploading ? 'Sending file…' : 'Send to ESP32'}
          </button>
        </section>

        <section className="files-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Storage</p>
              <h2>Received files</h2>
            </div>
            <button
              className="text-button"
              onClick={() => void refreshFiles(baseUrl)}
              disabled={status?.mode !== 'http_transfer' || uploading || downloading !== null}
            >
              Refresh list
            </button>
          </div>

          <div className="file-list">
            {files.length === 0 ? (
              <p className="empty-state">
                {status?.mode === 'http_transfer' ? 'No received files yet.' : 'File listing is available in transfer mode.'}
              </p>
            ) : files.map((file) => (
              <div className="remote-file" key={file.name}>
                <div className="file-description">
                  <strong>{file.name}</strong>
                  <span>{formatBytes(file.size)}</span>
                </div>
                <button
                  className="text-button"
                  onClick={() => void download(file.name)}
                  disabled={downloading !== null || uploading}
                >
                  {downloading === file.name ? 'Saving…' : 'Download'}
                </button>
              </div>
            ))}
          </div>
        </section>
      </section>
    </main>
  )
}

export default App
