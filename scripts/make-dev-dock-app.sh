#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="${1:-$ROOT/build/Cosmos Dev.app}"
SCRIPT_PATH="$ROOT/scripts/dev-gui.sh"
ICON_PATH="$ROOT/build/icon.icns"
ICON_COMPOSER_PATH="$ROOT/build/icon.icon"

mkdir -p "$(dirname "$APP_PATH")"

if [[ -d "$ICON_COMPOSER_PATH" ]] && command -v actool >/dev/null 2>&1; then
	node "$ROOT/scripts/compile-icon-composer.mjs"
fi

TMP_SCRIPT="$(mktemp)"
cat >"$TMP_SCRIPT" <<EOF
on run
	tell application "Terminal"
		activate
		do script "cd $(printf %q "$ROOT") && $(printf %q "$SCRIPT_PATH")"
	end tell
end run
EOF

osacompile -o "$APP_PATH" "$TMP_SCRIPT"
rm -f "$TMP_SCRIPT"

if [[ -f "$ICON_PATH" ]]; then
	cp "$ICON_PATH" "$APP_PATH/Contents/Resources/applet.icns"
	touch "$APP_PATH"
fi

echo "Created: $APP_PATH"
echo "Drag this app into your Dock to launch Cosmos dev mode."
