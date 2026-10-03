import { uIOhook, UiohookKey } from "uiohook-napi";
import { EventEmitter } from 'node:events';
import { parseSwitchShortcut, shortcutModifiers } from './switch-shortcut.js';
import { acquireUiohook, releaseUiohook, isFreshInput } from './uiohook-lifecycle.js';

const HID_KEY_MAP: Record<number, number> = {
    // Letters
    16: 0x14, 17: 0x1A, 18: 0x08, 19: 0x15, 20: 0x17, 21: 0x1C, 22: 0x18, 23: 0x0C, 24: 0x12, 25: 0x13,
    30: 0x04, 31: 0x16, 32: 0x07, 33: 0x09, 34: 0x0A, 35: 0x0B, 36: 0x0D, 37: 0x0E, 38: 0x0F,
    44: 0x1D, 45: 0x1B, 46: 0x06, 47: 0x19, 48: 0x05, 49: 0x11, 50: 0x10,

    // Numbers
    2: 0x1E, 3: 0x1F, 4: 0x20, 5: 0x21, 6: 0x22, 7: 0x23, 8: 0x24, 9: 0x25, 10: 0x26, 11: 0x27,

    // Symbols
    12: 0x2D, // -
    13: 0x2E, // =
    26: 0x2F, // [
    27: 0x30, // ]
    43: 0x31, // \
    39: 0x33, // ;
    40: 0x34, // '
    41: 0x35, // `
    51: 0x36, // ,
    52: 0x37, // .
    53: 0x38, // /

    // Function Keys
    59: 0x3A, // F1
    60: 0x3B, // F2
    61: 0x3C, // F3
    62: 0x3D, // F4
    63: 0x3E, // F5
    64: 0x3F, // F6
    65: 0x40, // F7
    66: 0x41, // F8
    67: 0x42, // F9
    68: 0x43, // F10
    87: 0x44, // F11
    88: 0x45, // F12

    // Navigation & Editing
    1: 0x29,    // Esc
    14: 0x2A,   // Backspace
    15: 0x2B,   // Tab
    28: 0x28,   // Enter
    57: 0x2C,   // Space
    58: 0x39,   // CapsLock
    3639: 0x46, // PrintScreen
    70: 0x47,   // ScrollLock
    3653: 0x48, // Pause/Break
    [UiohookKey.Delete]: 0x4C, // Delete
    [UiohookKey.Insert]: 0x49, // Insert
    3655: 0x4A, // Home
    3657: 0x4B, // PageUp
    3663: 0x4D, // End
    3665: 0x4E, // PageDown
    
    // Arrows
    57416: 0x52, // Up
    57424: 0x51, // Down
    57419: 0x50, // Left
    57421: 0x4F, // Right

    // Modifiers (mapped via bitmask but included for completeness if needed)
    29: 0xE0,   // Left Ctrl
    42: 0xE1,   // Left Shift
    56: 0xE2,   // Left Alt
    3675: 0xE3, // Left Meta
    3613: 0xE4, // Right Ctrl
    54: 0xE5,   // Right Shift
    3640: 0xE6, // Right Alt
    3676: 0xE7  // Right Meta
}

const MODIFIER_BITS: Readonly<Record<number, number>> = {
    [UiohookKey.Ctrl]: 0x01, [UiohookKey.Shift]: 0x02,
    [UiohookKey.Alt]: 0x04, [UiohookKey.Meta]: 0x08,
    [UiohookKey.CtrlRight]: 0x10, [UiohookKey.ShiftRight]: 0x20,
    [UiohookKey.AltRight]: 0x40, [UiohookKey.MetaRight]: 0x80,
};

export class KeyMonitor extends EventEmitter {
    // 2.state manegment - toto by se mělo měnit, podle stavu zmáčknutých kláves
    private currentModifiers = 0x00;
    private pressedKeys = new Set<number>();

    private switchShortcut = parseSwitchShortcut('CommandOrControl+Shift+R');

    public setSwitchKeybind(accelerator: string) {
        this.switchShortcut = parseSwitchShortcut(accelerator);
    }

    //Track if we are monitoring.
    private _isRunning = false;

    public get isRunning() {
        return this._isRunning;
    }



    constructor() {
        super();

        // Initialize uiohook
        uIOhook.on('keydown', (e) => {
            if (!isFreshInput(e)) {
                if (this._isRunning) this.emit('stalled');
                return;
            }
            this.handleKeyEvent(e.keycode, true);
        });

        uIOhook.on('keyup', (e) => {
            if (!isFreshInput(e)) {
                if (this._isRunning) this.emit('stalled');
                return;
            }
            this.handleKeyEvent(e.keycode, false)
        })
    }

    public start() {
        if (this._isRunning) return;
        acquireUiohook();
        this._isRunning = true; // Update state here
    }

    public stop() {
        if (!this._isRunning) return;
        this._isRunning = false;
        releaseUiohook();

        //Reset our state so we dont have "stuck" ?
        this.currentModifiers = 0x00;
        this.pressedKeys.clear();

        //Sending bluetooth default empty buffer.
        this.sendReport();

    }

    

    private handleKeyEvent(uiHookKeycode: number, isDown: boolean) {
        // The shared hook may be running for MouseMonitor alone - ignore key
        // events unless keyboard forwarding itself is on.
        if (!this._isRunning) return;

        // The native hook runs before Electron's global shortcut callback.
        // Suppress the trigger key so switching home cannot also run a PC2 shortcut.
        if (isDown && this.switchShortcut?.keycode === uiHookKeycode &&
            this.switchShortcut.modifiers === shortcutModifiers(this.currentModifiers)) {
            this.currentModifiers = 0;
            this.pressedKeys.clear();
            this.sendReport();
            return;
        }

        let changed = false;

        const modifierBit = MODIFIER_BITS[uiHookKeycode];
        if (modifierBit) {
            const oldModifiers = this.currentModifiers;
            if (isDown) this.currentModifiers |= modifierBit;
            else this.currentModifiers &= ~modifierBit;
            if (this.currentModifiers !== oldModifiers) {
                changed = true;
            }
        } else {
            const hidCode = HID_KEY_MAP[uiHookKeycode];
            if (!hidCode) {
                return;
            } 

            if (isDown) {
                if (!this.pressedKeys.has(hidCode)) {
                    this.pressedKeys.add(hidCode);
                    changed = true;
                }
            } else {
                if (this.pressedKeys.has(hidCode)) {
                    this.pressedKeys.delete(hidCode);
                    changed = true;
                }
            }
        }

        if (changed) {
            this.sendReport();
        }
    }

    private sendReport() {
        //HID report default by 8bytes - default 
        const report = Buffer.alloc(8, 0);

        //byte 0 is for modifiers. 
        report[0] = this.currentModifiers;
        //Byte 1 stays 0
        // USB boot-keyboard ErrorRollOver instead of silently dropping held keys.
        if (this.pressedKeys.size > 6) {
            report.fill(0x01, 2);
            this.emit('hid-report', report);
            return;
        }
        let i = 2;
        for (const hid of this.pressedKeys) {
            if (i >= 8) break;
            report[i] = hid;
            i++;
        }

        this.emit('hid-report', report);
    }

}
