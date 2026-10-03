import { UiohookKey } from 'uiohook-napi';

const KEY_NAMES: Record<string, keyof typeof UiohookKey> = {
    Esc: 'Escape', Return: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
    '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
    ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote',
};

export interface SwitchShortcut { keycode: number; modifiers: number; }

/** Collapse left/right HID modifier bits into Ctrl/Shift/Alt/Meta for shortcut matching. */
export function shortcutModifiers(hidModifiers: number): number {
    return (hidModifiers & 0x0f) | (hidModifiers >> 4);
}

export function parseSwitchShortcut(accelerator: string): SwitchShortcut | null {
    const tokens = accelerator.split('+');
    const key = tokens.pop() ?? '';
    const keycode = UiohookKey[KEY_NAMES[key] ?? key as keyof typeof UiohookKey];
    if (keycode === undefined) return null;
    let modifiers = 0;
    for (const token of tokens) {
        switch (token) {
            case 'CommandOrControl': case 'CmdOrCtrl': modifiers |= process.platform === 'darwin' ? 8 : 1; break;
            case 'Control': case 'Ctrl': modifiers |= 1; break;
            case 'Shift': modifiers |= 2; break;
            case 'Alt': case 'Option': modifiers |= 4; break;
            case 'Command': case 'Cmd': case 'Super': case 'Meta': modifiers |= 8; break;
            default: return null;
        }
    }
    return { keycode, modifiers };
}
