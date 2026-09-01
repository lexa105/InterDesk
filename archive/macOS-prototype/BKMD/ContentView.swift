//
//  ContentView.swift
//  BKMD
//
//  Created by MacBook on 12.07.2025.
//

import SwiftUI
import CoreBluetooth

struct ContentView: View {
    @StateObject var bluetoothManager: BluetoothManager
    @StateObject var keyboardMonitor: KeyboardMonitor
    @State private var selectedPeripheralID: UUID? = nil

    
    
    init() {
        let manager = BluetoothManager()
          _bluetoothManager = StateObject(wrappedValue: manager)
          _keyboardMonitor = StateObject(wrappedValue:
          KeyboardMonitor(bluetoothManager: manager))
    }
    
    var body: some View {
        NavigationSplitView {
            List(peripheralsWithNames, id: \.identifier, selection: $selectedPeripheralID) { peripheral in
                Text(peripheral.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
            }
        } detail: {
            if let id = selectedPeripheralID,
               let peripheral = peripheralsWithNames.first(where: { $0.identifier == id}) {
                PeripheralView(manager: bluetoothManager, peripheral: peripheral)
                    .environmentObject(keyboardMonitor)
                 Spacer()
            }
                else {
                VStack{
                    Text("Smrdi ti pero")
                }
            }
            
        }.navigationTitle("Bluetooth Devices")
        .alert("Bluetooth is not available", isPresented: $bluetoothManager.showBluetoothAlert) {
            Button("OK", role: .cancel) { }
        }
    }
}

#Preview {
    ContentView()
}

private extension ContentView {
    var peripheralsWithNames: [CBPeripheral] {
        bluetoothManager.peripherals.filter { peripheral in
            guard let name = peripheral.name?.trimmingCharacters(in: .whitespacesAndNewlines) else {
                return false
            }
            return !name.isEmpty
        }
    }
}
