import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { isDev } from './util.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULT_DEVICE_URL = 'http://192.168.4.1'
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 120_000
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024

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

interface UploadRequest {
  baseUrl: string
  filePath: string
}

interface DownloadRequest {
  baseUrl: string
  name: string
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

let mainWindow: BrowserWindow | null = null
const activeRequests = new Set<ClientRequest>()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeBaseUrl(input: unknown): URL {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('Device URL is required.')
  }

  const url = new URL(input.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Device URL must use http:// or https://.')
  }
  if (url.username || url.password) {
    throw new Error('Device URL must not contain credentials.')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  url.search = ''
  url.hash = ''
  return url
}

function endpoint(baseUrl: unknown, pathname: string): URL {
  const base = normalizeBaseUrl(baseUrl)
  const basePath = base.pathname === '/' ? '' : base.pathname
  base.pathname = `${basePath}${pathname}`
  return base
}

function transportFor(url: URL) {
  return url.protocol === 'https:' ? httpsRequest : httpRequest
}

function trackRequest(request: ClientRequest): void {
  activeRequests.add(request)
  request.once('close', () => activeRequests.delete(request))
}

function parseServerError(status: number, body: string): Error {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; code?: unknown }
    if (typeof parsed.message === 'string') {
      return new Error(parsed.message)
    }
    if (typeof parsed.code === 'string') {
      return new Error(`Device error: ${parsed.code}`)
    }
  } catch {
    // Fall through to a status-based message for non-JSON responses.
  }
  return new Error(body.trim() || `Device returned HTTP ${status}.`)
}

function readResponseBody(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let byteCount = 0
    response.on('data', (chunk: Buffer) => {
      byteCount += chunk.length
      if (byteCount > MAX_JSON_RESPONSE_BYTES) {
        response.destroy(new Error('Device response was unexpectedly large.'))
        return
      }
      chunks.push(chunk)
    })
    response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    response.once('error', reject)
  })
}

async function requestJson<T>(baseUrl: unknown, pathname: string): Promise<T> {
  const url = endpoint(baseUrl, pathname)
  return new Promise<T>((resolve, reject) => {
    const request = transportFor(url)(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
      async (response) => {
        try {
          const body = await readResponseBody(response)
          const status = response.statusCode ?? 0
          if (status < 200 || status >= 300) {
            reject(parseServerError(status, body))
            return
          }
          resolve(JSON.parse(body) as T)
        } catch (error) {
          reject(error)
        }
      },
    )
    trackRequest(request)
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('The device request timed out.'))
    })
    request.once('error', reject)
    request.end()
  })
}

function ensureLocalFilePath(filePath: unknown): string {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('Choose a file first.')
  }
  return path.resolve(filePath)
}

async function uploadFile(input: UploadRequest): Promise<UploadResponse> {
  const filePath = ensureLocalFilePath(input?.filePath)
  const fileStats = await stat(filePath)
  if (!fileStats.isFile()) {
    throw new Error('The selected path is not a regular file.')
  }
  if (fileStats.size > MAX_UPLOAD_BYTES) {
    throw new Error('The selected file exceeds the 10 MiB limit.')
  }

  const url = endpoint(input?.baseUrl, '/upload_raw')
  url.searchParams.set('name', path.basename(filePath))

  return new Promise<UploadResponse>((resolve, reject) => {
    let settled = false
    const finishWithError = (error: unknown) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    }

    const request = transportFor(url)(
      url,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileStats.size,
        },
      },
      async (response) => {
        try {
          const body = await readResponseBody(response)
          const status = response.statusCode ?? 0
          if (status < 200 || status >= 300) {
            finishWithError(parseServerError(status, body))
            return
          }
          if (!settled) {
            settled = true
            resolve(JSON.parse(body) as UploadResponse)
          }
        } catch (error) {
          finishWithError(error)
        }
      },
    )
    trackRequest(request)
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('The upload timed out.'))
    })
    request.once('error', finishWithError)

    let sent = 0
    mainWindow?.webContents.send('transfer:upload-progress', {
      sent,
      total: fileStats.size,
    } satisfies UploadProgress)

    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sent += chunk.length
        mainWindow?.webContents.send('transfer:upload-progress', {
          sent,
          total: fileStats.size,
        } satisfies UploadProgress)
        callback(null, chunk)
      },
    })

    pipeline(createReadStream(filePath), progress, request).catch(finishWithError)
  })
}

function validateRemoteFilename(name: unknown): string {
  if (
    typeof name !== 'string'
    || name.length === 0
    || name.length > 64
    || path.basename(name) !== name
    || name.includes('..')
  ) {
    throw new Error('The remote filename is invalid.')
  }
  return name
}

async function downloadFile(input: DownloadRequest): Promise<{ path: string }> {
  const name = validateRemoteFilename(input?.name)
  const saveOptions: SaveDialogOptions = {
    title: 'Save file from BKMD',
    defaultPath: name,
  }
  const selection = mainWindow
    ? await dialog.showSaveDialog(mainWindow, saveOptions)
    : await dialog.showSaveDialog(saveOptions)
  if (selection.canceled || !selection.filePath) {
    throw new Error('Download canceled.')
  }

  const destination = path.resolve(selection.filePath)
  await mkdir(path.dirname(destination), { recursive: true })
  const temporary = path.join(
    path.dirname(destination),
    `.bkmd-download-${process.pid}-${Date.now()}.part`,
  )
  const url = endpoint(input?.baseUrl, '/download')
  url.searchParams.set('name', name)

  try {
    await new Promise<void>((resolve, reject) => {
      const request = transportFor(url)(
        url,
        { method: 'GET', headers: { Connection: 'close' } },
        async (response) => {
          const status = response.statusCode ?? 0
          if (status < 200 || status >= 300) {
            try {
              reject(parseServerError(status, await readResponseBody(response)))
            } catch (error) {
              reject(error)
            }
            return
          }

          try {
            await pipeline(response, createWriteStream(temporary, { flags: 'wx' }))
            resolve()
          } catch (error) {
            reject(error)
          }
        },
      )
      trackRequest(request)
      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error('The download timed out.'))
      })
      request.once('error', reject)
      request.end()
    })

    await rm(destination, { force: true })
    await rename(temporary, destination)
    return { path: destination }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function asResult<T>(operation: () => Promise<T>): Promise<OperationResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('transfer:get-default-url', () => DEFAULT_DEVICE_URL)
  ipcMain.handle('transfer:get-status', (_event, baseUrl: string) =>
    asResult(() => requestJson<DeviceStatus>(baseUrl, '/status')),
  )
  ipcMain.handle('transfer:list-files', (_event, baseUrl: string) =>
    asResult(async () => {
      const response = await requestJson<{ ok: true; files: RemoteFile[] }>(baseUrl, '/list')
      return response.files
    }),
  )
  ipcMain.handle('transfer:select-file', async () =>
    asResult<SelectedFile | null>(async () => {
      const openOptions: OpenDialogOptions = {
        title: 'Choose a file to send',
        properties: ['openFile'],
      }
      const selection = mainWindow
        ? await dialog.showOpenDialog(mainWindow, openOptions)
        : await dialog.showOpenDialog(openOptions)
      if (selection.canceled || selection.filePaths.length === 0) {
        return null
      }
      const selectedPath = path.resolve(selection.filePaths[0])
      const fileStats = await stat(selectedPath)
      return {
        path: selectedPath,
        name: path.basename(selectedPath),
        size: fileStats.size,
      }
    }),
  )
  ipcMain.handle('transfer:upload-file', (_event: IpcMainInvokeEvent, input: UploadRequest) =>
    asResult(() => uploadFile(input)),
  )
  ipcMain.handle('transfer:download-file', (_event: IpcMainInvokeEvent, input: DownloadRequest) =>
    asResult(() => downloadFile(input)),
  )
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 700,
    minWidth: 720,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.once('closed', () => {
    mainWindow = null
  })

  if (isDev()) {
    void mainWindow.loadURL('http://localhost:5123')
  } else {
    void mainWindow.loadFile(path.join(app.getAppPath(), 'dist-react', 'index.html'))
  }
}

function cancelActiveRequests(): void {
  for (const request of activeRequests) {
    request.destroy(new Error('Application is closing.'))
  }
  activeRequests.clear()
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', cancelActiveRequests)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
