#!/bin/sh
# Сборка пульта (macOS/Linux): копирует UI внутрь бинарника и собирает.
# ./build.sh              — под текущую платформу
# ./build.sh darwin arm64 — кросс-сборка (запускать можно откуда угодно)
set -e
cd "$(dirname "$0")"
rm -rf public && cp -r ../public public
mkdir -p dist
export GOTOOLCHAIN=local
if [ -n "$1" ]; then
  GOOS="$1" GOARCH="${2:-arm64}" go build -trimpath -ldflags "-s -w" \
    -o "dist/pult-$1-${2:-arm64}" .
  echo "Готово: dist/pult-$1-${2:-arm64}"
else
  go build -trimpath -ldflags "-s -w" -o dist/pult .
  echo "Готово: dist/pult"
fi
