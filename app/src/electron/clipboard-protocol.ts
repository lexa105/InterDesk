import { Buffer } from 'node:buffer';

const MAGIC_0 = 0x49; // I
const MAGIC_1 = 0x44; // D
const FRAME_BEGIN = 0x01;
const FRAME_CHUNK = 0x02;
const FRAME_END = 0x03;
const FRAME_RESULT = 0x81;

// Keep writes within the default ATT MTU (23 bytes, 20-byte value) so this
// works even when the central and dongle do not negotiate a larger MTU.
const MAX_BLE_VALUE_BYTES = 20;
const CHUNK_HEADER_BYTES = 6;
const MAX_CHUNK_BYTES = MAX_BLE_VALUE_BYTES - CHUNK_HEADER_BYTES;
export const MAX_CLIPBOARD_BYTES = 1024;

export interface ClipboardResult {
    transferId: number;
    ok: boolean;
    skippedCharacters: number;
}

/** Simplify common text that has useful ASCII approximations for USB HID. */
export function normalizeClipboardText(text: string): string {
    const punctuation: Record<string, string> = {
        '\u00a0': ' ',
        '\u2018': "'",
        '\u2019': "'",
        '\u201a': "'",
        '\u201b': "'",
        '\u201c': '"',
        '\u201d': '"',
        '\u201e': '"',
        '\u201f': '"',
        '\u2013': '-',
        '\u2014': '-',
        '\u2212': '-',
        '\u2026': '...',
    };

    return text
        .replace(/\r\n?/g, '\n')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u00a0\u2018-\u201f\u2013\u2014\u2026\u2212]/g, (character) => punctuation[character] ?? character);
}

export function encodeClipboardFrames(text: string, transferId: number): Buffer[] {
    if (!Number.isInteger(transferId) || transferId < 1 || transferId > 0xff) {
        throw new Error('Invalid clipboard transfer identifier.');
    }

    // Bound the main-process work before normalization so an enormous source
    // clipboard cannot monopolize the app while being prepared for BLE.
    if (Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_BYTES * 4) {
        throw new Error(`Clipboard text is too large (maximum ${MAX_CLIPBOARD_BYTES} bytes after normalization).`);
    }

    const normalized = normalizeClipboardText(text);
    const data = Buffer.from(normalized, 'utf8');
    if (data.length === 0) throw new Error('Clipboard has no text to send.');
    if (data.length > MAX_CLIPBOARD_BYTES) {
        throw new Error(`Clipboard text is too large (${data.length} bytes; maximum ${MAX_CLIPBOARD_BYTES}).`);
    }

    const frames = [Buffer.from([
        MAGIC_0, MAGIC_1, FRAME_BEGIN, transferId,
        data.length & 0xff, (data.length >> 8) & 0xff,
    ])];

    let sequence = 0;
    for (let offset = 0; offset < data.length; offset += MAX_CHUNK_BYTES) {
        const chunk = data.subarray(offset, Math.min(offset + MAX_CHUNK_BYTES, data.length));
        const frame = Buffer.alloc(CHUNK_HEADER_BYTES + chunk.length);
        frame.set([MAGIC_0, MAGIC_1, FRAME_CHUNK, transferId, sequence & 0xff, (sequence >> 8) & 0xff]);
        chunk.copy(frame, CHUNK_HEADER_BYTES);
        frames.push(frame);
        sequence++;
    }

    frames.push(Buffer.from([MAGIC_0, MAGIC_1, FRAME_END, transferId]));
    return frames;
}

export function decodeClipboardResult(value: Buffer): ClipboardResult | null {
    if (value.length !== 7 || value[0] !== MAGIC_0 || value[1] !== MAGIC_1 || value[2] !== FRAME_RESULT) {
        return null;
    }

    return {
        transferId: value[3],
        ok: value[4] === 0,
        skippedCharacters: value[5] | (value[6] << 8),
    };
}
