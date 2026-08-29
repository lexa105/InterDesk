import { useCallback, useRef, useState } from 'react'
import type { AppSettings, Pc2Layout, Pc2Side } from '../electron-api'
import { SettingsGroup, SettingsRow } from './SettingsGroup'
import { Toggle } from './Toggle'

/*
 * Arrangement canvas geometry. PC1 is a fixed rectangle in the middle of the
 * canvas; PC2 is dragged around it and always snaps flush to one of PC1's four
 * edges. The stored layout is resolution-independent: `offset` and `scale` are
 * fractions of PC1's shared edge length.
 */
const CANVAS_W = 420
const CANVAS_H = 280
const PC1_W = 180
const PC1_H = 112
const PC1_LEFT = (CANVAS_W - PC1_W) / 2
const PC1_TOP = (CANVAS_H - PC1_H) / 2
const PC1_CX = PC1_LEFT + PC1_W / 2
const PC1_CY = PC1_TOP + PC1_H / 2

// Screens have to touch for an edge crossing to ever happen, so keep at least
// 10% of PC2's shared edge overlapping PC1's.
const MIN_OVERLAP = 0.1
const MIN_SCALE = 0.25
const MAX_SCALE = 4

const isVertical = (side: Pc2Side) => side === 'left' || side === 'right'

function clampOffset(offset: number, scale: number) {
  const min = -(1 - MIN_OVERLAP) * scale
  const max = 1 - MIN_OVERLAP * scale
  return Math.min(max, Math.max(min, offset))
}

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** Layout -> canvas-space rectangle for PC2, flush against PC1's `side` edge. */
function pc2Rect({ side, offset, scale }: Pc2Layout): Rect {
  if (isVertical(side)) {
    const height = scale * PC1_H
    const width = height * (PC1_W / PC1_H) // cosmetic aspect, matches PC1
    const top = PC1_TOP + offset * PC1_H
    const left = side === 'right' ? PC1_LEFT + PC1_W : PC1_LEFT - width
    return { left, top, width, height }
  }
  const width = scale * PC1_W
  const height = width * (PC1_H / PC1_W)
  const left = PC1_LEFT + offset * PC1_W
  const top = side === 'bottom' ? PC1_TOP + PC1_H : PC1_TOP - height
  return { left, top, width, height }
}

/** Which PC1 edge a pointer at (px, py) belongs to, normalised by half-extents. */
function sideForPointer(px: number, py: number): Pc2Side {
  const nx = (px - PC1_CX) / (PC1_W / 2)
  const ny = (py - PC1_CY) / (PC1_H / 2)
  if (Math.abs(nx) >= Math.abs(ny)) return nx >= 0 ? 'right' : 'left'
  return ny >= 0 ? 'bottom' : 'top'
}

const SIDE_LABEL: Record<Pc2Side, string> = {
  left: 'left edge',
  right: 'right edge',
  top: 'top edge',
  bottom: 'bottom edge',
}

interface SwitchingPageProps {
  settings: AppSettings
  onSettingsChange: (settings: AppSettings) => void
}

export function SwitchingPage({ settings, onSettingsChange }: SwitchingPageProps) {
  const canvasRef = useRef<HTMLDivElement>(null)
  // Non-null only while a pointer drag is in flight - during a drag the
  // layout lives locally and is persisted once, on pointerup.
  const [draft, setDraft] = useState<Pc2Layout | null>(null)
  const dragRef = useRef<{ mode: 'move' | 'resize'; grabX: number; grabY: number } | null>(null)
  const layoutRef = useRef<Pc2Layout>(settings.pc2Layout)

  const layout = draft ?? settings.pc2Layout
  layoutRef.current = layout
  const rect = pc2Rect(layout)

  const setSwitching = useCallback(
    async (patch: Partial<Pick<AppSettings, 'dynamicSwitch' | 'mouseMode' | 'pc2Layout'>>) => {
      onSettingsChange(await window.bkmd.setSwitching(patch))
    },
    [onSettingsChange],
  )

  const pointerInCanvas = (event: React.PointerEvent) => {
    const bounds = canvasRef.current?.getBoundingClientRect()
    return {
      x: event.clientX - (bounds?.left ?? 0),
      y: event.clientY - (bounds?.top ?? 0),
    }
  }

  const beginDrag = (event: React.PointerEvent, mode: 'move' | 'resize') => {
    event.preventDefault()
    event.stopPropagation()
    const { x, y } = pointerInCanvas(event)
    const current = pc2Rect(layoutRef.current)
    dragRef.current = {
      mode,
      // Where inside PC2 the pointer grabbed, as a fraction of its size,
      // so the rectangle tracks the cursor across side and scale changes.
      grabX: current.width ? (x - current.left) / current.width : 0.5,
      grabY: current.height ? (y - current.top) / current.height : 0.5,
    }
    setDraft(layoutRef.current)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const { x, y } = pointerInCanvas(event)
    const current = layoutRef.current

    if (drag.mode === 'resize') {
      // The anchored (edge-start) corner stays put; the outer corner follows.
      const anchor = pc2Rect(current)
      const raw = isVertical(current.side)
        ? (y - anchor.top) / PC1_H
        : (x - anchor.left) / PC1_W
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw))
      setDraft({ ...current, scale, offset: clampOffset(current.offset, scale) })
      return
    }

    const side = sideForPointer(x, y)
    const offset = isVertical(side)
      ? (y - drag.grabY * current.scale * PC1_H - PC1_TOP) / PC1_H
      : (x - drag.grabX * current.scale * PC1_W - PC1_LEFT) / PC1_W
    setDraft({ ...current, side, offset: clampOffset(offset, current.scale) })
  }

  const endDrag = (event: React.PointerEvent) => {
    if (!dragRef.current) return
    dragRef.current = null
    const next = layoutRef.current
    setDraft(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    void setSwitching({ pc2Layout: next })
  }

  const handleClass = 'absolute size-3 rounded-full border border-white/70 bg-accent'
  const handlePosition = {
    right: 'right-[-6px] bottom-[-6px] cursor-nwse-resize',
    left: 'left-[-6px] bottom-[-6px] cursor-nesw-resize',
    bottom: 'right-[-6px] bottom-[-6px] cursor-nwse-resize',
    top: 'right-[-6px] top-[-6px] cursor-nesw-resize',
  }[layout.side]

  return (
    <div className="mx-auto max-w-2xl px-8 py-8">
      <header className="mb-8">
        <h2 className="text-xl font-semibold tracking-tight text-ink">Switching</h2>
        <p className="mt-0.5 text-[13px] text-ink-dim">
          Tell BKMD where the target computer sits relative to this one.
        </p>
      </header>

      <div className="space-y-7">
        <SettingsGroup title="Behaviour">
          <SettingsRow
            label="Dynamic switching"
            description="Hop to PC2 by moving the mouse across the screen edge"
          >
            <Toggle
              checked={settings.dynamicSwitch}
              onChange={(checked) => setSwitching({ dynamicSwitch: checked })}
            />
          </SettingsRow>
          <SettingsRow
            label="Mouse mode"
            description="How pointer motion is sent to the dongle"
          >
            <div className="flex rounded-md border border-line bg-surface-2 p-0.5">
              {(
                [
                  ['absolute', 'Absolute'],
                  ['relative', 'Legacy / fallback'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setSwitching({ mouseMode: mode })}
                  className={`rounded-[5px] px-2.5 py-1 text-xs transition-colors ${
                    settings.mouseMode === mode
                      ? 'bg-accent text-white'
                      : 'text-ink-dim hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Arrangement">
          <div className="px-4 py-4">
            <div
              ref={canvasRef}
              className="relative mx-auto overflow-hidden rounded-lg border border-line bg-win"
              style={{ width: CANVAS_W, height: CANVAS_H }}
            >
              {/* PC1 - fixed reference screen */}
              <div
                className="absolute flex items-center justify-center rounded-sm border border-line bg-surface-2 text-[11px] text-ink-dim"
                style={{ left: PC1_LEFT, top: PC1_TOP, width: PC1_W, height: PC1_H }}
              >
                PC1 · This Mac
              </div>

              {/* PC2 - draggable, always flush to a PC1 edge */}
              <div
                onPointerDown={(event) => beginDrag(event, 'move')}
                onPointerMove={handlePointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                className="absolute flex cursor-grab items-center justify-center rounded-sm border border-accent bg-accent/25 text-[11px] text-ink active:cursor-grabbing"
                style={{
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                }}
              >
                PC2
                <span
                  onPointerDown={(event) => beginDrag(event, 'resize')}
                  onPointerMove={handlePointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  className={`${handleClass} ${handlePosition}`}
                />
              </div>
            </div>

            <p className="mt-3 text-center text-xs text-ink-dim">
              {SIDE_LABEL[layout.side]} · offset {Math.round(layout.offset * 100)}% · size{' '}
              {layout.scale.toFixed(2)}×
            </p>
            <p className="mt-1 text-center text-xs text-ink-faint">
              You can only switch where the screens touch.
            </p>
          </div>
        </SettingsGroup>
      </div>
    </div>
  )
}
