import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Buffer } from 'node:buffer'
import {
  decodeClipboardResult,
  encodeClipboardFrames,
  MAX_CLIPBOARD_BYTES,
  normalizeClipboardText,
} from '../src/electron/clipboard-protocol.ts'

test('clipboard frames preserve normalized UTF-8 and fit the default BLE MTU', () => {
  const text = 'Cafe\u0301 — it’s fine\n🙂\t100%'
  const frames = encodeClipboardFrames(text, 37)
  const normalized = normalizeClipboardText(text)

  assert.deepEqual([...frames[0]], [0x49, 0x44, 0x01, 37, Buffer.byteLength(normalized), 0])
  assert.deepEqual([...frames.at(-1)], [0x49, 0x44, 0x03, 37])
  assert.ok(frames.every((frame) => frame.length <= 20))

  const chunks = frames.slice(1, -1)
  const payload = Buffer.concat(chunks.map((frame, index) => {
    assert.deepEqual([...frame.subarray(0, 4)], [0x49, 0x44, 0x02, 37])
    assert.equal(frame[4] | (frame[5] << 8), index)
    return frame.subarray(6)
  }))
  assert.equal(payload.toString('utf8'), normalized)
})

test('result notifications are decoded and unrelated values are ignored', () => {
  assert.deepEqual(decodeClipboardResult(Buffer.from([0x49, 0x44, 0x81, 9, 0, 2, 0])), {
    transferId: 9,
    ok: true,
    skippedCharacters: 2,
  })
  assert.deepEqual(decodeClipboardResult(Buffer.from([0x49, 0x44, 0x81, 9, 1, 0, 0])), {
    transferId: 9,
    ok: false,
    skippedCharacters: 0,
  })
  assert.equal(decodeClipboardResult(Buffer.from([0, 0, 0x81, 9, 0, 0, 0])), null)
})

test('empty, oversized, and invalid-id transfers are rejected', () => {
  assert.throws(() => encodeClipboardFrames('', 1), /no text/i)
  assert.throws(() => encodeClipboardFrames('x'.repeat(MAX_CLIPBOARD_BYTES + 1), 1), /too large/i)
  assert.throws(() => encodeClipboardFrames('ok', 0), /identifier/i)
})
