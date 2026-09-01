//
//  PeripheralView.swift
//  BKMD
//
//  Created by MacBook on 09.08.2025.
//

import SwiftUI
import CoreBluetooth

struct PeripheralView: View {
    @ObservedObject var manager: BluetoothManager
    var peripheral: CBPeripheral

    @EnvironmentObject var monitor: KeyboardMonitor

    @State private var showNotConnectedAlert = false

    private var isConnected: Bool {
        manager.connectedPeripheralIDs.contains(peripheral.identifier)
    }

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 8) {
                Text(peripheral.name ?? "Unnamed device")
                    .font(.title)
                Text(peripheral.identifier.uuidString)
                    .font(.subheadline)
            }
            Spacer()
            VStack() {
                Text(isConnected ? "Connected" : "Disconnected")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                Button(isConnected ? "Disconnect" : "Connect") {
                    if isConnected {
                        manager.disconnect(peripheral)
                    } else {
                        manager.connect(peripheral)
                    }
                }
                .buttonStyle(.borderedProminent)

                Button("Start Monitoring") {
                    if isConnected {
                        monitor.start()
                        manager.toggleToWriteMode(peripheral, to: CBUUID(string: "1234"))
                    } else {
                        showNotConnectedAlert = true
                    }
                }
                .disabled(!manager.characteristicsReady)

                Button("Stop Monitoring") {
                    monitor.stop()
                }
                .disabled(!monitor.isRunning)
            }

        }
        .padding(20)
        .alert("Device not connected. Please connect first.", isPresented: $showNotConnectedAlert) {
            Button("OK", role: .cancel) {}
        }
    }
}


