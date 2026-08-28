import { uIOhook } from 'uiohook-napi';

// uIOhook is a single process-wide hook shared by KeyMonitor and MouseMonitor,
// but the two monitors start and stop independently (forwardKeyboard and
// forwardMouse are separate settings). Refcount the consumers so the hook runs
// while at least one monitor needs events and stops when the last one lets go.
let consumers = 0;

export function acquireUiohook() {
    consumers++;
    if (consumers === 1) uIOhook.start();
}

export function releaseUiohook() {
    if (consumers === 0) return;
    consumers--;
    if (consumers === 0) uIOhook.stop();
}
