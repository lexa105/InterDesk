//
//  oendode.swift
//  BKMD
//
//  Created by MacBook on 21.09.2025.
//

import Foundation
import IOKit.hid //Low level C API for communication with USB HID.
import Collections

final class KeyboardMonitor: ObservableObject {
    private var manager: IOHIDManager!
    
    
    var bluetoothManager: BluetoothManager
    var selectedDeviceList: [Int]
    var deviceList = NSArray()
    
    //Array list of currently Pressed keys
    var pressedKeys = OrderedSet<Int>()
    var shortcutKeys: OrderedSet<Int> = [227, 100]
    
    //Bool to check whether the isWriteMode active or not. Accessible to the bluetoothManager
    var isWriteMode: Bool = false
    
    
    @Published var isRunning: Bool = false
    
 
    init(bluetoothManager: BluetoothManager) {
        //I guess this is constructor like in Java? For Keyboard monitor
        self.bluetoothManager = bluetoothManager
        
        //Initiliaze IOHid Manager
        manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        
        //Selecting devices to monitor
        selectedDeviceList = [kHIDUsage_GD_Keyboard, kHIDUsage_GD_Keypad]
        
        //Adding devices to the deviceList from selectedDeviceList
        for device in selectedDeviceList {
            deviceList = deviceList.adding(createDeviceMatchingDictionary(inUsagePage: kHIDPage_GenericDesktop, inUsage: device)) as NSArray
        }
                
        IOHIDManagerSetDeviceMatchingMultiple(manager, deviceList as CFArray)
        
        let observer = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
        IOHIDManagerRegisterInputValueCallback(manager, CallbackFunctions.HandleIOHIDInputValueCallback, observer)

        

        /* Open HID Manager */
        let ioreturn: IOReturn = openHIDManager()
        if ioreturn != kIOReturnSuccess
        {
            print("Can't open HID!")
        }
        
    }
    
    //For keyboard
    func createDeviceMatchingDictionary(inUsagePage: Int, inUsage: Int) -> CFMutableDictionary{
        let dict:  [String: Int] = [
            kIOHIDDeviceUsagePageKey as String: inUsagePage,
            kIOHIDDeviceUsageKey as String: inUsage
            
        ] //Creates a simple String:Int dictionary like Map in Java
        
        //Converting dict to Core Foundation C-Based API
        let resultDict: CFMutableDictionary = dict as! CFMutableDictionary // as! = This proccess will succeed if not crash the whole app.
        return resultDict
    }
    
    func start() {
        if isRunning {
            print("HID Manager already running")
            return
        } else {
            print("Starting...")
            IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
            isRunning = true
        }
    }
    
    func openHIDManager() -> IOReturn {
        print("Opening HID Manager...")
        return IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
    }
    
    func stop() {
        if !isRunning {
            print("HID Manager already stopped")
            return
        }
        print("Stopping...")
        IOHIDManagerUnscheduleFromRunLoop(manager, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
        isRunning = false
        toggleWriteMode()
    }
    
    func toggleWriteMode() {
        isWriteMode.toggle()
    }
    
    
    func sendKeys(_ keyUsage: Int) {
        bluetoothManager.sendUsageKeyInt(keyUsage)
    }
    
    
    
    
    

}

