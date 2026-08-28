import { uIOhook, UiohookKey } from "uiohook-napi";
import { EventEmitter } from 'node:events';
import { acquireUiohook, releaseUiohook } from './uiohook-lifecycle.js';

const MAC_HID_MAP: Record<number, number> = {
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
    3666: 0x4C, // Delete
    3667: 0x49, // Insert
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


export class KeyMonitor extends EventEmitter {
    //TODO: Dopracovat zde architekturu z Electron strany a pak to prepsat do dokumentace v Notionu. 
    
    // 2.state manegment - toto by se mělo měnit, podle stavu zmáčknutých kláves
    private currentModifiers = 0x00;
    private pressedKeys = new Set<number>();

    //Track if we are monitoring.
    private _isRunning = false;

    public get isRunning() {
        return this._isRunning;
    }




    constructor() {
        super();

        // Initialize uiohook
        uIOhook.on('keydown', (e) => {
            this.handleKeyEvent(e.keycode, true);
        });

        uIOhook.on('keyup', (e) => {
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
        console.log("Stopping KeyMonitor");
        this._isRunning = false;
        releaseUiohook();

        //Reset our state so we dont have "stuck" ?
        this.currentModifiers = 0x00;
        this.pressedKeys.clear();

        //Sending bluetooth default empty buffer.
        this.sendReport()

    }

    

    private handleKeyEvent(uiHookKeycode: number, isDown: boolean) {
        // The shared hook may be running for MouseMonitor alone - ignore key
        // events unless keyboard forwarding itself is on.
        if (!this._isRunning) return;

        let changed = false;

        if(this.isModifier(uiHookKeycode)) {
            const oldModifiers = this.currentModifiers;
            this.updateModifier(uiHookKeycode, isDown);
            if (this.currentModifiers !== oldModifiers) {
                changed = true;
            }
        } else {
            const hidCode = MAC_HID_MAP[uiHookKeycode];
            if (!hidCode) {
                console.log("unmapped keycode key ", uiHookKeycode);
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
        let i= 2;
        for (const hid of this.pressedKeys) {
            if (i >= 8) break;
            report[i] = hid;
            i++;
        }

        console.log('Sending HID report to BLE: ', report)
        // ZDE PRIDAT BLESENDREPORT
        //TODO: PRIDAT pomoci Observer design patternu.
        this.emit('hid-report', report)
    }


    private isModifier(keycode: number): boolean {
        const modifiers = [
            UiohookKey.Ctrl, 
            UiohookKey.CtrlRight, 
            UiohookKey.Shift, 
            UiohookKey.ShiftRight, 
            UiohookKey.Alt, 
            UiohookKey.AltRight, 
            UiohookKey.Meta,
            UiohookKey.MetaRight
        ]
        //Checkne jestli je to modifier.
        // @ts-ignore
        return modifiers.includes(keycode)
    }

    private updateModifier(keycode: number, isDown: boolean) {
        let modifierBit = 0;
        switch(keycode) {
            case UiohookKey.Ctrl:       modifierBit = 0x01; break;
            case UiohookKey.Shift:      modifierBit = 0x02; break;
            case UiohookKey.Alt:        modifierBit = 0x04; break;
            case UiohookKey.Meta:       modifierBit = 0x08; break; // Left Cmd
            case UiohookKey.CtrlRight:  modifierBit = 0x10; break;
            case UiohookKey.ShiftRight: modifierBit = 0x20; break;
            case UiohookKey.AltRight:   modifierBit = 0x40; break;
            case UiohookKey.MetaRight:  modifierBit = 0x80; break; // Right Cmd
        }

        if (isDown) {
            this.currentModifiers |= modifierBit
        } else {
            this.currentModifiers &= ~modifierBit
        }
    }


}