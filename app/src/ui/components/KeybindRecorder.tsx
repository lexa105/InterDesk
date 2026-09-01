import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings } from '../electron-api'
import { eventToAccelerator, formatAccelerator, isModifierCode } from '../keybind'

interface KeybindRecorderProps {
  value: string
  onChange: (settings: AppSettings) => void
}

export function KeybindRecorder({ value, onChange }: KeybindRecorderProps) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recordingRef = useRef(recording)
  recordingRef.current = recording

  const stopRecording = useCallback(async (cancelled: boolean) => {
    setRecording(false)
    if (cancelled) {
      // Restore the suspended global shortcut.
      await window.bkmd.cancelKeybindCapture()
    }
  }, [])

  const startRecording = useCallback(async () => {
    setError(null)
    // Suspend the current global shortcut so pressing it gets recorded
    // instead of toggling the monitors.
    await window.bkmd.beginKeybindCapture()
    setRecording(true)
  }, [])

  useEffect(() => {
    if (!recording) return

    const onKeyDown = async (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()

      if (event.code === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        void stopRecording(true)
        return
      }
      if (isModifierCode(event.code)) return

      const accelerator = eventToAccelerator(event)
      if (!accelerator) {
        setError('Use at least one modifier (⌘ ⌃ ⌥ ⇧) plus a key.')
        return
      }

      setRecording(false)
      const result = await window.bkmd.setKeybind(accelerator)
      if (result.ok) {
        setError(null)
        onChange(result.settings)
      } else {
        // The main process re-registered the previous keybind on failure.
        setError(result.error)
      }
    }

    const onBlur = () => void stopRecording(true)

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [recording, onChange, stopRecording])

  // If the component unmounts mid-recording (e.g. dongle disconnects),
  // make sure the global shortcut comes back.
  useEffect(() => {
    return () => {
      if (recordingRef.current) void window.bkmd.cancelKeybindCapture()
    }
  }, [])

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => (recording ? stopRecording(true) : startRecording())}
        className={`min-w-[90px] rounded-md border px-3 py-1 text-center text-[13px] transition-colors ${
          recording
            ? 'animate-pulse border-accent bg-accent/10 text-accent'
            : 'border-line bg-surface-2 text-ink hover:border-ink-faint'
        }`}
      >
        {recording ? 'Press keys…' : formatAccelerator(value)}
      </button>
      <span className="text-[11px] text-ink-faint">
        {recording ? 'Esc to cancel' : error ? <span className="text-danger">{error}</span> : 'Click to change'}
      </span>
    </div>
  )
}
