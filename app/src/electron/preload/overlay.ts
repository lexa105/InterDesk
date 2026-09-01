import { ipcRenderer } from 'electron';

// Preload for the invisible capture overlay window. The page itself is empty
// (a data: URL with a bare <body>), so everything lives here - there is nothing
// to expose to page scripts and therefore no contextBridge.
//
// Purpose: hold pointer lock while input is forwarded to PC2. Under lock the
// browser reports raw movementX/movementY, which - unlike cursor coordinates -
// keep counting once the real cursor has pinned against the physical screen edge.

let lastReportedLock: boolean | null = null;

function reportLockState() {
    const locked = document.pointerLockElement === document.body;
    if (locked === lastReportedLock) return;
    lastReportedLock = locked;
    ipcRenderer.send('overlay:lock-state', locked);
}

function requestLock() {
    if (document.pointerLockElement === document.body) return;
    try {
        document.body.requestPointerLock();
    } catch {
        // Not gesture-backed yet - main will synthesize a click and we retry
        // from the mousedown handler below.
        reportLockState();
    }
}

function swallow(event: Event) {
    event.preventDefault();
    event.stopPropagation();
}

window.addEventListener('DOMContentLoaded', () => {
    // Nearly-transparent rather than fully transparent: on some platforms a
    // 100% transparent region is click-through, and this window has to eat the
    // clicks that would otherwise land on local apps.
    const style = document.createElement('style');
    style.textContent = `
        html, body {
            margin: 0;
            padding: 0;
            width: 100vw;
            height: 100vh;
            overflow: hidden;
            cursor: none;
            background: rgba(0, 0, 0, 0.004);
            user-select: none;
        }
    `;
    document.head.appendChild(style);

    document.addEventListener('pointerlockchange', () => {
        const locked = document.pointerLockElement === document.body;
        reportLockState();
        // Lost the lock while we are still on screen (macOS Escape, focus
        // hiccup): one self-service retry, then it is main's problem - its
        // synthetic-click loop can re-acquire with a fresh user gesture.
        if (!locked && document.visibilityState === 'visible') requestLock();
    });

    document.addEventListener('pointerlockerror', () => {
        lastReportedLock = null;
        reportLockState();
    });

    document.addEventListener('mousemove', (e) => {
        if (e.movementX === 0 && e.movementY === 0) return;
        ipcRenderer.send('overlay:delta', e.movementX, e.movementY);
    });

    // Buttons and wheel are deliberately NOT forwarded: uiohook already captures
    // them globally in MouseMonitor, and sending them here too would double-send.
    document.addEventListener('mousedown', (e) => {
        swallow(e);
        // Runs inside a real (or synthesized) user gesture, which is exactly the
        // transient activation requestPointerLock() wants.
        requestLock();
    });
    document.addEventListener('mouseup', swallow);
    document.addEventListener('click', swallow);
    document.addEventListener('dblclick', swallow);
    document.addEventListener('auxclick', swallow);
    document.addEventListener('contextmenu', swallow);
    document.addEventListener('wheel', swallow, { passive: false });
    document.addEventListener('dragstart', swallow);
    document.addEventListener('selectstart', swallow);
    document.addEventListener('keydown', swallow);
    document.addEventListener('keypress', swallow);
    document.addEventListener('keyup', swallow);

    requestLock();
    reportLockState();
});
