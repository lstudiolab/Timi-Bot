#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail

if [[ -z "${PREFIX:-}" || ! -d "$PREFIX" || "$(uname -o 2>/dev/null || true)" != "Android" ]]; then
  printf '%s\n' "This installer is for Termux on Android."
  exit 1
fi

if [[ ! -f package.lua || ! -f main.lua ]]; then
  printf '%s\n' "Run this script from the Timi-Bot repository root."
  exit 1
fi

printf '\n== Updating Termux packages ==\n'
pkg update
pkg upgrade -y

printf '\n== Installing Luvi, Lit, and Git ==\n'
pkg install -y git luvi lit

for command in luvi lit luajit; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Required command not found after installation: %s\n' "$command" >&2
    exit 1
  fi
done

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  printf '\nCreated .env from .env.example. Add DISCORD_TOKEN and CLIENT_ID before starting Timi.\n'
else
  chmod 600 .env
  printf '\nExisting .env preserved.\n'
fi

printf '\n== Installing the pinned Luvit runtime and application dependencies ==\n'
lit install

if [[ ! -f deps/luvit/init.lua ]]; then
  printf '%s\n' "The pinned Luvit runtime was not installed at deps/luvit/init.lua." >&2
  printf '%s\n' "Check the Lit installation output before starting Timi." >&2
  exit 1
fi

for module in fs json coro-http coro-websocket; do
  if [[ ! -d "deps/$module" && ! -f "deps/$module.lua" && ! -f "deps/$module/init.lua" ]]; then
    printf 'Required dependency was not installed: %s\n' "$module" >&2
    exit 1
  fi
done

printf '\n== Checking Lua source syntax ==\n'
while IFS= read -r -d '' file; do
  luajit -b "$file" /dev/null
done < <(find . -name '*.lua' -not -path './deps/*' -not -path './.git/*' -print0)

printf '\nTimi Lua runtime is prepared.\n'
printf 'Start Timi with: luvi .\n'
