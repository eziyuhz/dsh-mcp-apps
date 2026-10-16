export const SETUP_TOOL_NAME = 'mcp_apps_setup'

export const SETUP_HINT = `还没有配置 MCP 服务器，所以没有任何 MCP App 工具。

在 DSH profile 的 cordis.patch.yml 里追加下面这一段。不要使用 insert:，那会再创建一行 mcp-apps。

- id: mcp-apps
  config:
    servers:
      my-server:
        transport: streamable-http
        url: https://example.com/mcp

把 url 换成你自己的 MCP 地址。保存后重新打开 DeepSeek Harness。`
