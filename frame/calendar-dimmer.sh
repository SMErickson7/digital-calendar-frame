#!/system/bin/sh
# Counter Calendar backlight helper
# Between 9:00 PM and 6:30 AM: dims the backlight after a while without a touch, and brightens it on the next touch.
# The rest of the day: leaves the backlight alone.
# Undo: stop it with "pkill -f calendar-dimmer" (or reboot), and delete this file.

# Always use Android's own tools, even when started from Termux at boot.
export PATH=/system/bin:/system/xbin:/sbin:/vendor/bin

TOUCH=/dev/input/event2                         # the touchscreen (gslX680-pad)
BL=/sys/class/backlight/backlight/brightness    # the backlight
IDLE=120                                        # seconds without a touch before dimming
DIM=3                                     # backlight level when idle at night
# normal level: Android's own brightness setting (the backlight itself can still be low while booting)
normal() {
  b=$(settings get system screen_brightness 2>/dev/null)
  case "$b" in ''|*[!0-9]*) b=128 ;; esac
  [ "$b" -le "$DIM" ] && b=128
  echo $b
}
BRIGHT=$(normal)
echo $BRIGHT > $BL       # start at the normal level

# Hours when dimming is allowed, in the frame's local time (minutes after midnight).
FROM=$((21 * 60))        # 9:00 PM
TO=$((6 * 60 + 30))      # 6:30 AM

is_dark() {
  h=$(date +%H); m=$(date +%M)
  now=$(( ${h#0} * 60 + ${m#0} ))
  if [ $FROM -gt $TO ]; then [ $now -ge $FROM ] || [ $now -lt $TO ]; else [ $now -ge $FROM ] && [ $now -lt $TO ]; fi
}

dimmed=0
while true; do
  if is_dark; then
    timeout $IDLE getevent -c 1 $TOUCH >/dev/null 2>&1
    rc=$?
    if [ $rc = 0 ]; then              # a touch: back to normal
      [ $dimmed = 1 ] && echo $BRIGHT > $BL && dimmed=0
    elif [ $rc = 124 ] || [ $rc -ge 128 ]; then   # timed out (124, or 142 on this frame): no touch for $IDLE seconds, dim
      [ $dimmed = 0 ] && BRIGHT=$(normal)
      echo $DIM > $BL; dimmed=1
    else                              # the touch check itself failed: stay bright, try again shortly
      [ $dimmed = 1 ] && echo $BRIGHT > $BL && dimmed=0
      sleep 10
    fi
  else
    [ $dimmed = 1 ] && echo $BRIGHT > $BL && dimmed=0
    sleep 60
  fi
done
