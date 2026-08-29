import { uIOhook } from 'uiohook-napi';
import { EventEmitter } from 'node:events';
import { screen, type Display } from 'electron';
import { acquireUiohook, releaseUiohook } from './uiohook-lifecycle.js';
import { settingsStore } from './settings-store.js';
import { SCALE, JUMP_THRESHOLD_PX, type ReturnEdge } from './mousemonitor.js';

/** Payload handed to MouseMonitor.seedPosition() when the cursor hops to PC2. */
export interface EdgeCrossing {
    vx: number;
    vy: number;
    display: Display;
    returnEdge: ReturnEdge;
}

/**
 * Watches the local cursor while input is NOT being forwarded and detects the
 * DeskHop-style "throw" across the screen border that faces PC2. Only armed in
 * LOCAL mode - once forwarding is on, MouseMonitor owns the edges instead.
 */
class EdgeSwitcher extends EventEmitter {
    private enabled = false;

    // Baseline for turning uiohook's absolute x/y into deltas.
    private lastX: number | null = null;
    private lastY: number | null = null;

    public get isEnabled() {
        return this.enabled;
    }

    constructor() {
        super();
        uIOhook.on('mousemove', (e) => this.handleMove(e.x, e.y));
    }

    public setEnabled(enabled: boolean) {
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        if (enabled) {
            this.lastX = null;
            this.lastY = null;
            acquireUiohook();
        } else {
            releaseUiohook();
        }
    }

    private handleMove(x: number, y: number) {
        if (!this.enabled) return;

        if (this.lastX === null || this.lastY === null) {
            this.lastX = x;
            this.lastY = y;
            return;
        }

        const dx = x - this.lastX;
        const dy = y - this.lastY;
        this.lastX = x;
        this.lastY = y;

        const layout = settingsStore.get().pc2Layout;
        const horizontal = layout.side === 'left' || layout.side === 'right';

        // Speed gate: slow drifts along the border must not switch machines, so
        // only the component perpendicular to the shared edge counts.
        if (Math.abs(horizontal ? dx : dy) <= JUMP_THRESHOLD_PX) return;

        const display = screen.getDisplayNearestPoint({ x, y });
        const bounds = display.bounds;

        let crossed: boolean;
        switch (layout.side) {
            case 'left': crossed = x <= bounds.x && dx < 0; break;
            case 'right': crossed = x >= bounds.x + bounds.width - 1 && dx > 0; break;
            case 'top': crossed = y <= bounds.y && dy < 0; break;
            case 'bottom': crossed = y >= bounds.y + bounds.height - 1 && dy > 0; break;
        }
        if (!crossed) return;

        // Where along PC1's shared edge the cursor left, then the same point
        // expressed in PC2's edge - offset/scale describe how the two screens
        // are slid and sized relative to each other.
        const frac = horizontal
            ? (y - bounds.y) / Math.max(1, bounds.height - 1)
            : (x - bounds.x) / Math.max(1, bounds.width - 1);
        const t = (frac - layout.offset) / layout.scale;
        // This stretch of border has no PC2 behind it - stay home.
        if (t < 0 || t > 1) return;

        // The cursor enters PC2 on the opposite edge from the one it left, and
        // that same edge is the way back home.
        const crossing: EdgeCrossing = horizontal
            ? {
                vx: layout.side === 'left' ? SCALE : 0,
                vy: t * SCALE,
                display,
                returnEdge: layout.side === 'left' ? 'right' : 'left',
            }
            : {
                vx: t * SCALE,
                vy: layout.side === 'top' ? SCALE : 0,
                display,
                returnEdge: layout.side === 'top' ? 'bottom' : 'top',
            };
        this.emit('crossed', crossing);
    }
}

export const edgeSwitcher = new EdgeSwitcher();
