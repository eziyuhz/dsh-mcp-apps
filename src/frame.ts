export const DEFAULT_FRAME_HEIGHT = 360
export const DEFAULT_FRAME_MIN_HEIGHT = 160
export const DEFAULT_FRAME_MAX_HEIGHT = 1200
/** DSH chrome outside the chat pane (title bar + composer). Used when no inner scroller is found. */
export const DEFAULT_HOST_CHROME_PX = 160

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

function viewportFallback(): number {
  if (typeof window !== 'undefined' && Number.isFinite(window.innerHeight) && window.innerHeight > 0) {
    return window.innerHeight
  }
  return DEFAULT_FRAME_HEIGHT + DEFAULT_HOST_CHROME_PX
}

/** Height of the nearest overflow scroller, skipping html/body. */
export function scrollParentHeight(node: HTMLElement | null | undefined): number | undefined {
  if (!node || typeof getComputedStyle !== 'function') return undefined
  let el: HTMLElement | null = node.parentElement
  while (el && el !== document.body && el !== document.documentElement) {
    const overflowY = getComputedStyle(el).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && el.clientHeight >= DEFAULT_FRAME_MIN_HEIGHT) {
      return el.clientHeight
    }
    el = el.parentElement
  }
  return undefined
}

/**
 * DSH owns iframe height: fill the host pane, never follow app size-changed.
 * `viewportHeight` is the chat scroller when known; otherwise the window minus chrome.
 */
export function hostContainerHeight(
  minHeight: number,
  maxHeight: number,
  viewportHeight?: number,
  chromePx = DEFAULT_HOST_CHROME_PX,
): number {
  const hasScroller = typeof viewportHeight === 'number' && Number.isFinite(viewportHeight) && viewportHeight >= DEFAULT_FRAME_MIN_HEIGHT
  if (hasScroller) return clampFrameHeight(viewportHeight, minHeight, maxHeight)
  return clampFrameHeight(viewportFallback() - chromePx, minHeight, maxHeight)
}
