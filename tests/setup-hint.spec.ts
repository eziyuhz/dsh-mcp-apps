import { describe, expect, it } from 'vitest'
import { SETUP_HINT, SETUP_TOOL_NAME } from '../src/setup-hint'

describe('setup hint', () => {
  it('tells the user to patch their own profile and does not name a product server', () => {
    expect(SETUP_TOOL_NAME).toBe('mcp_apps_setup')
    expect(SETUP_HINT).toContain('id: mcp-apps')
    expect(SETUP_HINT).toContain('cordis.patch.yml')
    expect(SETUP_HINT).toContain('不要使用 insert:')
    expect(SETUP_HINT).not.toMatch(/127\.0\.0\.1|pharmmaster/i)
  })
})