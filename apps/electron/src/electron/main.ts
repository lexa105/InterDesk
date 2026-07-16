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


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
const keyMonitor: KeyMonitor = new KeyMonitor();
const mouseMonitor: MouseMonitor = new MouseMonitor();

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

    registerBluetoothIpc();
    createWindow();

    const ret = globalShortcut.register('CommandOrControl+Shift+R', () => {
        if (keyMonitor.isRunning) {
            console.log('Stopping monitoring...');
            keyMonitor.stop();
            mouseMonitor.stop();
        } else {
            console.log('Starting monitoring...');
            keyMonitor.start();
            mouseMonitor.start();
        }
    });

    if (!ret) {
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
