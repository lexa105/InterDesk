import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';

export type ReportKind = 'motion' | 'input' | 'control';
export const MAX_INPUT_AGE_MS = 100;
export const WRITE_TIMEOUT_MS = 250;
export const MAX_PENDING_REPORTS = 32;
export const HEARTBEAT_INTERVAL_MS = 250;

interface PendingReport {
    data: Buffer;
    kind: ReportKind;
    createdAt: number;
}

/**
 * One acknowledged ATT write at a time. A write-without-response completion
 * only means the OS accepted it and can hide an unbounded controller backlog.
 * Motion coalesces between input transitions; clicks/keys keep their ordering.
 */
export class HidTransport {
    private pending: PendingReport[] = [];
    private generation = 0;
    private active = false;
    private writing = false;
    private timeout: ReturnType<typeof setTimeout> | undefined;
    private heartbeat: ReturnType<typeof setInterval> | undefined;

    constructor(
        private readonly write: (data: Buffer, kind: ReportKind) => Promise<void>,
        private readonly onFault: (error: Error) => void,
        private readonly now: () => number = () => performance.now(),
    ) {}

    start() {
        this.stop();
        this.active = true;
        this.heartbeat = setInterval(() => {
            if (!this.writing && this.pending.length === 0) {
                this.send(Buffer.from([1]), 'control');
            }
        }, HEARTBEAT_INTERVAL_MS);
        this.heartbeat.unref();
    }

    stop() {
        this.generation++;
        this.active = false;
        this.writing = false;
        this.pending = [];
        clearTimeout(this.timeout);
        clearInterval(this.heartbeat);
    }

    /** Discard unsent input when switching home, then release all remote controls. */
    resetInput() {
        this.pending = [];
        this.send(Buffer.from([0]), 'control');
    }

    send(data: Buffer, kind: ReportKind = 'input') {
        if (!this.active) return;
        const createdAt = this.now();
        const tail = this.pending[this.pending.length - 1];
        const report = Buffer.from(data);
        let retainedAt = createdAt;
        if (kind === 'motion' && tail?.kind === 'motion' &&
            tail.data.length === report.length && tail.data[0] === report[0]) {
            // Accumulate relative deltas only while fresh, bounded to one HID
            // report. Never drain overflow in a later burst after a stall.
            if (report.length === 4 && createdAt - tail.createdAt <= MAX_INPUT_AGE_MS) {
                // Keep the oldest delta's age. Continuous new events must not
                // keep an old accumulated movement alive indefinitely.
                retainedAt = tail.createdAt;
                for (const offset of [1, 2]) {
                    report.writeInt8(Math.max(-127, Math.min(127,
                        tail.data.readInt8(offset) + report.readInt8(offset))), offset);
                }
            }
            this.pending[this.pending.length - 1] = { data: report, kind, createdAt: retainedAt };
        } else {
            if (this.pending.length >= MAX_PENDING_REPORTS) {
                this.fail(new Error('Input queue overflow; forwarding stopped.'));
                return;
            }
            this.pending.push({ data: report, kind, createdAt });
        }
        void this.pump();
    }

    private async pump() {
        if (!this.active || this.writing) return;
        let report: PendingReport | undefined;
        while ((report = this.pending.shift())) {
            if (this.now() - report.createdAt <= MAX_INPUT_AGE_MS) break;
            if (report.kind !== 'motion') {
                this.fail(new Error('Input stalled; stale key/button events discarded.'));
                return;
            }
        }
        if (!report) return;

        const generation = this.generation;
        const startedAt = this.now();
        this.writing = true;
        this.timeout = setTimeout(() => {
            if (generation === this.generation) {
                this.fail(new Error('Bluetooth write timed out; forwarding stopped.'));
            }
        }, WRITE_TIMEOUT_MS);
        try {
            await this.write(report.data, report.kind);
            if (generation !== this.generation) return;
            // Timers can also be delayed by an event-loop stall. Check the
            // monotonic clock before allowing the next write through.
            if (this.now() - startedAt >= WRITE_TIMEOUT_MS) {
                this.fail(new Error('Bluetooth stalled; queued input discarded.'));
                return;
            }
        } catch (error) {
            if (generation === this.generation) {
                this.fail(error instanceof Error ? error : new Error(String(error)));
            }
            return;
        } finally {
            if (generation === this.generation) {
                clearTimeout(this.timeout);
                this.writing = false;
            }
        }
        if (generation === this.generation) void this.pump();
    }

    private fail(error: Error) {
        this.stop();
        this.onFault(error);
    }
}
