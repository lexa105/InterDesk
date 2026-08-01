import { contextBridge, ipcRenderer } from 'electron'

type StorageMode = 'usb_storage' | 'http_transfer' | 'error'

interface DeviceStatus {
  ok: true
  mode: StorageMode
  storageReady: boolean
  uploadActive: boolean
  downloadActive: boolean
  maxUploadBytes: number
  ip: string
}

interface RemoteFile {
  name: string
  size: number
}

interface SelectedFile {
  path: string
  name: string
  size: number
}

interface UploadProgress {
  sent: number
  total: number
}

interface UploadResponse {
  ok: true
  name: string
  size: number
}

type OperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

const api = {
  getDefaultUrl: (): Promise<string> => ipcRenderer.invoke('transfer:get-default-url'),
  getStatus: (baseUrl: string): Promise<OperationResult<DeviceStatus>> =>
    ipcRenderer.invoke('transfer:get-status', baseUrl),
  listFiles: (baseUrl: string): Promise<OperationResult<RemoteFile[]>> =>
    ipcRenderer.invoke('transfer:list-files', baseUrl),
  selectFile: (): Promise<OperationResult<SelectedFile | null>> =>
    ipcRenderer.invoke('transfer:select-file'),
  uploadFile: (
    baseUrl: string,
    filePath: string,
  ): Promise<OperationResult<UploadResponse>> =>
    ipcRenderer.invoke('transfer:upload-file', { baseUrl, filePath }),
  downloadFile: (
    baseUrl: string,
    name: string,
  ): Promise<OperationResult<{ path: string }>> =>
    ipcRenderer.invoke('transfer:download-file', { baseUrl, name }),
  onUploadProgress: (callback: (progress: UploadProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: UploadProgress) => callback(progress)
    ipcRenderer.on('transfer:upload-progress', listener)
    return () => ipcRenderer.removeListener('transfer:upload-progress', listener)
  },
}

contextBridge.exposeInMainWorld('bkmd', api)
