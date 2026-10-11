export interface BluetoothDevice {
    id: string;
    name: string;
    rssi: number;
    connectable: boolean;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export type Pc2Side = 'left' | 'right' | 'top' | 'bottom';

export interface Pc2Layout {
    side: Pc2Side;
    offset: number;
    scale: number;
}

export interface AppSettings {
    switchKeybind: string;
    clipboardKeybind: string;
    forwardKeyboard: boolean;
    forwardMouse: boolean;
    dynamicSwitch: boolean;
    pc2Layout: Pc2Layout;
    mouseMode: 'absolute' | 'relative';
}

export type KeybindType = 'switch' | 'clipboard';

export interface ClipboardStatus {
    ok: boolean;
    message: string;
}

export interface BkmdApi {
    isBluetoothAvailable(): Promise<boolean>;
    isScanning(): Promise<boolean>;
    getConnectionState(): Promise<ConnectionState>;
    getDevices(): Promise<BluetoothDevice[]>;
    startScan(): Promise<void>;
    stopScan(): Promise<void>;
    connect(deviceId: string): Promise<{ ok: true } | { ok: false; error: string }>;
    disconnect(): Promise<void>;

    getSettings(): Promise<AppSettings>;
    setForwarding(patch: { forwardKeyboard?: boolean; forwardMouse?: boolean }): Promise<AppSettings>;
    setSwitching(patch: Partial<Pick<AppSettings, 'dynamicSwitch' | 'mouseMode' | 'pc2Layout'>>): Promise<AppSettings>;
    beginKeybindCapture(type: KeybindType): Promise<void>;
    cancelKeybindCapture(type: KeybindType): Promise<void>;
    setKeybind(type: KeybindType, accelerator: string): Promise<{ ok: true; settings: AppSettings } | { ok: false; error: string }>;
    getMonitorState(): Promise<boolean>;
    setMonitorState(active: boolean): Promise<boolean>;

    onDeviceDiscovered(callback: (device: BluetoothDevice) => void): () => void;
    onScanStateChanged(callback: (scanning: boolean) => void): () => void;
    onConnectionStateChanged(callback: (state: ConnectionState, device: BluetoothDevice | null) => void): () => void;
    onMonitorStateChanged(callback: (active: boolean) => void): () => void;
    onClipboardStatus(callback: (status: ClipboardStatus) => void): () => void;
}

declare global {
    interface Window {
        bkmd: BkmdApi;
    }
}
