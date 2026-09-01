// Helpers for turning DOM keyboard events into Electron accelerator strings
// and rendering accelerators as macOS-style symbols.

const MODIFIER_SYMBOLS: Record<string, string> = {
    CommandOrControl: '⌘',
    CmdOrCtrl: '⌘',
    Command: '⌘',
    Cmd: '⌘',
    Meta: '⌘',
    Control: '⌃',
    Ctrl: '⌃',
    Alt: '⌥',
    Option: '⌥',
    Shift: '⇧',
}

export function formatAccelerator(accelerator: string): string {
    return accelerator
        .split('+')
        .map((part) => MODIFIER_SYMBOLS[part] ?? part.toUpperCase())
        .join('')
}

const MODIFIER_CODES = new Set([
    'MetaLeft', 'MetaRight',
    'ControlLeft', 'ControlRight',
    'AltLeft', 'AltRight',
    'ShiftLeft', 'ShiftRight',
])

const SPECIAL_CODE_MAP: Record<string, string> = {
    Space: 'Space',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Tab: 'Tab',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Comma: ',',
    Period: '.',
    Slash: '/',
}

function codeToAcceleratorKey(code: string): string | null {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3)
    if (/^Digit[0-9]$/.test(code)) return code.slice(5)
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
    return SPECIAL_CODE_MAP[code] ?? null
}

export function isModifierCode(code: string): boolean {
    return MODIFIER_CODES.has(code)
}

/**
 * Builds an Electron accelerator from a keydown event, or null if the
 * combination isn't valid as a global shortcut (no modifier held, a bare
 * modifier key, or an unmapped key).
 */
export function eventToAccelerator(event: KeyboardEvent): string | null {
    if (isModifierCode(event.code)) return null

    const key = codeToAcceleratorKey(event.code)
    if (!key) return null

    const modifiers: string[] = []
    if (event.metaKey) modifiers.push('CommandOrControl')
    if (event.ctrlKey) modifiers.push('Control')
    if (event.altKey) modifiers.push('Alt')
    if (event.shiftKey) modifiers.push('Shift')
    if (modifiers.length === 0) return null

    return [...modifiers, key].join('+')
}
