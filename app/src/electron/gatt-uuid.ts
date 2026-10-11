/** Normalize Bluetooth base UUIDs so 16-bit and expanded forms compare equally. */
export function normalizeGattUuid(uuid: string): string {
  const compact = uuid.toLowerCase().replace(/-/g, '');
  const bluetoothBaseUuid = /^0000([0-9a-f]{4})00001000800000805f9b34fb$/;
  const match = compact.match(bluetoothBaseUuid);

  return match ? match[1] : compact;
}
