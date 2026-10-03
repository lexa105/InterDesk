import test from 'node:test';
import assert from 'node:assert/strict';
import { InputFreshness } from '../dist-electron/input-freshness.js';

test('native backlog after a JS stall stays stale until capture time catches up', () => {
    const clock = new InputFreshness('win32');
    assert.equal(clock.isFresh(1000, 0), true);
    assert.equal(clock.isFresh(1001, 500), false);
    assert.equal(clock.isFresh(1002, 500), false);
    assert.equal(clock.isFresh(1500, 500), true);
});

test('macOS nanosecond timestamps retain the same expiry behavior', () => {
    const clock = new InputFreshness('darwin');
    assert.equal(clock.isFresh(1000e6, 0), true);
    assert.equal(clock.isFresh(1001e6, 500), false);
    assert.equal(clock.isFresh(1500e6, 500), true);
});

test('32-bit native timestamp rollover is not mistaken for a month of backlog', () => {
    const clock = new InputFreshness('win32');
    assert.equal(clock.isFresh(0xfffffff0, 0), true);
    assert.equal(clock.isFresh(16, 32), true);
    assert.equal(clock.isFresh(17, 500), false);
});
