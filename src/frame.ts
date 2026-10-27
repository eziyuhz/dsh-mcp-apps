import { resolvePlatformAdapter, type PlatformUiAdapter } from './platform-adapter'

const dsh = resolvePlatformAdapter('dsh')

export const DEFAULT_FRAME_HEIGHT = dsh.defaultHeight
export const DEFAULT_FRAME_MIN_HEIGHT = dsh.minHeight
export const DEFAULT_FRAME_MAX_HEIGHT = dsh.maxHeight

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

export function resolveFrameConfig(
  input?: Partial<FrameConfig> | null,
  adapter: PlatformUiAdapter = resolvePlatformAdapter(),
): FrameConfig {
  const minHeight = finitePositive(input?.minHeight, adapter.minHeight)
  const maxHeight = Math.max(minHeight, finitePositive(input?.maxHeight, adapter.maxHeight))
  const defaultHeight = clampFrameHeight(
    finitePositive(input?.defaultHeight, adapter.defaultHeight),
    minHeight,
    maxHeight,
  )
  return { defaultHeight, minHeight, maxHeight }
}

export function parsePreferredHeight(value: unknown, minHeight: number, maxHeight: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return clampFrameHeight(value, minHeight, maxHeight)
}
