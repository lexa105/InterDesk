import { withBindings, Peripheral, type Characteristic } from '@stoprocent/noble';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { decodeClipboardResult, encodeClipboardFrames, type ClipboardResult } from './clipboard-protocol.js';
import { normalizeGattUuid } from './gatt-uuid.js';

// 'default' automatically selects the right driver for Windows, Mac, or Linux
const noble = withBindings('default');

const HID_CHARACTERISTIC_UUID = '1235';
const CLIPBOARD_DATA_CHARACTERISTIC_UUID = '1236';
const CLIPBOARD_STATUS_CHARACTERISTIC_UUID = '1237';

interface PendingClipboardTransfer {
    resolve: (result: ClipboardResult) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

export interface BluetoothDevice {
    id: string;
    name: string;
    rssi: number;
    connectable: boolean;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

class BluetoothManager extends EventEmitter {
    private discoveredPeripherals = new Map<string, Peripheral>();
    private connectedPeripheral: Peripheral | null = null;
    private targetCharacteristics: Characteristic | null = null;
    private clipboardDataCharacteristic: Characteristic | null = null;
    private clipboardStatusCharacteristic: Characteristic | null = null;
    private clipboardStatusListener: ((data: Buffer, isNotification: boolean) => void) | null = null;
    private nextClipboardTransferId = 0;
    private clipboardSending = false;
    private pendingClipboardTransfers = new Map<number, PendingClipboardTransfer>();
    private connectionState: ConnectionState = 'disconnected';
    private scanning = false;

    public async isBluetoothAvailable(): Promise<boolean> {
        try {
            // Check current state or wait for it to be powered on
            return noble.state === 'poweredOn';
        } catch (err) {
            console.error('Error checking Bluetooth availability:', err);
            return false;
        }
    }

    public async initialize() {
        //wait for bluetooth hardware to be ready
        try {
            await noble.waitForPoweredOnAsync();
            console.log('Bluetooth is powered on and ready!');
        } catch (err) {
            console.log(err)
        }

        noble.on('discover', (peripheral) => {
            this.discoveredPeripherals.set(peripheral.id, peripheral);
            this.emit('deviceDiscovered', this.toDeviceInfo(peripheral));
        });
    }

    public getDiscoveredDevices(): BluetoothDevice[] {
        return Array.from(this.discoveredPeripherals.values()).map((p) => this.toDeviceInfo(p));
    }

    public getConnectionState(): ConnectionState {
        return this.connectionState;
    }

    public isScanning(): boolean {
        return this.scanning;
    }

    public async startScanning() {
        if (this.scanning) return;
        this.discoveredPeripherals.clear();
        // Empty array [] means "any service", 'true' allows duplicate discover
        // events per peripheral so RSSI keeps updating while the list is open.
        await noble.startScanningAsync([], true);
        this.scanning = true;
        this.emit('scanStateChanged', true);
    }

    public async stopScanning() {
        if (!this.scanning) return;
        await noble.stopScanningAsync();
        this.scanning = false;
        this.emit('scanStateChanged', false);
    }

    public async connect(peripheralId: string) {
        const peripheral = this.discoveredPeripherals.get(peripheralId);
        if (!peripheral) {
            throw new Error(`Unknown device id: ${peripheralId}`);
        }

        if (this.connectedPeripheral) {
            await this.disconnect();
        }

        this.setConnectionState('connecting');

        try {
            if (this.scanning) {
                await this.stopScanning();
            }

            await peripheral.connectAsync();
            this.connectedPeripheral = peripheral;

            peripheral.once('disconnect', () => {
                this.connectedPeripheral = null;
                this.targetCharacteristics = null;
                this.clipboardDataCharacteristic = null;
                this.detachClipboardStatusListener();
                this.clipboardStatusCharacteristic = null;
                this.failPendingClipboardTransfers(new Error('Bluetooth disconnected during clipboard transfer.'));
                this.setConnectionState('disconnected');
            });

            const { services, characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();

            console.log("Found Services:", services.map(s => s.uuid));
            console.log("Found Characteristics:", characteristics.map(c => c.uuid));

            const hidChar = characteristics.find(c => normalizeGattUuid(c.uuid) === HID_CHARACTERISTIC_UUID);
            if (hidChar) {
                this.targetCharacteristics = hidChar;
                console.log('Target characteristic (1235) found and set!');
            } else {
                console.warn('Target characteristic (1235) NOT found on this device.');
            }

            this.clipboardDataCharacteristic = characteristics.find(
                c => normalizeGattUuid(c.uuid) === CLIPBOARD_DATA_CHARACTERISTIC_UUID
            ) ?? null;

            const clipboardStatusChar = characteristics.find(
                c => normalizeGattUuid(c.uuid) === CLIPBOARD_STATUS_CHARACTERISTIC_UUID
            );
            if (clipboardStatusChar) {
                this.clipboardStatusCharacteristic = clipboardStatusChar;
                this.clipboardStatusListener = (data: Buffer) => {
                    const result = decodeClipboardResult(data);
                    if (!result) return;
                    const pending = this.pendingClipboardTransfers.get(result.transferId);
                    if (!pending) return;
                    clearTimeout(pending.timeout);
                    this.pendingClipboardTransfers.delete(result.transferId);
                    pending.resolve(result);
                };
                clipboardStatusChar.on('data', this.clipboardStatusListener);
                await clipboardStatusChar.subscribeAsync();
            } else {
                this.clipboardStatusCharacteristic = null;
                console.warn('Clipboard status characteristic (1237) not found; clipboard typing is unavailable on this firmware.');
            }

            this.setConnectionState('connected');
        } catch (err) {
            this.detachClipboardStatusListener();
            if (this.connectedPeripheral === peripheral) {
                try {
                    await peripheral.disconnectAsync();
                } catch {
                    // Preserve the discovery/subscription error for the caller.
                }
            }
            this.connectedPeripheral = null;
            this.targetCharacteristics = null;
            this.clipboardDataCharacteristic = null;
            this.clipboardStatusCharacteristic = null;
            this.setConnectionState('disconnected');
            throw err;
        }
    }

    public async sendData(peripheral: Peripheral, serviceUuid: string, charUuid: string, data: string) {
        try {
            const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
                [serviceUuid],
                [charUuid]
            );

            const targetChar = characteristics[0];

            if (!targetChar) {
                throw new Error('Characteristic not found');
            }

            const payload = Buffer.from(data, 'utf-8')

            await targetChar.writeAsync(payload, false);
            console.log('Data sent successfully!');

        } catch (error) {
            console.error('Failed to send data:', error);
        }
    }

    public async sendHidReport(report: Buffer, withoutResponse = false) {
        if (!this.targetCharacteristics) {
            console.warn('Cannot send HID report: No target characteristic connected.')
            return;
        }

        try {
            await this.targetCharacteristics.writeAsync(report, withoutResponse);
        } catch (e) {
            console.error("Failed to send HID report: ", e)
        }
    }

    public async sendClipboardText(text: string): Promise<{ skippedCharacters: number }> {
        if (!this.clipboardDataCharacteristic || !this.clipboardStatusCharacteristic) {
            throw new Error('Clipboard typing needs the updated InterDesk dongle firmware.');
        }
        if (this.clipboardSending) {
            throw new Error('A clipboard transfer is already in progress.');
        }

        this.nextClipboardTransferId = (this.nextClipboardTransferId % 0xff) + 1;
        const transferId = this.nextClipboardTransferId;
        const frames = encodeClipboardFrames(text, transferId);
        this.clipboardSending = true;

        try {
            const resultPromise = new Promise<{ result: ClipboardResult } | { error: Error }>((resolve) => {
                const timeout = setTimeout(() => {
                    this.pendingClipboardTransfers.delete(transferId);
                    resolve({ error: new Error('The dongle did not finish typing clipboard text in time.') });
                }, 20000);
                this.pendingClipboardTransfers.set(transferId, {
                    resolve: (result) => resolve({ result }),
                    reject: (error) => resolve({ error }),
                    timeout,
                });
            });

            for (const frame of frames) {
                await this.clipboardDataCharacteristic.writeAsync(frame, false);
            }

            const outcome = await resultPromise;
            if ('error' in outcome) throw outcome.error;
            const result = outcome.result;
            if (!result.ok) throw new Error('The dongle rejected the clipboard transfer.');
            return { skippedCharacters: result.skippedCharacters };
        } catch (error) {
            const pending = this.pendingClipboardTransfers.get(transferId);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingClipboardTransfers.delete(transferId);
            }
            throw error;
        } finally {
            this.clipboardSending = false;
        }
    }

    public async disconnect() {
        if (this.connectedPeripheral) {
            console.log('Disconnecting from Bluetooth peripheral...')
            try {
                await this.connectedPeripheral.disconnectAsync();
                console.log('Bluetooth disconnected cleanly.');
            } catch (err) {
                console.error('Error during Bluetooth disconnect', err)
            } finally {
                this.connectedPeripheral = null;
                this.targetCharacteristics = null;
                this.clipboardDataCharacteristic = null;
                this.detachClipboardStatusListener();
                this.clipboardStatusCharacteristic = null;
                this.failPendingClipboardTransfers(new Error('Bluetooth disconnected during clipboard transfer.'));
                this.setConnectionState('disconnected');
            }
        }
    }

    private failPendingClipboardTransfers(error: Error) {
        for (const pending of this.pendingClipboardTransfers.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pendingClipboardTransfers.clear();
    }

    private detachClipboardStatusListener() {
        if (this.clipboardStatusCharacteristic && this.clipboardStatusListener) {
            this.clipboardStatusCharacteristic.removeListener('data', this.clipboardStatusListener);
        }
        this.clipboardStatusListener = null;
    }

    private setConnectionState(state: ConnectionState) {
        this.connectionState = state;
        this.emit('connectionStateChanged', state, this.connectedPeripheral ? this.toDeviceInfo(this.connectedPeripheral) : null);
    }

    private toDeviceInfo(peripheral: Peripheral): BluetoothDevice {
        return {
            id: peripheral.id,
            name: peripheral.advertisement?.localName || 'Unknown Device',
            rssi: peripheral.rssi,
            connectable: peripheral.connectable,
        };
    }
}


export const bluetoothManager = new BluetoothManager()
