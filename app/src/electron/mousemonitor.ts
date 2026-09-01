import { uIOhook } from "uiohook-napi";
import { EventEmitter } from 'node:events';
import { acquireUiohook, releaseUiohook } from './uiohook-lifecycle.js';
import { screen, type Display } from 'electron';

// Bitmask matches a standard USB HID mouse boot report, byte 0.
const BUTTON_LEFT = 0x01;
const BUTTON_RIGHT = 0x02;
const BUTTON_MIDDLE = 0x04;

/** Absolute-pointer coordinate space, DeskHop-style: 0..32767 on both axes. */
export const SCALE = 32767;

/** One movement report per 8 ms (~125 Hz), the rest is coalesced away. */
export const MOVE_REPORT_INTERVAL_MS = 8;

/**
 * Minimum pixel delta for an edge hit to count as a deliberate "throw" of the
 * cursor across the screen border. Slow drifts along the edge must not switch.
 */
export const JUMP_THRESHOLD_PX = 3;

export type MouseMode = 'absolute' | 'relative';

/** Which edge of PC2's virtual screen leads back to PC1. */
export type ReturnEdge = 'left' | 'right' | 'top' | 'bottom';

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

function clampToScale(value: number): number {
    return Math.max(0, Math.min(SCALE, value));
}

export class MouseMonitor extends EventEmitter {
    private _isRunning = false;
    private pressedButtons = 0x00;
    private mode: MouseMode = 'relative';

    // Baseline for turning uiohook's absolute x/y into relative deltas.
    private lastX: number | null = null;
    private lastY: number | null = null;

    // --- absolute mode state ---
    // Virtual cursor on PC2, kept fractional so slow motion isn't lost to rounding.
    private vx = 0;
    private vy = 0;
    private unitsPerPxX = 1;
    private unitsPerPxY = 1;
    private returnEdge: ReturnEdge = 'left';
    private seeded = false;

    // Trailing-edge coalescing for movement reports.
    private lastMoveSentAt = 0;
    private moveTimer: NodeJS.Timeout | null = null;

    public get isRunning() {
        return this._isRunning;
    }

    constructor() {
        super();

        uIOhook.on('mousemove', (e) => this.handleMove(e.x, e.y));

        uIOhook.on('mousedown', (e) => {
            if (!this._isRunning) return;
            this.pressedButtons |= hidButtonBit(e.button);
            this.sendImmediate();
        });

        uIOhook.on('mouseup', (e) => {
            if (!this._isRunning) return;
            this.pressedButtons &= ~hidButtonBit(e.button);
            this.sendImmediate();
        });

        uIOhook.on('wheel', (e) => {
            if (!this._isRunning) return;
            // Vertical scroll only for now; horizontal (direction===HORIZONTAL) is dropped.
            const wheel = e.direction === 3 ? clampToInt8(-e.rotation) : 0;
            if (wheel !== 0) this.sendImmediate(wheel);
        });
    }

    /**
     * Seed the virtual cursor for absolute mode. Called by main.ts when a
     * dynamic switch fires, before start(): `display` is the PC1 display the
     * cursor left from, so a full sweep of it spans PC2's whole screen.
     */
    public seedPosition(vx: number, vy: number, display: Display, returnEdge: ReturnEdge) {
        this.vx = clampToScale(vx);
        this.vy = clampToScale(vy);
        this.unitsPerPxX = SCALE / Math.max(1, display.bounds.width - 1);
        this.unitsPerPxY = SCALE / Math.max(1, display.bounds.height - 1);
        this.returnEdge = returnEdge;
        this.seeded = true;
    }

    /**
     * `returnEdge` is only consulted when start() has to self-seed (manual
     * keybind switch); a dynamic switch has already set it via seedPosition().
     */
    public start(mode: MouseMode = 'relative', returnEdge?: ReturnEdge) {
        if (this._isRunning) return;
        acquireUiohook();
        this.mode = mode;
        if (!this.seeded && returnEdge) this.returnEdge = returnEdge;
        this.lastX = null;
        this.lastY = null;
        this.lastMoveSentAt = 0;
        // Manual keybind switch: nobody seeded us, so take over from wherever
        // the real cursor happens to be.
        if (mode === 'absolute' && !this.seeded) this.seedFromCursor();
        this._isRunning = true;
    }

    public stop() {
        if (!this._isRunning) return;
        this._isRunning = false;
        releaseUiohook();
        this.clearMoveTimer();
        this.pressedButtons = 0x00;
        this.lastX = null;
        this.lastY = null;

        if (this.mode === 'absolute') {
            // Release any buttons the dongle thinks are still held, at the last
            // known position so PC2's cursor doesn't jump on the way out.
            this.sendAbsoluteReport(0);
            this.seeded = false;
        } else {
            // Release any buttons the dongle thinks are still held.
            this.sendRelativeReport(0, 0, 0);
        }
    }

    /** Normalize the real cursor into 0..32767 on the display it currently sits on. */
    private seedFromCursor() {
        const point = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(point);
        const { x, y, width, height } = display.bounds;
        const vx = ((point.x - x) / Math.max(1, width - 1)) * SCALE;
        const vy = ((point.y - y) / Math.max(1, height - 1)) * SCALE;
        // returnEdge is meaningless here (no crossing happened) - keep the last
        // one so a manual switch can still be ended by pushing back.
        this.seedPosition(vx, vy, display, this.returnEdge);
    }

    private handleMove(x: number, y: number) {
        if (!this._isRunning) return;

        if (this.lastX === null || this.lastY === null) {
            this.lastX = x;
            this.lastY = y;
            return;
        }

        const dx = x - this.lastX;
        const dy = y - this.lastY;
        this.lastX = x;
        this.lastY = y;

        if (dx !== 0 || dy !== 0) {
            this.applyDelta(dx, dy);
        }
    }

    /**
     * Single entry point for "a raw pixel delta happened" - kept separate from
     * the uiohook handler so a pointer-captured overlay window can feed it later.
     *
     * Known limitation: while forwarding, the local macOS cursor pins against
     * the physical screen edge, so coordinate-derived deltas collapse to zero
     * exactly at the edges. The overlay will replace this delta source.
     */
    public applyDelta(dx: number, dy: number) {
        if (!this._isRunning) return;

        if (this.mode === 'relative') {
            this.sendRelativeReport(clampToInt8(dx), clampToInt8(dy), 0);
            return;
        }

        this.vx = clampToScale(this.vx + dx * this.unitsPerPxX);
        this.vy = clampToScale(this.vy + dy * this.unitsPerPxY);

        // Pushed back out through the edge that faces PC1 - hand control home
        // and swallow this movement so PC2 doesn't see the last shove. Only the
        // delta perpendicular to that edge counts towards the speed gate.
        let returning: boolean;
        switch (this.returnEdge) {
            case 'left': returning = this.vx <= 0 && dx < 0 && Math.abs(dx) > JUMP_THRESHOLD_PX; break;
            case 'right': returning = this.vx >= SCALE && dx > 0 && Math.abs(dx) > JUMP_THRESHOLD_PX; break;
            case 'top': returning = this.vy <= 0 && dy < 0 && Math.abs(dy) > JUMP_THRESHOLD_PX; break;
            case 'bottom': returning = this.vy >= SCALE && dy > 0 && Math.abs(dy) > JUMP_THRESHOLD_PX; break;
        }
        if (returning) {
            this.emit('edge-return');
            return;
        }

        this.queueMoveReport();
    }

    // --- report plumbing ---

    /** Movement is rate-limited; the newest position wins on the trailing edge. */
    private queueMoveReport() {
        if (this.moveTimer) return;

        const elapsed = Date.now() - this.lastMoveSentAt;
        if (elapsed >= MOVE_REPORT_INTERVAL_MS) {
            this.sendAbsoluteReport(0);
            return;
        }

        this.moveTimer = setTimeout(() => {
            this.moveTimer = null;
            if (this._isRunning) this.sendAbsoluteReport(0);
        }, MOVE_REPORT_INTERVAL_MS - elapsed);
    }

    /** Buttons and wheel bypass the rate limit - they carry the current position. */
    private sendImmediate(wheel = 0) {
        if (this.mode === 'relative') {
            this.sendRelativeReport(0, 0, wheel);
            return;
        }
        this.clearMoveTimer();
        this.sendAbsoluteReport(wheel);
    }

    private clearMoveTimer() {
        if (!this.moveTimer) return;
        clearTimeout(this.moveTimer);
        this.moveTimer = null;
    }

    private sendAbsoluteReport(wheel: number) {
        // 6-byte absolute mouse report: [buttons, x (uint16 LE), y (uint16 LE), wheel (int8)].
        // Distinct in length from the 4-byte relative report and the 8-byte keyboard
        // report, so firmware's hid_decode() can keep dispatching on pkt.len.
        const report = Buffer.alloc(6, 0);
        report[0] = this.pressedButtons;
        report.writeUInt16LE(Math.round(this.vx), 1);
        report.writeUInt16LE(Math.round(this.vy), 3);
        report.writeInt8(wheel, 5);

        this.lastMoveSentAt = Date.now();
        console.log('Sending absolute mouse report to BLE: ', report);
        this.emit('hid-report', report);
    }

    private sendRelativeReport(dx: number, dy: number, wheel: number) {
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
