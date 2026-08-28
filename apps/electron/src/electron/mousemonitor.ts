import { uIOhook } from "uiohook-napi";
import { EventEmitter } from 'node:events';
import { acquireUiohook, releaseUiohook } from './uiohook-lifecycle.js';

// Bitmask matches a standard USB HID mouse boot report, byte 0.
const BUTTON_LEFT = 0x01;
const BUTTON_RIGHT = 0x02;
const BUTTON_MIDDLE = 0x04;

// uiohook-napi's `button` field is typed `unknown` but numeric at runtime, following
// libuiohook's X11-style numbering (1=left, 2=right, 3=middle). Not yet verified on
// Windows/Linux — same caveat as MAC_HID_MAP in keymonitor.ts.
function hidButtonBit(uiohookButton: unknown): number {
    switch (uiohookButton) {
        case 1: return BUTTON_LEFT;
        case 2: return BUTTON_RIGHT;
        case 3: return BUTTON_MIDDLE;
        default: return 0;
    }
}

function clampToInt8(value: number): number {
    return Math.max(-127, Math.min(127, value));
}

export class MouseMonitor extends EventEmitter {
    private _isRunning = false;
    private pressedButtons = 0x00;

    // Baseline for turning uiohook's absolute x/y into relative deltas.
    private lastX: number | null = null;
    private lastY: number | null = null;

    public get isRunning() {
        return this._isRunning;
    }

    constructor() {
        super();

        uIOhook.on('mousemove', (e) => this.handleMove(e.x, e.y));

        uIOhook.on('mousedown', (e) => {
            if (!this._isRunning) return;
            this.pressedButtons |= hidButtonBit(e.button);
            this.sendReport(0, 0, 0);
        });

        uIOhook.on('mouseup', (e) => {
            if (!this._isRunning) return;
            this.pressedButtons &= ~hidButtonBit(e.button);
            this.sendReport(0, 0, 0);
        });

        uIOhook.on('wheel', (e) => {
            if (!this._isRunning) return;
            // Vertical scroll only for now; horizontal (direction===HORIZONTAL) is dropped.
            const wheel = e.direction === 3 ? clampToInt8(-e.rotation) : 0;
            if (wheel !== 0) this.sendReport(0, 0, wheel);
        });
    }

    public start() {
        if (this._isRunning) return;
        acquireUiohook();
        this.lastX = null;
        this.lastY = null;
        this._isRunning = true;
    }

    public stop() {
        if (!this._isRunning) return;
        this._isRunning = false;
        releaseUiohook();
        this.pressedButtons = 0x00;
        this.lastX = null;
        this.lastY = null;

        // Release any buttons the dongle thinks are still held.
        this.sendReport(0, 0, 0);
    }

    private handleMove(x: number, y: number) {
        if (!this._isRunning) return;

        if (this.lastX === null || this.lastY === null) {
            this.lastX = x;
            this.lastY = y;
            return;
        }

        const dx = clampToInt8(x - this.lastX);
        const dy = clampToInt8(y - this.lastY);
        this.lastX = x;
        this.lastY = y;

        if (dx !== 0 || dy !== 0) {
            this.sendReport(dx, dy, 0);
        }
    }

    private sendReport(dx: number, dy: number, wheel: number) {
        // 4-byte mouse report: [buttons, dx (int8), dy (int8), wheel (int8)].
        // Distinct in length from the 8-byte keyboard report and the legacy 1-byte
        // usage-ID packet, so firmware's hid_decode() can dispatch on pkt.len.
        const report = Buffer.alloc(4, 0);
        report[0] = this.pressedButtons;
        report.writeInt8(dx, 1);
        report.writeInt8(dy, 2);
        report.writeInt8(wheel, 3);

        console.log('Sending mouse report to BLE: ', report);
        this.emit('hid-report', report);
    }
}
