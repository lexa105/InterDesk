//
//  BluetoothManager.swift
//  BKMD
//
//  Created by MacBook on 12.07.2025.
//

import Foundation
import CoreBluetooth

final class BluetoothManager: NSObject, ObservableObject, CBCentralManagerDelegate {
    var centralManager: CBCentralManager!

    // Public state available for the whole SwiftUI
    @Published var peripherals: [CBPeripheral] = []
    @Published var connectedPeripheralIDs: Set<UUID> = []
    @Published var peripheralCharacteristics: [UUID: [CBCharacteristic]] = [:]
    
    
    @Published var showBluetoothAlert = false
    @Published var bluetoothIsOn: Bool = false
    
    @Published var characteristicsReady: Bool = false
    @Published var isWriteMode: Bool = false
    
    
    
    override init() {
        super.init()
        centralManager = CBCentralManager(delegate: self, queue: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(handleBluetoothUnavailable), name: Notification.Name("BluetoothUnavailable"), object: nil)
    }
    
    @objc private func handleBluetoothUnavailable() {
        DispatchQueue.main.async {
            self.showBluetoothAlert = true
        }
    }
    
    //CUSTOM FUNCTIONS
    func connect(_ peripheral: CBPeripheral) {
        centralManager.connect(peripheral, options: nil)
    }
    
    func disconnect(_ peripheral: CBPeripheral) {
        centralManager.cancelPeripheralConnection(peripheral)
        self.characteristicsReady = false
        isWriteMode = false
    }
    
    //Toggling to write mode means it allows BKM Dongle to listen from the macbook (KEY_LOGGING_ON = cyan color)
    func toggleToWriteMode(_ peripheral: CBPeripheral, to characteristicUUID: CBUUID) {
        if isWriteMode {
            print("WriteMode is already on")
            return
        } else {
            guard peripheral.state == .connected else {
                print("⚠️ Peripheral not connected")
                return
            }

            guard let chars = peripheralCharacteristics[peripheral.identifier], !chars.isEmpty else {
                print("⚠️ No characteristics stored for \(peripheral.identifier)")
                return
            }
            
            print(chars)

            for ch in chars where ch.uuid.uuidString == "1234" {
                let hexString = "01"
                guard let value = UInt8(hexString, radix: 16) else {
                    print("Invalid hex string: \(hexString)")
                    return
                }
                let payload = Data([value])
                // prefer withoutResponse first
                if ch.properties.contains(.writeWithoutResponse) {
                    peripheral.writeValue(payload, for: ch, type: .withoutResponse)
                    print("➡️ Wrote without response to \(ch.uuid)")
                } else if ch.properties.contains(.write) {
                    peripheral.writeValue(payload, for: ch, type: .withResponse)
                    print("➡️ Wrote with response to \(ch.uuid)")
                    
                } else {
                    print("⚠️ Characteristic \(ch.uuid) does not support write operations")
                }
                isWriteMode = true
            }
        }
    }
    
    func sendUsageKeyInt(_ keyUsageInt: Int) {
        // Convert the Int to UInt8 safely
        guard keyUsageInt >= 0 && keyUsageInt <= 255 else {
            print("⚠️ keyUsageInt out of UInt8 range (0–255)")
            return
        }
        let value = UInt8(keyUsageInt)
        let payload = Data([value])

        // Go through all connected peripherals
        for peripheralID in connectedPeripheralIDs {
            guard let chars = peripheralCharacteristics[peripheralID],
                  let characteristic = chars.first(where: { $0.uuid.uuidString == "1235" }) else {
                print("⚠️ No matching characteristic 1235 for peripheral \(peripheralID)")
                continue
            }

            // Try to get the actual peripheral object
            guard let peripheral = peripherals.first(where: { $0.identifier == peripheralID }) else {
                print("⚠️ Peripheral not found for ID \(peripheralID)")
                continue
            }

            // Send the data
            if characteristic.properties.contains(.writeWithoutResponse) {

                peripheral.writeValue(payload, for: characteristic, type: .withoutResponse)
                print("➡️ Sent key \(value) (no response) to \(characteristic.uuid)")
            } else if characteristic.properties.contains(.write) {
                peripheral.writeValue(payload, for: characteristic, type: .withResponse)
                print("➡️ Sent key \(value) (with response) to \(characteristic.uuid)")
            } else {
                print("⚠️ Characteristic \(characteristic.uuid) not writable")
            }
        }
    }
    
    //Bluetooth Core is event-driven, whenever event happened it calls specific function.
    // 1️⃣ Called when Bluetooth state changes
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn {
            print("🔵 Bluetooth is ON. Starting scan.")
            centralManager.scanForPeripherals(withServices: nil, options: nil)
        } else {
            print("⚠️ Bluetooth is not available.")
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: Notification.Name("Bluetooth Unavailable, please check if it's on and try again"), object: nil)
            }
        }
    }
    
    // 2️⃣ Called when a device is discovered
   func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String : Any], rssi RSSI: NSNumber) {
       if !peripherals.contains(peripheral) {
           peripherals.append(peripheral)
       }
    }
    
    // Called when connect to the peripheral
    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        
        //LOGS the activity
//        print("✅ Connected to \(peripheral.name ?? "Unknown")")
//        print("\(peripheral.name ?? "Uknown") Service: \(peripheral.services ?? [])")
        connectedPeripheralIDs.insert(peripheral.identifier)
        peripheral.delegate = self
        peripheral.discoverServices(nil)
    }
    
    func centralManager(_ central: CBCentralManager,
                        didDisconnectPeripheral peripheral: CBPeripheral,
                        error: Error?) {
        connectedPeripheralIDs.remove(peripheral.identifier)
        print("❌ Disconnected from \(peripheral.name ?? "Unknown")")
    }
}

extension BluetoothManager: CBPeripheralDelegate {
    //Events callbacks for peripherals
    func peripheral(_ peripheral: CBPeripheral,
                    didDiscoverServices
                    error : Error?) {
        if let error = error {
            print("Error has occured while discovering services: \(error.localizedDescription)")
            return
        }
        
        guard let services = peripheral.services else { return }
        for service in services {
            print("Found \(peripheral.name ?? "Unknown") Service:\(service.uuid)")
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }
    
    func peripheral(_ peripheral: CBPeripheral,
                    didDiscoverCharacteristicsFor service: CBService,
                    error: Error?) {
        if let error = error {
            print("Error discovering characteristics for \(service.uuid): \(error.localizedDescription)")
            return
        }
        
    
        //Checks if chars is not going to be empty
        guard let chars = service.characteristics, !chars.isEmpty else {
            print("No characteristics for service \(service.uuid)")
            return
        }
        print("Discovered \(chars.count) characteristics for \(service.uuid)")
        
        //saves all the Charactertics.
        var all = peripheralCharacteristics[peripheral.identifier] ?? []
        all.append(contentsOf: chars)
        peripheralCharacteristics[peripheral.identifier] = all
    
        print(all)
        
        DispatchQueue.main.async {
            self.characteristicsReady = true
        }
            
    
    }
    
    func peripheral(_ peripheral: CBPeripheral,
                    didUpdateValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        if let error = error {
            print("❌ Error updating value for \(characteristic.uuid): \(error.localizedDescription)")
            return
        }

        guard let data = characteristic.value else {
            print("⚠️ No value for \(characteristic.uuid)")
            return
        }

        // Convert raw Data to hex string
        let hexString = data.map { String(format: "%02X", $0) }.joined(separator: " ")
        print("📥 Value for \(characteristic.uuid): \(hexString)")

        // Or, if it's UTF-8 text:
        if let stringValue = String(data: data, encoding: .utf8) {
            print("📄 Text value: \(stringValue)")
        }
    }

    func peripheral(_ peripheral: CBPeripheral,
                    didWriteValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        if let error = error {
            print("❌ Write failed for \(characteristic.uuid): \(error.localizedDescription)")
        } else {
            print("✅ Write succeeded for \(characteristic.uuid)")
        }
    }
}
