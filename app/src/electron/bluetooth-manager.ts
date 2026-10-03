import { withBindings, type Peripheral, type Characteristic } from '@stoprocent/noble';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { HidTransport, type ReportKind } from './hid-transport.js';

const noble = withBindings('default');
const SERVICE_UUID = 'b00b';
const HID_UUID = '1235';
const CONTROL_UUID = '1236';
const PROTOCOL_VERSION = 2;
const CONNECT_TIMEOUT_MS = 60_000; // Includes the OS passkey dialog.

import type { BluetoothDevice, ConnectionState } from '../shared/contracts.js';
export type { BluetoothDevice, ConnectionState } from '../shared/contracts.js';

function withDeadline<T>(operation: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error('Bluetooth operation timed out.')), ms);
        const abort = () => finish(new Error('Bluetooth connection cancelled.'));
        const finish = (error?: unknown, result?: T) => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve(result as T);
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        operation.then((result) => finish(undefined, result), (error) => finish(error));
    });
}

class BluetoothManager extends EventEmitter {
    private discoveredPeripherals = new Map<string, Peripheral>();
    private connectedPeripheral: Peripheral | null = null;
    private connectionState: ConnectionState = 'disconnected';
    private scanning = false;
    private scanOperation = false;
    private connecting = false;
    private initialized = false;
    private generation = 0;
    private connectionAbort: AbortController | null = null;
    private transport: HidTransport | null = null;
    private pendingNativeConnections = new Set<Peripheral>();

    public async isBluetoothAvailable(): Promise<boolean> {
        return noble.state === 'poweredOn';
    }

    /** Register listeners immediately; a powered-off adapter must not block the UI. */
    public initialize() {
        if (this.initialized) return;
        this.initialized = true;
        noble.on('discover', (peripheral) => {
            if (!peripheral.advertisement.serviceUuids?.includes(SERVICE_UUID)) return;
            this.discoveredPeripherals.set(peripheral.id, peripheral);
            this.emit('deviceDiscovered', this.toDeviceInfo(peripheral));
        });
        noble.on('scanStart', () => this.setScanning(true));
        noble.on('scanStop', () => this.setScanning(false));
        noble.on('stateChange', (state) => {
            this.emit('availabilityChanged', state === 'poweredOn');
            if (state !== 'poweredOn') {
                this.setScanning(false);
                void this.disconnect();
            }
        });
        noble.on('warning', (message: string) => console.warn('Bluetooth:', message));
    }

    public getDiscoveredDevices(): BluetoothDevice[] {
        return Array.from(this.discoveredPeripherals.values(), (p) => this.toDeviceInfo(p));
    }

    public getConnectedDevice(): BluetoothDevice | null {
        return this.connectedPeripheral && this.connectionState === 'connected'
            ? this.toDeviceInfo(this.connectedPeripheral) : null;
    }

    public getConnectionState(): ConnectionState { return this.connectionState; }
    public isScanning(): boolean { return this.scanning; }

    public async startScanning() {
        if (this.scanning || this.scanOperation) return;
        if (this.connecting) throw new Error('Wait for pairing to finish before scanning.');
        if (noble.state !== 'poweredOn') throw new Error('Turn on Bluetooth, then scan again.');
        this.scanOperation = true;
        try {
            this.discoveredPeripherals.clear();
            await withDeadline(noble.startScanningAsync([SERVICE_UUID], true), 5000);
        } finally {
            this.scanOperation = false;
        }
    }

    public async stopScanning() {
        if (this.scanning) await withDeadline(noble.stopScanningAsync(), 5000);
        this.setScanning(false);
    }

    public async connect(peripheralId: string) {
        if (this.connecting) throw new Error('A connection is already in progress.');
        if (process.platform === 'linux') {
            throw new Error('Secure pairing requires the native macOS or Windows Bluetooth driver. The current Linux Noble driver does not support authenticated pairing.');
        }
        const peripheral = this.discoveredPeripherals.get(peripheralId);
        if (!peripheral?.connectable) throw new Error('Scan again and select a connectable InterDesk dongle.');
        if (this.pendingNativeConnections.has(peripheral)) {
            throw new Error('Bluetooth is still cancelling an earlier connection. Toggle Bluetooth off and on if it does not finish.');
        }
        this.connecting = true;
        await this.disconnect();
        if (peripheral.state !== 'disconnected') {
            this.connecting = false;
            throw new Error('The previous Bluetooth link has not closed. Toggle Bluetooth off and on before reconnecting.');
        }
        const generation = ++this.generation;
        const abort = new AbortController();
        this.connectionAbort = abort;
        this.connectedPeripheral = peripheral;
        this.setConnectionState('connecting');

        const assertCurrent = () => {
            if (generation !== this.generation || abort.signal.aborted) {
                throw new Error('Bluetooth connection cancelled.');
            }
        };
        const onDisconnect = () => {
            if (generation !== this.generation) return;
            this.clearConnection();
        };
        peripheral.once('disconnect', onDisconnect);
        try {
            await withDeadline((async () => {
                await this.stopScanning();
                assertCurrent();
                this.pendingNativeConnections.add(peripheral);
                try {
                    await peripheral.connectAsync();
                    if (generation !== this.generation || abort.signal.aborted) {
                        // Some drivers complete connect after cancellation. Do
                        // not leave that late link occupying the dongle.
                        await this.closePeripheral(peripheral);
                    }
                } finally {
                    this.pendingNativeConnections.delete(peripheral);
                }
                assertCurrent();
                // Scope discovery to our service; a matching characteristic on
                // an unrelated BLE device must never become an input target.
                const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
                    [SERVICE_UUID], [HID_UUID, CONTROL_UUID],
                );
                assertCurrent();
                const hid = characteristics.find(c => c.uuid === HID_UUID);
                const control = characteristics.find(c => c.uuid === CONTROL_UUID);
                if (!hid?.properties.includes('write') || !control?.properties.includes('read') ||
                    !control.properties.includes('write')) {
                    throw new Error('Dongle firmware is incompatible. Flash the current InterDesk firmware.');
                }
                // This protected read triggers OS pairing. Do not capture any
                // local input until authentication and a remote reset succeed.
                const version = await control.readAsync();
                assertCurrent();
                if (version.length !== 1 || version[0] !== PROTOCOL_VERSION) {
                    throw new Error('Dongle protocol version does not match this app.');
                }
                await control.writeAsync(Buffer.from([0]), false);
                assertCurrent();
                this.transport = this.createTransport(hid, control, generation);
                this.transport.start();
                this.setConnectionState('connected');
            })(), CONNECT_TIMEOUT_MS, abort.signal);
        } catch (error) {
            if (generation === this.generation) this.clearConnection();
            peripheral.removeListener('disconnect', onDisconnect);
            await this.closePeripheral(peripheral);
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`${detail} For first pairing, hold the dongle button for 2 seconds, then enter its code in the system Bluetooth dialog.`);
        } finally {
            this.connecting = false;
        }
    }

    public sendHidReport(report: Buffer, kind: ReportKind = 'input') {
        if (![4, 6, 8].includes(report.length)) throw new Error('Invalid HID report length.');
        this.transport?.send(report, kind);
    }

    public resetInput() { this.transport?.resetInput(); }

    public async disconnect() {
        const peripheral = this.connectedPeripheral;
        this.clearConnection(); // Invalidate queues and callbacks before awaiting the driver.
        if (peripheral) await this.closePeripheral(peripheral);
    }

    private createTransport(hid: Characteristic, control: Characteristic, generation: number) {
        return new HidTransport(
            (report, kind) => (kind === 'control' ? control : hid).writeAsync(report, false),
            (error) => {
                if (generation !== this.generation) return;
                this.emit('connectionError', error.message);
                void this.disconnect();
            },
        );
    }

    private clearConnection() {
        this.generation++;
        this.connectionAbort?.abort();
        this.connectionAbort = null;
        this.transport?.stop();
        this.transport = null;
        this.connectedPeripheral = null;
        this.setConnectionState('disconnected');
    }

    private async closePeripheral(peripheral: Peripheral) {
        try {
            if (peripheral.state === 'connecting') peripheral.cancelConnect();
            if (peripheral.state !== 'disconnected') {
                await withDeadline(peripheral.disconnectAsync(), 3000);
            }
        } catch (error) {
            console.warn('Bluetooth disconnect:', error);
        }
    }

    private setScanning(scanning: boolean) {
        this.scanning = scanning;
        this.emit('scanStateChanged', scanning);
    }

    private setConnectionState(state: ConnectionState) {
        this.connectionState = state;
        this.emit('connectionStateChanged', state, this.getConnectedDevice());
    }

    private toDeviceInfo(peripheral: Peripheral): BluetoothDevice {
        return {
            id: peripheral.id,
            name: peripheral.advertisement?.localName || 'InterDesk Dongle',
            rssi: peripheral.rssi,
            connectable: peripheral.connectable,
        };
    }
}

export const bluetoothManager = new BluetoothManager();
