export type StorageMode = 'usb_storage' | 'http_transfer' | 'error'

export interface DeviceStatus {
  ok: true
  mode: StorageMode
  storageReady: boolean
  uploadActive: boolean
  downloadActive: boolean
  maxUploadBytes: number
  ip: string
}

export interface RemoteFile {
  name: string
  size: number
}

export interface SelectedFile {
  path: string
  name: string
  size: number
}

export interface UploadProgress {
  sent: number
  total: number
}

export interface UploadResponse {
  ok: true
  name: string
  size: number
}

export type OperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export interface BkmdApi {
  getDefaultUrl(): Promise<string>
  getStatus(baseUrl: string): Promise<OperationResult<DeviceStatus>>
  listFiles(baseUrl: string): Promise<OperationResult<RemoteFile[]>>
  selectFile(): Promise<OperationResult<SelectedFile | null>>
  uploadFile(baseUrl: string, filePath: string): Promise<OperationResult<UploadResponse>>
  downloadFile(baseUrl: string, name: string): Promise<OperationResult<{ path: string }>>
  onUploadProgress(callback: (progress: UploadProgress) => void): () => void
}

declare global {
  interface Window {
    bkmd: BkmdApi
  }
}
