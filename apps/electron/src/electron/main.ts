import {app, BrowserWindow, globalShortcut, ipcMain } from 'electron';

//Bluetooth Manager
import { bluetoothManager, type BluetoothDevice, type ConnectionState } from './bluetooth-manager.js'
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDev } from './util.js';

// Key Monitor
import { KeyMonitor } from './keymonitor.js';

// Mouse Monitor
import { MouseMonitor } from './mousemonitor.js';

// Persisted user settings (switch keybind, forwarding toggles)
import { settingsStore, type AppSettings } from './settings-store.js';

// Swallows local keystrokes while the keyboard is forwarded to PC2
import { localKeyBlocker } from './local-key-blocker.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
const keyMonitor: KeyMonitor = new KeyMonitor();
const mouseMonitor: MouseMonitor = new MouseMonitor();

// Whether the user has forwarding switched on (via keybind or UI). Which
// monitors actually run also depends on the forwardKeyboard/forwardMouse
// settings - see syncMonitors().
let monitoringActive = false;

async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
        // Ensure this path also points to the COMPILED .js file
        preload: path.join(__dirname, 'preload/index.js'),
        contextIsolation: true,
        sandbox: true, // Recommended for security
        },
    });
    if (isDev()) {
        mainWindow.loadURL('http://localhost:5123');
    } else {
        mainWindow.loadFile(path.join(app.getAppPath(), '/dist-react/index.html'));
    }

}


function syncMonitors() {
    const settings = settingsStore.get();
    const wantKeyboard = monitoringActive && settings.forwardKeyboard;
    const wantMouse = monitoringActive && settings.forwardMouse;

    if (wantKeyboard && !keyMonitor.isRunning) keyMonitor.start();
    if (!wantKeyboard && keyMonitor.isRunning) keyMonitor.stop();
    if (wantMouse && !mouseMonitor.isRunning) mouseMonitor.start();
    if (!wantMouse && mouseMonitor.isRunning) mouseMonitor.stop();

    // While forwarding, the keyboard belongs to PC2: swallow local keystrokes
    // so only the switch keybind does anything on this machine.
    if (wantKeyboard) localKeyBlocker.start(settings.switchKeybind);
    else localKeyBlocker.stop();
}

function setMonitoring(active: boolean) {
    monitoringActive = active;
    console.log(active ? 'Starting monitoring...' : 'Stopping monitoring...');
    syncMonitors();
    mainWindow?.webContents.send('monitor:state-changed', monitoringActive);
}

// globalShortcut.register is lenient about malformed accelerators, so gate
// keybind:set on the token grammar the renderer's recorder can produce.
const ACCELERATOR_PATTERN = new RegExp(
    '^((CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|Shift|Super|Meta)\\+)+' +
    '([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Enter|Esc|Escape|Backspace|Delete|Tab|Up|Down|Left|Right|Home|End|PageUp|PageDown|[-=\\[\\]\\\\;\',./`])$'
);

function registerSwitchKeybind(accelerator: string): boolean {
    try {
        return globalShortcut.register(accelerator, () => setMonitoring(!monitoringActive));
    } catch {
        // Malformed accelerator string
        return false;
    }
}


function registerBluetoothIpc() {
    ipcMain.handle('bluetooth:is-available', () => bluetoothManager.isBluetoothAvailable());
    ipcMain.handle('bluetooth:is-scanning', () => bluetoothManager.isScanning());
    ipcMain.handle('bluetooth:get-connection-state', () => bluetoothManager.getConnectionState());
    ipcMain.handle('bluetooth:get-devices', () => bluetoothManager.getDiscoveredDevices());
    ipcMain.handle('bluetooth:start-scan', () => bluetoothManager.startScanning());
    ipcMain.handle('bluetooth:stop-scan', () => bluetoothManager.stopScanning());
    ipcMain.handle('bluetooth:disconnect', () => bluetoothManager.disconnect());
    ipcMain.handle('bluetooth:connect', async (_event, deviceId: string) => {
        try {
            await bluetoothManager.connect(deviceId);
            return { ok: true } as const;
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) } as const;
        }
    });

    bluetoothManager.on('deviceDiscovered', (device: BluetoothDevice) => {
        mainWindow?.webContents.send('bluetooth:device-discovered', device);
    });
    bluetoothManager.on('scanStateChanged', (scanning: boolean) => {
        mainWindow?.webContents.send('bluetooth:scan-state-changed', scanning);
    });
    bluetoothManager.on('connectionStateChanged', (state: ConnectionState, device: BluetoothDevice | null) => {
        mainWindow?.webContents.send('bluetooth:connection-state-changed', state, device);
    });
}


function registerSettingsIpc() {
    ipcMain.handle('settings:get', () => settingsStore.get());

    ipcMain.handle('settings:set-forwarding', (_event, patch: Partial<Pick<AppSettings, 'forwardKeyboard' | 'forwardMouse'>>) => {
        const sanitized: Partial<AppSettings> = {};
        if (typeof patch?.forwardKeyboard === 'boolean') sanitized.forwardKeyboard = patch.forwardKeyboard;
        if (typeof patch?.forwardMouse === 'boolean') sanitized.forwardMouse = patch.forwardMouse;
        const settings = settingsStore.update(sanitized);
        syncMonitors();
        return settings;
    });

    // While the renderer is recording a new keybind, the current one is
    // suspended so pressing it gets captured instead of toggling monitors.
    // The key blocker is suspended too, or the recorder window would never
    // receive the keystrokes being recorded.
    ipcMain.handle('keybind:begin-capture', () => {
        localKeyBlocker.stop();
        globalShortcut.unregister(settingsStore.get().switchKeybind);
    });
    ipcMain.handle('keybind:cancel-capture', () => {
        registerSwitchKeybind(settingsStore.get().switchKeybind);
        syncMonitors();
    });

    ipcMain.handle('keybind:set', (_event, accelerator: string) => {
        if (typeof accelerator !== 'string' || !ACCELERATOR_PATTERN.test(accelerator)) {
            return { ok: false, error: `"${accelerator}" is not a valid shortcut.` } as const;
        }
        const previous = settingsStore.get().switchKeybind;
        // Release blanket-registered combos so the new accelerator is free to
        // be registered as the switch keybind; syncMonitors() re-blocks with
        // the new exclusion afterwards.
        localKeyBlocker.stop();
        globalShortcut.unregister(previous);
        if (registerSwitchKeybind(accelerator)) {
            const settings = settingsStore.update({ switchKeybind: accelerator });
            syncMonitors();
            return { ok: true, settings } as const;
        }
        registerSwitchKeybind(previous);
        syncMonitors();
        return { ok: false, error: `Could not register "${accelerator}" - it may be in use by another app.` } as const;
    });

    ipcMain.handle('monitor:get-state', () => monitoringActive);
    ipcMain.handle('monitor:set-state', (_event, active: boolean) => {
        setMonitoring(Boolean(active));
        return monitoringActive;
    });
}


app.on('ready', async () => {

    try {
        await bluetoothManager.initialize();
        const isAvailable = await bluetoothManager.isBluetoothAvailable();
        if (!isAvailable) {
            console.error("Bluetooth is not available or powered off.");
            // Optionally notify user or handle accordingly
        } else {
            console.log("Bluetooth Ready and Available");
        }
    } catch (err) {
        console.error("Bluetooth initialization failed:", err);
    }

    settingsStore.load();
    registerBluetoothIpc();
    registerSettingsIpc();
    createWindow();

    if (!registerSwitchKeybind(settingsStore.get().switchKeybind)) {
        console.log('Registration failed. Maybe another app is using this combo?');
    }

    keyMonitor.on('hid-report', async (report: Buffer) => {
        await bluetoothManager.sendHidReport(report);
    })

    mouseMonitor.on('hid-report', async (report: Buffer) => {
        await bluetoothManager.sendHidReport(report, true);
    })
})




async function cleanup() {
    console.log('Performing app cleanup...');
    localKeyBlocker.stop();
    keyMonitor.stop();
    mouseMonitor.stop();
    await bluetoothManager.disconnect()
}


app.on('will-quit', async (event) => {
    event.preventDefault();
    await cleanup();
    app.exit();
})


// Handle unexpected crashes
process.on('uncaughtException', async (error) => {
    console.error('CRASH: Uncaught Exception:', error);
    await cleanup();
    process.exit(1);
});

// Handle termination signals (Ctrl+C)
process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
});
