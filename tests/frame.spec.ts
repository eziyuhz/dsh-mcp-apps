import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FRAME_HEIGHT,
  DEFAULT_FRAME_MAX_HEIGHT,
  DEFAULT_FRAME_MIN_HEIGHT,
  clampFrameHeight,
  hostContainerHeight,
  parsePreferredHeight,
  resolveFrameConfig,
} from '../src/frame'

describe('frame height', () => {
  it('uses compiled defaults when config is omitted', () => {
    expect(resolveFrameConfig()).toEqual({
      defaultHeight: DEFAULT_FRAME_HEIGHT,
      minHeight: DEFAULT_FRAME_MIN_HEIGHT,
      maxHeight: DEFAULT_FRAME_MAX_HEIGHT,
    })
  })

  it('raises defaultHeight into the min/max window', () => {
    expect(resolveFrameConfig({ defaultHeight: 80, minHeight: 200, maxHeight: 400 })).toEqual({
      defaultHeight: 200,
      minHeight: 200,
      maxHeight: 400,
    })
  })

  it('clamps preferredHeight and ignores non-finite values', () => {
    expect(parsePreferredHeight(520, 160, 1200)).toBe(520)
    expect(parsePreferredHeight(40, 160, 1200)).toBe(160)
    expect(parsePreferredHeight(Number.NaN, 160, 1200)).toBeUndefined()
    expect(clampFrameHeight(Number.POSITIVE_INFINITY, 160, 1200)).toBe(160)
  })

  it('locks the iframe to the host scroller instead of preferredHeight or size-changed', () => {
    expect(hostContainerHeight(160, 1200, 900)).toBe(900)
    expect(hostContainerHeight(160, 400, 900)).toBe(400)
    expect(hostContainerHeight(160, 1200, 160)).toBe(160)
    expect(parsePreferredHeight(720, 160, 1200)).toBe(720)
    expect(hostContainerHeight(160, 1200, 900)).not.toBe(720)
  })
})
