import test from 'node:test';
import assert from 'node:assert/strict';
import { HidTransport, MAX_INPUT_AGE_MS, MAX_PENDING_REPORTS, WRITE_TIMEOUT_MS } from '../dist-electron/hid-transport.js';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const absolute = (x, buttons = 0, wheel = 0) => {
    const report = Buffer.alloc(6);
    report[0] = buttons;
    report.writeUInt16LE(x, 1);
    report.writeInt8(wheel, 5);
    return report;
};
const relative = (dx, dy = 0) => Buffer.from([0, dx & 255, dy & 255, 0]);
function harness(t) {
    let now = 0;
    const writes = [], completions = [], errors = [];
    const transport = new HidTransport((data, kind) => {
        writes.push({ data, kind });
        return new Promise((resolve, reject) => completions.push({ resolve, reject }));
    }, error => errors.push(error), () => now);
    transport.start();
    t.after(() => transport.stop());
    return { transport, writes, completions, errors, advance: ms => { now += ms; } };
}

test('a burst of 1000 positions produces one in-flight write and only the latest pending position', async t => {
    const h = harness(t);
    for (let x = 0; x < 1000; x++) h.transport.send(absolute(x), 'motion');
    assert.equal(h.writes.length, 1);
    h.completions[0].resolve(); await flush();
    assert.equal(h.writes.length, 2);
    assert.equal(h.writes[1].data.readUInt16LE(1), 999);
});

test('mouse button and wheel transitions form ordering barriers', async t => {
    const h = harness(t);
    h.transport.send(absolute(1), 'motion');
    h.transport.send(absolute(2), 'motion');
    h.transport.send(absolute(2, 1));
    h.transport.send(absolute(3, 1), 'motion');
    h.transport.send(absolute(4, 1), 'motion');
    h.transport.send(absolute(4, 1, 1));
    h.transport.send(absolute(4, 0));
    for (let i = 0; i < 6; i++) { h.completions[i].resolve(); await flush(); }
    assert.deepEqual(h.writes.map(w => [w.data.readUInt16LE(1), w.data[0], w.data[5]]),
        [[1,0,0], [2,0,0], [2,1,0], [4,1,0], [4,1,1], [4,0,0]]);
});

test('relative motion adds fresh deltas and clips overflow without catch-up reports', async t => {
    const h = harness(t);
    h.transport.send(relative(1), 'motion');
    h.transport.send(relative(100, -80), 'motion');
    h.transport.send(relative(100, -80), 'motion');
    h.completions[0].resolve(); await flush();
    assert.equal(h.writes[1].data.readInt8(1), 127);
    assert.equal(h.writes[1].data.readInt8(2), -127);
    h.completions[1].resolve(); await flush();
    assert.equal(h.writes.length, 2);
});

test('old relative backlog is not folded into a new delta', async t => {
    const h = harness(t);
    h.transport.send(relative(1), 'motion');
    h.transport.send(relative(100), 'motion');
    h.advance(MAX_INPUT_AGE_MS + 1);
    h.transport.send(relative(2), 'motion');
    h.completions[0].resolve(); await flush();
    assert.equal(h.writes[1].data.readInt8(1), 2);
});

test('stale trailing movement expires even if no fresh movement arrives', async t => {
    const h = harness(t);
    h.transport.send(absolute(1), 'motion');
    h.transport.send(absolute(2), 'motion');
    h.advance(MAX_INPUT_AGE_MS + 1);
    h.completions[0].resolve(); await flush();
    assert.equal(h.writes.length, 1);
    assert.equal(h.errors.length, 0);
});

test('stale keyboard transitions stop the session instead of replaying typing', async t => {
    const h = harness(t);
    h.transport.send(Buffer.alloc(8));
    h.transport.send(Buffer.from([0, 0, 4, 0, 0, 0, 0, 0]));
    h.advance(MAX_INPUT_AGE_MS + 1);
    h.completions[0].resolve(); await flush();
    assert.equal(h.writes.length, 1);
    assert.match(h.errors[0].message, /stale/);
});

test('late completion after a stall is checked before draining', async t => {
    const h = harness(t);
    h.transport.send(absolute(1), 'motion');
    h.advance(WRITE_TIMEOUT_MS);
    h.transport.send(absolute(2), 'motion');
    h.completions[0].resolve(); await flush();
    assert.equal(h.writes.length, 1);
    assert.match(h.errors[0].message, /stalled/);
});

test('a driver that never resolves times out and cannot resume sending', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const h = harness(t);
    h.transport.send(absolute(1), 'motion');
    h.transport.send(absolute(2), 'motion');
    t.mock.timers.tick(WRITE_TIMEOUT_MS);
    assert.equal(h.errors.length, 1);
    h.completions[0].resolve(); await flush();
    assert.equal(h.writes.length, 1);
});

test('disconnect/reconnect discards reports and ignores completions from the old session', async t => {
    const h = harness(t);
    h.transport.send(absolute(1), 'motion');
    h.transport.send(absolute(2), 'motion');
    h.transport.stop(); h.transport.start();
    h.transport.send(absolute(3), 'motion');
    h.transport.send(absolute(4), 'motion');
    h.completions[0].resolve(); await flush();
    assert.equal(h.writes.length, 2);
    h.completions[1].resolve(); await flush();
    assert.deepEqual(h.writes.map(w => w.data.readUInt16LE(1)), [1,3,4]);
});

test('queue overflow fails closed instead of losing a release', t => {
    const h = harness(t);
    for (let i = 0; i < MAX_PENDING_REPORTS + 2; i++) h.transport.send(Buffer.alloc(8));
    assert.equal(h.errors.length, 1);
    assert.equal(h.writes.length, 1);
});

test('switching home replaces pending input with release-all', async t => {
    const h = harness(t);
    h.transport.send(absolute(1), 'motion');
    h.transport.send(Buffer.alloc(8));
    h.transport.send(absolute(2), 'motion');
    h.transport.resetInput();
    h.completions[0].resolve(); await flush();
    assert.deepEqual(h.writes[1], { data: Buffer.from([0]), kind: 'control' });
});

test('driver failures stop the queue and surface the error', async t => {
    const h = harness(t);
    h.transport.send(Buffer.alloc(8));
    h.transport.send(Buffer.alloc(8));
    h.completions[0].reject(new Error('adapter lost')); await flush();
    assert.equal(h.errors[0].message, 'adapter lost');
    assert.equal(h.writes.length, 1);
});

test('idle heartbeat shares the same single-write limit', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const h = harness(t);
    t.mock.timers.tick(250);
    assert.deepEqual(h.writes[0], { data: Buffer.from([1]), kind: 'control' });
    h.transport.send(Buffer.alloc(8));
    assert.equal(h.writes.length, 1);
});

test('continuous relative motion does not refresh the lifetime of old accumulated deltas', async t => {
    const h = harness(t);
    h.transport.send(relative(1), 'motion');
    h.transport.send(relative(100), 'motion');
    h.advance(90);
    h.transport.send(relative(1), 'motion');
    h.advance(11);
    h.transport.send(relative(2), 'motion');
    h.completions[0].resolve(); await flush();
    assert.equal(h.writes[1].data.readInt8(1), 2);
});
