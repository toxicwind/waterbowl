#!/bin/bash
# browser-toggle.sh: show/hide the keeper Chromium viewer window via TigerVNC / Hyprland.
# Connects to the isolated keeper display (Xvnc :99 at 127.0.0.1:5900).
#
# Dispatch note: this Hyprland runs an estate Lua config, so `hyprctl dispatch`
# arguments are evaluated as Lua by hl.dispatch(). Bare Hyprland dispatch words
# ("movetoworkspacesilent", "focuswindow", ...) are Lua syntax errors (exit 7).
# Only hl.dsp.* dispatcher expressions work:
#   hl.dsp.window.move({workspace=<ws>, window="address:0x..."})  -- move a window
#   hl.dsp.focus({window="address:0x..."})                        -- focus a window
#   hl.dsp.workspace.toggle_special("<name>")                     -- toggle special ws
# Errors are surfaced instead of being swallowed by `> /dev/null 2>&1 || true`,
# which previously hid both the Lua syntax errors and hl.focus "window not found".
set -u

VNC_PASSWD="/home/toxic/.browserless/vncpasswd"
VNC_HOST="127.0.0.1:5900"

if [ -z "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]; then
  for d in /run/user/1000/hypr/*/; do
    sig="$(basename "$d")"
    if HYPRLAND_INSTANCE_SIGNATURE="$sig" hyprctl clients -j >/dev/null 2>&1; then
      export HYPRLAND_INSTANCE_SIGNATURE="$sig"
      break
    fi
  done
fi

# Find running TigerVNC viewer window on Hyprland
INFO="$(hyprctl clients -j 2>/dev/null | python3 -c "import json,sys
cs=json.load(sys.stdin)
for c in cs:
    cls = c.get('class', '').lower()
    if 'vnc' in cls or 'tiger' in cls:
        print(str(c.get('address','')) + '|' + str(c.get('workspace',{}).get('name','')))
        break
")"

if [ -n "$INFO" ]; then
  ADDR="${INFO%%|*}"
  WS="${INFO##*|}"
  SEL="address:$ADDR"
  if [[ "$WS" == *"special"* ]]; then
    # Hidden on the special:browser scratchpad: bring it back onto the active
    # workspace and focus it. "e+0" was not a valid workspace and silently
    # no-oped, which is why the toggle appeared to do nothing.
    CUR_WS="$(hyprctl activeworkspace -j | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
    hyprctl dispatch "hl.dsp.window.move({workspace=\"$CUR_WS\", window=\"$SEL\"})"
    hyprctl dispatch "hl.dsp.focus({window=\"$SEL\"})"
  else
    # Visible on a normal workspace: park it on special:browser, then toggle
    # that workspace so the window is actually shown again.
    hyprctl dispatch "hl.dsp.window.move({workspace=\"special:browser\", window=\"$SEL\"})"
    hyprctl dispatch 'hl.dsp.workspace.toggle_special("browser")'
  fi
else
  # Launch TigerVNC viewer connected to keeper
  WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}" DISPLAY="${DISPLAY:-:0}" \
    vncviewer -RemoteResize -geometry 1600x900 -passwd "$VNC_PASSWD" "$VNC_HOST" >/dev/null 2>&1 &
fi