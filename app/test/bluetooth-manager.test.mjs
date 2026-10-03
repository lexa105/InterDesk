import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
const mockUrl = new URL('./fixtures/native.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
    return specifier === '@stoprocent/noble' ? { url: mockUrl, shortCircuit: true } : next(specifier, context);
} });
const { noble } = await import(mockUrl);
const { bluetoothManager: manager } = await import('../dist-electron/bluetooth-manager.js');
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
Object.defineProperty(process, 'platform', { value: 'darwin' });
process.on('exit', () => Object.defineProperty(process, 'platform', platform));
manager.initialize();
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function device(id = 'dongle') {
    const writes = [];
    const control = { uuid: '1236', properties: ['read', 'write'], readAsync: async () => Buffer.from([2]),
        writeAsync: async (data, withoutResponse) => { writes.push({ data, withoutResponse }); } };
    const hid = { uuid: '1235', properties: ['write'], writeAsync: control.writeAsync };
    const peripheral = Object.assign(new EventEmitter(), {
        id, connectable: true, rssi: -55, state: 'disconnected',
        advertisement: { localName: 'InterDesk Dongle', serviceUuids: ['b00b'] },
        async connectAsync() { this.state = 'connected'; },
        async disconnectAsync() { this.state = 'disconnected'; this.emit('disconnect'); },
        cancelConnect() { this.state = 'disconnected'; },
        async discoverSomeServicesAndCharacteristicsAsync(services, characteristics) {
            assert.deepEqual(services, ['b00b']);
            assert.deepEqual(characteristics, ['1235', '1236']);
            return { characteristics: [hid, control] };
        },
    });
    noble.emit('discover', peripheral);
    return { peripheral, control, hid, writes };
}

test('initialization returns with powered-off Bluetooth and scanning reports an actionable error', async () => {
    noble.state = 'poweredOff';
    manager.initialize();
    await assert.rejects(manager.startScanning(), /Turn on Bluetooth/);
    assert.equal(await manager.isBluetoothAvailable(), false);
    noble.state = 'poweredOn';
});

test('scans only the InterDesk service and ignores unrelated advertisements', async () => {
    await manager.startScanning();
    assert.deepEqual(noble.scannedServices, ['b00b']);
    noble.emit('discover', { id: 'other', advertisement: { serviceUuids: ['1234'] } });
    assert.deepEqual(manager.getDiscoveredDevices(), []);
    await manager.stopScanning();
});

test('connection is not ready for input until protected version read and reset finish', async t => {
    const { control, writes } = device();
    let authenticate;
    control.readAsync = () => new Promise(resolve => { authenticate = resolve; });
    const connecting = manager.connect('dongle');
    t.after(() => manager.disconnect());
    await flush();
    assert.equal(manager.getConnectionState(), 'connecting');
    manager.sendHidReport(Buffer.alloc(8));
    assert.equal(writes.length, 0);
    authenticate(Buffer.from([2]));
    await connecting;
    assert.equal(manager.getConnectionState(), 'connected');
    assert.deepEqual(writes[0], { data: Buffer.from([0]), withoutResponse: false });
    assert.equal(manager.getConnectedDevice().id, 'dongle');
});

test('legacy dongle cannot be reported as connected', async () => {
    const { peripheral } = device();
    peripheral.discoverSomeServicesAndCharacteristicsAsync = async () => ({ characteristics: [] });
    await assert.rejects(manager.connect('dongle'), /incompatible/);
    assert.equal(manager.getConnectionState(), 'disconnected');
    assert.equal(peripheral.state, 'disconnected');
});

test('disconnect during pairing invalidates a late authentication result', async () => {
    const { control, writes } = device();
    let authenticate;
    control.readAsync = () => new Promise(resolve => { authenticate = resolve; });
    const connecting = manager.connect('dongle');
    const rejection = assert.rejects(connecting, /cancelled/);
    await flush();
    await manager.disconnect();
    authenticate(Buffer.from([2]));
    await rejection;
    assert.equal(manager.getConnectionState(), 'disconnected');
    assert.equal(writes.length, 0);
});

test('an old peripheral disconnect cannot clear a new connection', async t => {
    const old = device('old');
    await manager.connect('old');
    device('new');
    await manager.connect('new');
    t.after(() => manager.disconnect());
    old.peripheral.emit('disconnect');
    assert.equal(manager.getConnectedDevice().id, 'new');
});

test('turning Bluetooth off invalidates the connected session', async () => {
    device();
    await manager.connect('dongle');
    noble.emit('stateChange', 'poweredOff');
    assert.equal(manager.getConnectionState(), 'disconnected');
});

test('late native connection after cancellation is closed and cannot race a retry', async () => {
    const { peripheral } = device('late');
    let complete;
    peripheral.connectAsync = async () => {
        peripheral.state = 'connecting';
        await new Promise(resolve => { complete = resolve; });
        peripheral.state = 'connected';
    };
    const attempt = manager.connect('late');
    const rejection = assert.rejects(attempt, /cancelled/);
    await flush();
    await manager.disconnect();
    await rejection;
    await assert.rejects(manager.connect('late'), /earlier connection/);
    complete();
    await flush();
    assert.equal(peripheral.state, 'disconnected');
    assert.equal(manager.getConnectionState(), 'disconnected');
});
