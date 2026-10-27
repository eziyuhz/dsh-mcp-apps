import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FRAME_HEIGHT,
  DEFAULT_FRAME_MAX_HEIGHT,
  DEFAULT_FRAME_MIN_HEIGHT,
  clampFrameHeight,
  parsePreferredHeight,
  resolveFrameConfig,
} from '../src/frame'
import { platformAdapters, resolvePlatformAdapter } from '../src/platform-adapter'

describe('frame height', () => {
  it('uses the DSH platform adapter when config is omitted', () => {
    expect(resolveFrameConfig()).toEqual({
      defaultHeight: DEFAULT_FRAME_HEIGHT,
      minHeight: DEFAULT_FRAME_MIN_HEIGHT,
      maxHeight: DEFAULT_FRAME_MAX_HEIGHT,
    })
    expect(resolveFrameConfig()).toEqual({
      defaultHeight: platformAdapters.dsh.defaultHeight,
      minHeight: platformAdapters.dsh.minHeight,
      maxHeight: platformAdapters.dsh.maxHeight,
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

  it('caps a tall preferredHeight to the DSH adapter so the Turn does not fold', () => {
    const dsh = resolvePlatformAdapter('dsh')
    expect(parsePreferredHeight(720, dsh.minHeight, dsh.maxHeight)).toBe(dsh.maxHeight)
    expect(resolvePlatformAdapter('default').maxHeight).toBe(1200)
  })
})
