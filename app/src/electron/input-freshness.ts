import { performance } from 'node:perf_hooks';
import { MAX_INPUT_AGE_MS } from './hid-transport.js';

/** Map libuiohook's native clock to the JS monotonic clock without assuming a shared epoch. */
export class InputFreshness {
    private offset = Infinity;
    private previous = 0;
    private wraps = 0;

    constructor(private readonly platform: NodeJS.Platform = process.platform) {}

    isFresh(timestamp: number, now = performance.now()): boolean {
        if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
        // CGEvent timestamps are nanoseconds; Windows/X11 use wrapping u32 ms.
        const raw = this.platform === 'darwin' ? timestamp / 1e6 : timestamp >>> 0;
        if (this.platform !== 'darwin' && this.previous - raw > 0x80000000) this.wraps += 0x100000000;
        this.previous = raw;
        const time = raw + this.wraps;
        // Only reduce the offset. A delayed batch must not recalibrate itself
        // as fresh. Normal delivery provides the closest clock alignment.
        this.offset = Math.min(this.offset, now - time);
        return now - time - this.offset <= MAX_INPUT_AGE_MS;
    }
}
