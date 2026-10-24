import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeGattUuid } from '../src/electron/gatt-uuid.ts'

test('short Bluetooth UUIDs match their expanded base UUID form', () => {
  assert.equal(normalizeGattUuid('1237'), '1237')
  assert.equal(normalizeGattUuid('00001237-0000-1000-8000-00805F9B34FB'), '1237')
  assert.equal(normalizeGattUuid('00001236-0000-1000-8000-00805f9b34fb'), '1236')
})

test('vendor-specific 128-bit UUIDs remain intact', () => {
  assert.equal(normalizeGattUuid('12345678-1234-5678-9abc-def012345678'), '12345678123456789abcdef012345678')
})
