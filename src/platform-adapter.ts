export type HostPlatform = 'dsh' | 'default'

export interface PlatformUiAdapter {
  id: HostPlatform
  /** Initial iframe height in pixels. */
  defaultHeight: number
  minHeight: number
  /** Cap so the DSH Turn does not fold a tall card. */
  maxHeight: number
}

/**
 * Per-host UI differences. This plugin only runs inside DSH, so `dsh` is
 * the active adapter. `default` documents the unconstrained MCP Apps size
 * other hosts can use.
 */
export const platformAdapters: Record<HostPlatform, PlatformUiAdapter> = {
  dsh: {
    id: 'dsh',
    defaultHeight: 320,
    minHeight: 160,
    maxHeight: 360,
  },
  default: {
    id: 'default',
    defaultHeight: 360,
    minHeight: 160,
    maxHeight: 1200,
  },
}

export const ACTIVE_PLATFORM: HostPlatform = 'dsh'

export function resolvePlatformAdapter(platform: HostPlatform = ACTIVE_PLATFORM): PlatformUiAdapter {
  return platformAdapters[platform]
}
