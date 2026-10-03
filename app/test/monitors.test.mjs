import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
const mockUrl = new URL('./fixtures/native.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
    return ['electron', 'uiohook-napi'].includes(specifier) ? { url: mockUrl, shortCircuit: true } : next(specifier, context);
} });
const { uIOhook } = await import(mockUrl);
const { MouseMonitor } = await import('../dist-electron/mousemonitor.js');
const { KeyMonitor } = await import('../dist-electron/keymonitor.js');
function emit(type, values) {
    const time = performance.now() + 1e6;
    const e = { ...values, time: process.platform === 'darwin' ? time * 1e6 : time };
    uIOhook.emit('input', e);
    uIOhook.emit(type, e);
}
function monitor(t, kind = 'mouse') {
    const instance = kind === 'mouse' ? new MouseMonitor() : new KeyMonitor();
    const reports = [];
    instance.on('hid-report', (data, kind) => reports.push({ data, kind }));
    t.after(() => instance.stop());
    return { instance, reports };
}

test('Delete and Insert generate the correct HID usages', t => {
    const { instance, reports } = monitor(t, 'keyboard');
    instance.start();
    emit('keydown', { keycode: 3667 });
    emit('keyup', { keycode: 3667 });
    emit('keydown', { keycode: 3666 });
    assert.equal(reports[0].data[2], 0x4c);
    assert.equal(reports[2].data[2], 0x49);
});

test('keyboard overflow signals rollover and recovers on release', t => {
    const { instance, reports } = monitor(t, 'keyboard');
    instance.start();
    for (const keycode of [30,31,32,33,34,35,36]) emit('keydown', { keycode });
    assert.deepEqual([...reports.at(-1).data.subarray(2)], [1,1,1,1,1,1]);
    emit('keyup', { keycode: 36 });
    assert.deepEqual([...reports.at(-1).data.subarray(2)], [4,22,7,9,10,11]);
    instance.stop();
    assert.deepEqual(reports.at(-1).data, Buffer.alloc(8));
});

test('pointer lock selects raw input exclusively and resets the fallback baseline', t => {
    const { instance, reports } = monitor(t);
    instance.start('relative');
    instance.setPointerLocked(true);
    emit('mousemove', { x: 100, y: 100 });
    emit('mousemove', { x: 200, y: 200 });
    assert.equal(reports.length, 0);
    instance.applyDelta(3, 4);
    assert.deepEqual(reports[0].data, Buffer.from([0,3,4,0]));
    instance.setPointerLocked(false);
    emit('mousemove', { x: 300, y: 300 });
    assert.equal(reports.length, 1);
});

test('manual-only switching does not return at an absolute edge', t => {
    const { instance } = monitor(t);
    instance.setEdgeReturnEnabled(false);
    instance.seedPosition(0, 100, { bounds: { width: 1920, height: 1080 } }, 'left');
    instance.start('absolute');
    let returns = 0;
    instance.on('edge-return', () => returns++);
    instance.applyDelta(-10, 0);
    assert.equal(returns, 0);
    instance.setEdgeReturnEnabled(true);
    instance.applyDelta(-10, 0);
    assert.equal(returns, 1);
});

test('the switch shortcut trigger is consumed before it can run on the target computer', t => {
    const { instance, reports } = monitor(t, 'keyboard');
    instance.setSwitchKeybind('Ctrl+Shift+R');
    instance.start();
    emit('keydown', { keycode: 29 });
    emit('keydown', { keycode: 42 });
    emit('keydown', { keycode: 19 });
    assert.deepEqual(reports.at(-1).data, Buffer.alloc(8));
    assert.ok(reports.every(report => !report.data.subarray(2).includes(0x15)));
});
