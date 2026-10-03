import { uIOhook } from 'uiohook-napi';
import { InputFreshness } from './input-freshness.js';

const inputClock = new InputFreshness();
const freshness = new WeakMap<object, boolean>();
// Noble/native input callbacks can queue while Electron is stalled. Preserve
// the original capture age before any of the monitor listeners handle it.
uIOhook.on('input', (event) => freshness.set(event, inputClock.isFresh(event.time)));

export function isFreshInput(event: { time: number }): boolean {
    return freshness.get(event) ?? inputClock.isFresh(event.time);
}

// uIOhook is a single process-wide hook shared by KeyMonitor and MouseMonitor,
// but the two monitors start and stop independently (forwardKeyboard and
// forwardMouse are separate settings). Refcount the consumers so the hook runs
// while at least one monitor needs events and stops when the last one lets go.
let consumers = 0;

export function acquireUiohook() {
    if (consumers === 0) uIOhook.start();
    consumers++;
}

export function releaseUiohook() {
    if (consumers === 0) return;
    consumers--;
    if (consumers === 0) uIOhook.stop();
}
