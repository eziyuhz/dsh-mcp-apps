export const DEFAULT_FRAME_HEIGHT = 360
export const DEFAULT_FRAME_MIN_HEIGHT = 160
export const DEFAULT_FRAME_MAX_HEIGHT = 1200

export interface FrameConfig {
  defaultHeight: number
  minHeight: number
  maxHeight: number
}

function finitePositive(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.round(value)
}

export function clampFrameHeight(height: number, minHeight: number, maxHeight: number): number {
  if (!Number.isFinite(height)) return minHeight
  return Math.max(minHeight, Math.min(Math.round(height), maxHeight))
}

export function resolveFrameConfig(input?: Partial<FrameConfig> | null): FrameConfig {
  const minHeight = finitePositive(input?.minHeight, DEFAULT_FRAME_MIN_HEIGHT)
  const maxHeight = Math.max(minHeight, finitePositive(input?.maxHeight, DEFAULT_FRAME_MAX_HEIGHT))
  const defaultHeight = clampFrameHeight(
    finitePositive(input?.defaultHeight, DEFAULT_FRAME_HEIGHT),
    minHeight,
    maxHeight,
  )
  return { defaultHeight, minHeight, maxHeight }
}

export function parsePreferredHeight(value: unknown, minHeight: number, maxHeight: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return clampFrameHeight(value, minHeight, maxHeight)
}
