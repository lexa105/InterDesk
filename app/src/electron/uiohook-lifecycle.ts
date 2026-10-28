import { systemPreferences } from 'electron';
import { uIOhook } from 'uiohook-napi';

// uIOhook is a single process-wide hook shared by KeyMonitor and MouseMonitor,
// but the two monitors start and stop independently (forwardKeyboard and
// forwardMouse are separate settings). Refcount the consumers so the hook runs
// while at least one monitor needs events and stops when the last one lets go.
let consumers = 0;
let hookRunning = false;

// On macOS, uIOhook.start() without Accessibility permission doesn't throw —
// the native addon calls abort() and takes the whole app down. Check first;
// passing `true` makes macOS show its "grant Accessibility" prompt.
function hasInputPermission(): boolean {
    if (process.platform !== 'darwin') return true;
    return systemPreferences.isTrustedAccessibilityClient(true);
}

export function acquireUiohook() {
    consumers++;
    if (hookRunning) return;
    if (!hasInputPermission()) {
        console.warn('uiohook not started: Accessibility permission missing. Grant it in System Settings → Privacy & Security → Accessibility, then toggle capture again.');
        return;
    }
    uIOhook.start();
    hookRunning = true;
}

export function releaseUiohook() {
    if (consumers === 0) return;
    consumers--;
    if (consumers === 0 && hookRunning) {
        uIOhook.stop();
        hookRunning = false;
    }
}
