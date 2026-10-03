import type { AppSettings, Pc2Side } from '../shared/contracts.js';

export const DEFAULT_SETTINGS: AppSettings = {
    switchKeybind: 'CommandOrControl+Shift+R',
    forwardKeyboard: true,
    forwardMouse: true,
    dynamicSwitch: true,
    pc2Layout: { side: 'right', offset: 0, scale: 1 },
    mouseMode: 'absolute',
};

export const ACCELERATOR_PATTERN = new RegExp(
    '^((CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|Shift|Super|Meta)\\+)+' +
    '([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Enter|Esc|Escape|Backspace|Delete|Tab|Up|Down|Left|Right|Home|End|PageUp|PageDown|[-=\\[\\]\\\\;\',./`])$'
);
const SIDES: readonly string[] = ['left', 'right', 'top', 'bottom'];

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}
function bounded(value: unknown, fallback: number, min: number, max: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

/** Treat persisted JSON as untrusted too; migrate old layouts without retaining retired keys. */
export function sanitizeSettings(value: unknown): AppSettings {
    const raw = record(value);
    const settings = { ...DEFAULT_SETTINGS, pc2Layout: { ...DEFAULT_SETTINGS.pc2Layout } };
    if (typeof raw.switchKeybind === 'string' && ACCELERATOR_PATTERN.test(raw.switchKeybind)) {
        settings.switchKeybind = raw.switchKeybind;
    }
    for (const key of ['forwardKeyboard', 'forwardMouse', 'dynamicSwitch'] as const) {
        if (typeof raw[key] === 'boolean') settings[key] = raw[key];
    }
    if (raw.mouseMode === 'absolute' || raw.mouseMode === 'relative') settings.mouseMode = raw.mouseMode;
    const layout = record(raw.pc2Layout);
    const side = raw.pc2Layout === undefined ? raw.pc2Side : layout.side;
    if (typeof side === 'string' && SIDES.includes(side)) settings.pc2Layout.side = side as Pc2Side;
    settings.pc2Layout.offset = bounded(layout.offset, 0, -10, 10);
    settings.pc2Layout.scale = bounded(layout.scale, 1, 0.05, 20);
    return settings;
}
