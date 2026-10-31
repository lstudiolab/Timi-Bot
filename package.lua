return {
  name = "lstudiolab/timi-bot",
  version = "3.0.0",
  description = "Timi Discord bot implemented entirely in Lua.",
  author = "L Studio Lab",
  license = "MIT",
  private = true,
  dependencies = {
    -- Pin the complete Luvit runtime so its require/path/core modules stay in sync.
    "luvit/luvit@2.18.1",
    "luvit/coro-http@3.2.4",
    "luvit/coro-websocket@3.1.1"
  },
  files = {
    "**.lua",
    "!tests"
  }
}
