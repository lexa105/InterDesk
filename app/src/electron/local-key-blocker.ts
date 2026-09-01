import { globalShortcut } from 'electron';

// While keyboard forwarding is active, keystrokes should go only to PC2 - but
// uiohook-napi can only observe global key events, not consume them, so local
// apps would still receive everything. Global shortcuts, however, ARE consumed
// by the OS before reaching any app, and macOS event taps (which uiohook uses)
// see events before hotkey dispatch, so forwarding keeps working. This module
// blanket-registers the practical keyboard space as no-op global shortcuts to
// swallow local input, leaving only the switch keybind active.
//
// Known gaps: bare modifier presses and OS-reserved combos (Cmd+Tab, media
// keys, some system shortcuts) cannot be registered and still reach the local
// machine.

const KEYS: string[] = [
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
    ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
    'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Escape',
    'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
    ...'-=[]\\;\',./`'.split(''),
];

const MODIFIERS: string[] = process.platform === 'darwin'
    ? ['Command', 'Control', 'Alt', 'Shift']
    : ['Control', 'Alt', 'Shift', 'Super'];

/** Resolve accelerator token aliases so combos can be compared as strings. */
function normalizeToken(token: string): string {
    switch (token) {
        case 'CommandOrControl':
        case 'CmdOrCtrl':
            return process.platform === 'darwin' ? 'Command' : 'Control';
        case 'Cmd': return 'Command';
        case 'Ctrl': return 'Control';
        case 'Option': return 'Alt';
        case 'Meta': return process.platform === 'darwin' ? 'Command' : 'Super';
        case 'Esc': return 'Escape';
        case 'Enter': return 'Return';
        default: return token;
    }
}

function canonical(accelerator: string): string {
    const tokens = accelerator.split('+').map(normalizeToken);
    const key = tokens.pop() ?? '';
    return [...tokens.sort(), key].join('+');
}

class LocalKeyBlocker {
    private registered: string[] = [];

    public get isActive() {
        return this.registered.length > 0;
    }

    /**
     * Swallow all local keystrokes except `excludeAccelerator` (the switch
     * keybind, which must keep firing its own registered handler).
     */
    public start(excludeAccelerator: string) {
        if (this.isActive) return;
        const excluded = canonical(excludeAccelerator);
        const swallow = () => {};

        for (let mask = 0; mask < 1 << MODIFIERS.length; mask++) {
            const mods = MODIFIERS.filter((_, i) => mask & (1 << i));
            for (const key of KEYS) {
                const accelerator = [...mods, key].join('+');
                if (canonical(accelerator) === excluded) continue;
                // Never steal a combo this app already handles (switch keybind
                // under an aliased spelling, or future shortcuts).
                if (globalShortcut.isRegistered(accelerator)) continue;
                try {
                    if (globalShortcut.register(accelerator, swallow)) {
                        this.registered.push(accelerator);
                    }
                } catch {
                    // Malformed/reserved accelerator - leave it to the OS.
                }
            }
        }
        console.log(`LocalKeyBlocker: suppressing ${this.registered.length} local key combos`);
    }

    public stop() {
        if (!this.isActive) return;
        for (const accelerator of this.registered) {
            globalShortcut.unregister(accelerator);
        }
        this.registered = [];
        console.log('LocalKeyBlocker: local keyboard restored');
    }
}

export const localKeyBlocker = new LocalKeyBlocker();
