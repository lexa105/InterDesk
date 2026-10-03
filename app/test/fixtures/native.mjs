import { EventEmitter } from 'node:events';
export const uIOhook = Object.assign(new EventEmitter(), { start() {}, stop() {} });
export const UiohookKey = { Ctrl: 29, CtrlRight: 3613, Shift: 42, ShiftRight: 54,
    Alt: 56, AltRight: 3640, Meta: 3675, MetaRight: 3676, Delete: 3667, Insert: 3666, R: 19 };
const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
export const screen = { getCursorScreenPoint: () => ({ x: 960, y: 540 }), getDisplayNearestPoint: () => display };
export const noble = Object.assign(new EventEmitter(), {
    state: 'poweredOn',
    async startScanningAsync(services) { this.scannedServices = services; this.emit('scanStart'); },
    async stopScanningAsync() { this.emit('scanStop'); },
});
export const withBindings = () => noble;
