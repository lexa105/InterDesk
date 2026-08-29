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
import { settingsStore, type AppSettings, type Pc2Layout, type Pc2Side } from './settings-store.js';

// Swallows local keystrokes while the keyboard is forwarded to PC2
import { localKeyBlocker } from './local-key-blocker.js';

// Detects the cursor being thrown at the screen edge facing PC2
import { edgeSwitcher, type EdgeCrossing } from './edge-switcher.js';


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


const SIDES: Pc2Side[] = ['left', 'right', 'top', 'bottom'];

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/** The edge of PC2's screen that faces back towards PC1. */
function oppositeEdge(side: Pc2Side): Pc2Side {
    switch (side) {
        case 'left': return 'right';
        case 'right': return 'left';
        case 'top': return 'bottom';
        case 'bottom': return 'top';
    }
}

function syncMonitors() {
    const settings = settingsStore.get();
    const wantKeyboard = monitoringActive && settings.forwardKeyboard;
    const wantMouse = monitoringActive && settings.forwardMouse;

    if (wantKeyboard && !keyMonitor.isRunning) keyMonitor.start();
    if (!wantKeyboard && keyMonitor.isRunning) keyMonitor.stop();
    if (wantMouse && !mouseMonitor.isRunning) {
        // If PC2 is on the right, the way back to PC1 is PC2's left edge.
        mouseMonitor.start(settings.mouseMode, oppositeEdge(settings.pc2Layout.side));
    }
    if (!wantMouse && mouseMonitor.isRunning) mouseMonitor.stop();

    // While forwarding, the keyboard belongs to PC2: swallow local keystrokes
    // so only the switch keybind does anything on this machine.
    if (wantKeyboard) localKeyBlocker.start(settings.switchKeybind);
    else localKeyBlocker.stop();

    // The edge watcher only makes sense in LOCAL mode, and only if throwing the
    // cursor at the border could actually reach a dongle.
    edgeSwitcher.setEnabled(
        settings.dynamicSwitch &&
        !monitoringActive &&
        settings.forwardMouse &&
        bluetoothManager.getConnectionState() === 'connected'
    );
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
        // Without a connected dongle, forwarded input goes nowhere while the
        // key blocker still swallows local keystrokes - the keyboard would be
        // dead on both machines. Hand control back to the local machine.
        if (state === 'disconnected' && monitoringActive) {
            setMonitoring(false);
        } else {
            // Arm/disarm the edge watcher with the connection.
            syncMonitors();
        }
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

    ipcMain.handle('settings:set-switching', (_event, patch: Partial<Pick<AppSettings, 'dynamicSwitch' | 'pc2Layout' | 'mouseMode'>>) => {
        const sanitized: Partial<AppSettings> = {};
        if (typeof patch?.dynamicSwitch === 'boolean') sanitized.dynamicSwitch = patch.dynamicSwitch;
        // Rebuilt field by field - never trust the renderer's object shape.
        const layout = patch?.pc2Layout as Partial<Pc2Layout> | undefined;
        if (layout && SIDES.includes(layout.side as Pc2Side) &&
            Number.isFinite(layout.offset) && Number.isFinite(layout.scale)) {
            sanitized.pc2Layout = {
                side: layout.side as Pc2Side,
                offset: clamp(layout.offset as number, -10, 10),
                scale: clamp(layout.scale as number, 0.05, 20),
            };
        }
        if (patch?.mouseMode === 'absolute' || patch?.mouseMode === 'relative') sanitized.mouseMode = patch.mouseMode;
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

    // Cursor thrown at the edge facing PC2 - seed the virtual cursor where it
    // enters PC2's screen, then hand input over.
    edgeSwitcher.on('crossed', (crossing: EdgeCrossing) => {
        mouseMonitor.seedPosition(crossing.vx, crossing.vy, crossing.display, crossing.returnEdge);
        setMonitoring(true);
    })

    // Virtual cursor pushed back out through the edge facing PC1.
    mouseMonitor.on('edge-return', () => {
        setMonitoring(false);
    })
})




async function cleanup() {
    console.log('Performing app cleanup...');
    localKeyBlocker.stop();
    edgeSwitcher.setEnabled(false);
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
