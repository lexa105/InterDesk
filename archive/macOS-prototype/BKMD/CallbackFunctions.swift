//
//  CallbackFunctions.swift 
//
//
//  Created by MacBook on 29.09.2025.
//

import Foundation
import Cocoa

class CallbackFunctions {
    
    static let HandleIOHIDInputValueCallback: IOHIDValueCallback = { context, result, sender, value in
        
        let monitor = Unmanaged<KeyboardMonitor>
            .fromOpaque(context!)
            .takeUnretainedValue()
        
        let elem: IOHIDElement = IOHIDValueGetElement(value)
        
        //Filtration only keep the real keyboard usages
        //AFTER Mouse Update will change.
        guard IOHIDElementGetUsagePage(elem) == kHIDPage_KeyboardOrKeypad else
        { return }
        
        let isDown = IOHIDValueGetIntegerValue(value) != 0 //Returns 0 released and 1 pressed
        let rawElemUsage = IOHIDElementGetUsage(elem) //Raw decimal usage of the element
        
        //Some random UInt32.max number which is giving
        guard rawElemUsage != 0, rawElemUsage != UInt32.max else { return }
        let scanCode = Int(rawElemUsage)
                
        if isDown {
            if !monitor.pressedKeys.contains(scanCode) {
                monitor.pressedKeys.append(scanCode)
            }
            let shortcut = monitor.shortcutKeys
            //DEBUG
            print(monitor.pressedKeys)
            if monitor.pressedKeys == shortcut {
                monitor.toggleWriteMode()
                //DEBUG
                print("Write mode: \(monitor.isWriteMode)")
            }
            monitor.sendKeys(scanCode)
            
        } else {
            monitor.pressedKeys.remove(scanCode)
        }
        
    }
    
}
