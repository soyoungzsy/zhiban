#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then echo "请先从 https://nodejs.org 安装 Node.js 22 或更高版本。"; exit 1; fi
MOCK_VISION=1 HOST=127.0.0.1 node server/server.js
