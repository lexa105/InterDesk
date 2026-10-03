import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../dist-electron/settings-validation.js';

test('invalid settings cannot activate unexpected modes or produce invalid cursor geometry', () => {
    const settings = sanitizeSettings({ switchKeybind: 'bad', forwardKeyboard: 'false', dynamicSwitch: null,
        pc2Layout: { side: 'diagonal', offset: Infinity, scale: NaN }, mouseMode: false });
    assert.deepEqual(settings, DEFAULT_SETTINGS);
    assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
});

test('old side settings migrate and geometry is bounded', () => {
    assert.equal(sanitizeSettings({ pc2Side: 'left' }).pc2Layout.side, 'left');
    assert.deepEqual(sanitizeSettings({ pc2Layout: { side: 'top', scale: 0, offset: -100 } }).pc2Layout,
        { side: 'top', scale: 0.05, offset: -10 });
});

test('defaults and successive settings objects do not share a mutable layout', () => {
    const first = sanitizeSettings({});
    first.pc2Layout.side = 'bottom';
    assert.equal(sanitizeSettings({}).pc2Layout.side, 'right');
});
