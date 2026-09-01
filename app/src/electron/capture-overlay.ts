import { BrowserWindow, ipcMain, session, type Display } from 'electron';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Own session so the pointer-lock permission handler can't touch the main UI window. */
const OVERLAY_PARTITION = 'bkmd-capture-overlay';

/** How many synthetic-gesture attempts before we settle for the degraded path. */
const LOCK_RETRY_LIMIT = 3;
const LOCK_RETRY_DELAY_MS = 150;

/**
 * An invisible, always-on-top window covering one PC1 display while input is
 * forwarded to PC2. It exists for pointer lock: locked, the renderer reports raw
 * movementX/movementY (unaffected by the real cursor pinning at the physical
 * screen edge), the real cursor is hidden and frozen, and clicks land here
 * instead of on local apps.
 *
 * Without the lock the overlay still swallows clicks and simply sends no deltas,
 * which leaves MouseMonitor on its old uiohook coordinate path - i.e. degraded
 * equals today's behaviour, never worse.
 */
class CaptureOverlay extends EventEmitter {
    private win: BrowserWindow | null = null;
    private locked = false;
    private retries = 0;
    private retryTimer: NodeJS.Timeout | null = null;
    private ipcBound = false;

    public get isShown() {
        return this.win !== null && !this.win.isDestroyed();
    }

    public get isLocked() {
        return this.locked;
    }

    /** Raw pixel deltas from the pointer-locked overlay. */
    public onDelta(callback: (dx: number, dy: number) => void) {
        this.on('delta', callback);
    }

    public show(display: Display) {
        this.bindIpc();

        if (this.isShown) {
            // Idempotent, but a switch can land on a different display.
            this.win!.setBounds(display.bounds);
            if (!this.win!.isVisible()) this.win!.show();
            this.win!.focus();
            return;
        }

        const overlaySession = session.fromPartition(OVERLAY_PARTITION);
        const win = new BrowserWindow({
            ...display.bounds,
            frame: false,
            transparent: true,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            hasShadow: false,
            show: false,
            webPreferences: {
                preload: path.join(__dirname, 'preload/overlay.js'),
                contextIsolation: true,
                sandbox: true,
                session: overlaySession,
            },
        });
        this.win = win;
        this.locked = false;
        this.retries = 0;

        // Scoped twice over: the handler lives on a partition of our own (so the
        // main window's default session keeps Electron's default behaviour), and
        // it still only ever grants pointerLock to this exact webContents.
        overlaySession.setPermissionRequestHandler((contents, permission, callback) => {
            const mine = this.win !== null && !this.win.isDestroyed() && contents === this.win.webContents;
            callback(mine && permission === 'pointerLock');
        });

        win.setAlwaysOnTop(true, 'screen-saver');
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

        win.on('closed', () => {
            if (this.win === win) this.win = null;
        });

        // All behaviour lives in the preload; the page is deliberately empty.
        win.loadURL('data:text/html,<body></body>');
        win.webContents.once('did-finish-load', () => {
            if (win.isDestroyed()) return;
            win.show();
            win.focus();
            this.scheduleLockRetry();
        });
    }

    public hide() {
        this.clearRetryTimer();
        this.retries = 0;
        this.setLocked(false);
        if (!this.isShown) return;
        // Destroying beats hiding: no stale pointer-lock state survives to the
        // next switch, and show() rebuilds the window anyway.
        const win = this.win;
        this.win = null;
        win!.destroy();
        console.log('CaptureOverlay: hidden');
    }

    private bindIpc() {
        if (this.ipcBound) return;
        this.ipcBound = true;

        ipcMain.on('overlay:delta', (event, dx: number, dy: number) => {
            if (!this.isOwn(event.sender)) return;
            if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
            this.emit('delta', dx, dy);
        });

        ipcMain.on('overlay:lock-state', (event, locked: boolean) => {
            if (!this.isOwn(event.sender)) return;
            this.setLocked(Boolean(locked));
            if (this.locked) {
                this.clearRetryTimer();
                this.retries = 0;
            } else {
                this.scheduleLockRetry();
            }
        });
    }

    private isOwn(sender: Electron.WebContents): boolean {
        return this.win !== null && !this.win.isDestroyed() && sender === this.win.webContents;
    }

    private setLocked(locked: boolean) {
        if (locked === this.locked) return;
        this.locked = locked;
        console.log(locked
            ? 'CaptureOverlay: pointer locked - raw deltas active'
            : 'CaptureOverlay: pointer NOT locked - falling back to uiohook deltas');
        this.emit('lock-changed', locked);
    }

    /**
     * requestPointerLock() needs transient user activation, which a
     * programmatically shown window doesn't have. Synthesize a click on the
     * overlay: the preload re-requests from its mousedown handler.
     */
    private scheduleLockRetry() {
        if (this.retryTimer || this.locked || !this.isShown) return;
        if (this.retries >= LOCK_RETRY_LIMIT) return;

        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.locked || !this.isShown) return;
            this.retries++;
            const wc = this.win!.webContents;
            wc.sendInputEvent({ type: 'mouseDown', x: 10, y: 10, button: 'left', clickCount: 1 });
            wc.sendInputEvent({ type: 'mouseUp', x: 10, y: 10, button: 'left', clickCount: 1 });
            if (this.retries >= LOCK_RETRY_LIMIT) {
                console.log('CaptureOverlay: giving up on pointer lock after ' +
                    `${LOCK_RETRY_LIMIT} attempts - clicks are still swallowed, deltas stay on uiohook`);
                return;
            }
            this.scheduleLockRetry();
        }, LOCK_RETRY_DELAY_MS);
    }

    private clearRetryTimer() {
        if (!this.retryTimer) return;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }
}

export const captureOverlay = new CaptureOverlay();
