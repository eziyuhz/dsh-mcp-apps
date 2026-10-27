import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FRAME_HEIGHT,
  DEFAULT_FRAME_MAX_HEIGHT,
  DEFAULT_FRAME_MIN_HEIGHT,
  clampFrameHeight,
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

  it('keeps size-changed from shrinking below preferredHeight', () => {
    const floor = parsePreferredHeight(520, 160, 1200) ?? 160
    expect(Math.max(floor, clampFrameHeight(150, 160, 1200))).toBe(520)
  })
})
