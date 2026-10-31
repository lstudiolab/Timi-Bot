return {
  name = "lstudiolab/timi-bot",
  version = "3.0.0",
  description = "Timi Discord bot implemented entirely in Lua.",
  author = "L Studio Lab",
  license = "MIT",
  private = true,
  dependencies = {
    "luvit/fs@2.0.1",
    "luvit/json@2.5.1",
    "luvit/coro-http@3.2.4",
    "luvit/coro-websocket@3.1.1"
  },
  files = {
    "**.lua",
    "!tests"
  }
}
