import {app, BrowserWindow, globalShortcut, ipcMain, screen, type Display } from 'electron';

//Bluetooth Manager
import { bluetoothManager, type BluetoothDevice, type ConnectionState } from './bluetooth-manager.js'
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDev } from './util.js';
import { ACCELERATOR_PATTERN } from './settings-validation.js';

// Key Monitor
import { KeyMonitor } from './keymonitor.js';

// Mouse Monitor
import { MouseMonitor } from './mousemonitor.js';
import type { ReportKind } from './hid-transport.js';

// Persisted user settings (switch keybind, forwarding toggles)
import { settingsStore, type AppSettings, type Pc2Layout, type Pc2Side } from './settings-store.js';

// Swallows local keystrokes while the keyboard is forwarded to PC2
import { localKeyBlocker } from './local-key-blocker.js';

// Detects the cursor being thrown at the screen edge facing PC2
import { edgeSwitcher, type EdgeCrossing } from './edge-switcher.js';

// Pointer-locked window that owns the real cursor while the mouse is forwarded
import { captureOverlay } from './capture-overlay.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Matches electron-builder's productName so the macOS menu bar and the userData
// directory say "InterDesk" in development too, not "electron".
app.setName('InterDesk');

let mainWindow: BrowserWindow | null = null;
const keyMonitor: KeyMonitor = new KeyMonitor();
const mouseMonitor: MouseMonitor = new MouseMonitor();

// Whether the user has forwarding switched on (via keybind or UI). Which
// monitors actually run also depends on the forwardKeyboard/forwardMouse
// settings - see syncMonitors().
let monitoringActive = false;
let keybindCaptureActive = false;

// Display the capture overlay should cover. Set by the 'crossed' handler (the
// screen the cursor left from); a manual keybind switch has no crossing, so
// syncMonitors() falls back to whichever display the cursor sits on.
let overlayDisplay: Display | null = null;

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

    mainWindow.on('closed', () => {
        mainWindow = null;
        app.quit();
    });
    mainWindow.webContents.on('render-process-gone', () => setMonitoring(false));
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

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
    mouseMonitor.setEdgeReturnEnabled(settings.dynamicSwitch);
    keyMonitor.setSwitchKeybind(settings.switchKeybind);

    // Register the OS shortcuts before starting capture: registration can be
    // expensive, and must not delay reports that are already being forwarded.
    if (wantKeyboard) localKeyBlocker.start(settings.switchKeybind);
    else localKeyBlocker.stop();

    if (wantKeyboard && !keyMonitor.isRunning) keyMonitor.start();
    if (!wantKeyboard && keyMonitor.isRunning) keyMonitor.stop();
    if (wantMouse && !mouseMonitor.isRunning) {
        // If PC2 is on the right, the way back to PC1 is PC2's left edge.
        mouseMonitor.start(settings.mouseMode, oppositeEdge(settings.pc2Layout.side));
    }
    if (!wantMouse && mouseMonitor.isRunning) mouseMonitor.stop();

    // Both modes need raw deltas; otherwise relative movement stops when the
    // local cursor reaches a screen edge. Hide after emitting button releases.
    if (wantMouse) {
        captureOverlay.show(overlayDisplay ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
    } else {
        captureOverlay.hide();
        overlayDisplay = null;
    }

    // The edge watcher only makes sense in LOCAL mode, and only if throwing the
    // cursor at the border could actually reach a dongle.
    edgeSwitcher.setEnabled(
        settings.dynamicSwitch &&
        settings.mouseMode === 'absolute' &&
        !monitoringActive &&
        settings.forwardMouse &&
        bluetoothManager.getConnectionState() === 'connected'
    );
}

function setMonitoring(active: boolean) {
    monitoringActive = active && !keybindCaptureActive && bluetoothManager.getConnectionState() === 'connected';
    if (!monitoringActive) bluetoothManager.resetInput();
    console.log(monitoringActive ? 'Starting monitoring...' : 'Stopping monitoring...');
    syncMonitors();
    mainWindow?.webContents.send('monitor:state-changed', monitoringActive);
}

function registerSwitchKeybind(accelerator: string): boolean {
    try {
        return globalShortcut.register(accelerator, () => setMonitoring(!monitoringActive));
    } catch {
        // Malformed accelerator string
        return false;
    }
}


function handleIpc(channel: string, listener: Parameters<typeof ipcMain.handle>[1]) {
    ipcMain.handle(channel, (event, ...args) => {
        if (!mainWindow || event.sender !== mainWindow.webContents ||
            event.senderFrame !== mainWindow.webContents.mainFrame) {
            throw new Error('IPC is restricted to the InterDesk main window.');
        }
        return listener(event, ...args);
    });
}

function registerBluetoothIpc() {
    handleIpc('bluetooth:is-available', () => bluetoothManager.isBluetoothAvailable());
    handleIpc('bluetooth:is-scanning', () => bluetoothManager.isScanning());
    handleIpc('bluetooth:get-connection-state', () => bluetoothManager.getConnectionState());
    handleIpc('bluetooth:get-connected-device', () => bluetoothManager.getConnectedDevice());
    handleIpc('bluetooth:get-devices', () => bluetoothManager.getDiscoveredDevices());
    handleIpc('bluetooth:start-scan', () => bluetoothManager.startScanning());
    handleIpc('bluetooth:stop-scan', () => bluetoothManager.stopScanning());
    handleIpc('bluetooth:disconnect', () => bluetoothManager.disconnect());
    handleIpc('bluetooth:connect', async (_event, deviceId: string) => {
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
    bluetoothManager.on('availabilityChanged', (available: boolean) => {
        mainWindow?.webContents.send('bluetooth:availability-changed', available);
    });
    bluetoothManager.on('connectionError', (message: string) => {
        mainWindow?.webContents.send('bluetooth:connection-error', message);
    });
    bluetoothManager.on('connectionStateChanged', (state: ConnectionState, device: BluetoothDevice | null) => {
        // Without a connected dongle, forwarded input goes nowhere while the
        // key blocker still swallows local keystrokes - the keyboard would be
        // dead on both machines. Hand control back to the local machine.
        if (state !== 'connected' && monitoringActive) {
            setMonitoring(false);
        } else {
            // Arm/disarm the edge watcher with the connection.
            syncMonitors();
        }
        mainWindow?.webContents.send('bluetooth:connection-state-changed', state, device);
    });
}


function registerSettingsIpc() {
    handleIpc('settings:get', () => settingsStore.get());

    handleIpc('settings:set-forwarding', (_event, patch: Partial<Pick<AppSettings, 'forwardKeyboard' | 'forwardMouse'>>) => {
        const sanitized: Partial<AppSettings> = {};
        if (typeof patch?.forwardKeyboard === 'boolean') sanitized.forwardKeyboard = patch.forwardKeyboard;
        if (typeof patch?.forwardMouse === 'boolean') sanitized.forwardMouse = patch.forwardMouse;
        const settings = settingsStore.update(sanitized);
        syncMonitors();
        return settings;
    });

    handleIpc('settings:set-switching', (_event, patch: Partial<Pick<AppSettings, 'dynamicSwitch' | 'pc2Layout' | 'mouseMode'>>) => {
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
        // Apply mode/layout changes from a clean input state, so the monitor
        // and overlay cannot keep using the previous mode or return edge.
        if (monitoringActive) setMonitoring(false);
        const settings = settingsStore.update(sanitized);
        syncMonitors();
        return settings;
    });

    // While the renderer is recording a new keybind, the current one is
    // suspended so pressing it gets captured instead of toggling monitors.
    // The key blocker is suspended too, or the recorder window would never
    // receive the keystrokes being recorded.
    handleIpc('keybind:begin-capture', () => {
        keybindCaptureActive = true;
        setMonitoring(false);
        globalShortcut.unregister(settingsStore.get().switchKeybind);
    });
    handleIpc('keybind:cancel-capture', () => {
        keybindCaptureActive = false;
        registerSwitchKeybind(settingsStore.get().switchKeybind);
        syncMonitors();
    });

    handleIpc('keybind:set', (_event, accelerator: string) => {
        if (typeof accelerator !== 'string' || !ACCELERATOR_PATTERN.test(accelerator)) {
            return { ok: false, error: `"${accelerator}" is not a valid shortcut.` } as const;
        }
        const previous = settingsStore.get().switchKeybind;
        keybindCaptureActive = false;
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

    handleIpc('monitor:get-state', () => monitoringActive);
    handleIpc('monitor:set-state', (_event, active: boolean) => {
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

    keyMonitor.on('stalled', () => setMonitoring(false));
    mouseMonitor.on('stalled', () => setMonitoring(false));

    keyMonitor.on('hid-report', (report: Buffer) => {
        bluetoothManager.sendHidReport(report);
    })

    mouseMonitor.on('hid-report', (report: Buffer, kind: ReportKind) => {
        bluetoothManager.sendHidReport(report, kind);
    })

    // Cursor thrown at the edge facing PC2 - seed the virtual cursor where it
    // enters PC2's screen, then hand input over.
    edgeSwitcher.on('crossed', (crossing: EdgeCrossing) => {
        mouseMonitor.seedPosition(crossing.vx, crossing.vy, crossing.display, crossing.returnEdge);
        // Cover the display the cursor left from - that's where it is pinned.
        overlayDisplay = crossing.display;
        setMonitoring(true);
    })

    // The lock event explicitly selects the delta source to avoid double counting.
    captureOverlay.onDelta((dx, dy) => mouseMonitor.applyDelta(dx, dy));

    captureOverlay.on('lock-changed', (locked: boolean) => {
        mouseMonitor.setPointerLocked(locked);
        console.log(`Capture overlay pointer lock: ${locked ? 'acquired' : 'released'}`);
    });

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
    captureOverlay.hide();
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
