import { withBindings, Peripheral } from '@stoprocent/noble';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

// 'default' automatically selects the right driver for Windows, Mac, or Linux
const noble = withBindings('default');

const HID_CHARACTERISTIC_UUID = '1235';

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
    private targetCharacteristics: any = null;
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
                this.setConnectionState('disconnected');
            });

            const { services, characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();

            console.log("Found Services:", services.map(s => s.uuid));
            console.log("Found Characteristics:", characteristics.map(c => c.uuid));

            const hidChar = characteristics.find(c => c.uuid === HID_CHARACTERISTIC_UUID);
            if (hidChar) {
                this.targetCharacteristics = hidChar;
                console.log('Target characteristic (1235) found and set!');
            } else {
                console.warn('Target characteristic (1235) NOT found on this device.');
            }

            this.setConnectionState('connected');
        } catch (err) {
            this.connectedPeripheral = null;
            this.setConnectionState('disconnected');
            throw err;
        }
    }

    public async sendData(peripheral: Peripheral, serviceUuid: string, charUuid: string, data: any) {
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
            console.log(`HID report sent ${withoutResponse ? 'without' : 'with'} response:`, report)
        } catch (e) {
            console.error("Failed to send HID report: ", e)
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
                this.setConnectionState('disconnected');
            }
        }
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
