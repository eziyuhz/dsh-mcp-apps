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

  it('locks to preferredHeight instead of following a later size-changed echo', () => {
    const preferred = parsePreferredHeight(520, 160, 1200)
    expect(preferred).toBe(520)
    expect(preferred !== undefined ? preferred : clampFrameHeight(640, 160, 1200)).toBe(520)
  })
})
