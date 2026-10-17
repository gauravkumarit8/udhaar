#!/usr/bin/env bash
#
# Regenerates the Android launcher / splash / notification artwork from
# assets/logo.png into native/android/res/.
#
#   ./scripts/generate-android-icons.sh
#
# Why an overlay instead of letting `cap add android` draw it:
#
#   `npx cap add android` writes Capacitor's stock icon and splash into the
#   (generated, git-ignored) android/ project. Anything committed there would
#   be thrown away on the next `cap add`. So the files this script produces
#   live under native/android/res/ - a mirror of android/app/src/main/res/ -
#   and the Android workflow copies them over the generated project, after
#   generation and before Gradle runs.
#
# Why not @capacitor/assets: it needs `sharp`, whose prebuilt binary is
# downloaded at install time. That works on GitHub's runners, but it makes the
# icon depend on a network fetch at build time, and it cannot run in a sandbox
# without those certificates. ImageMagick is already on ubuntu-latest and
# produces the same files, so the artwork is reproducible anywhere:
#
#   apt-get install -y imagemagick fonts-dejavu
#
# assets/logo.png is the white rupee glyph on a transparent 1024x1024 canvas,
# with the glyph occupying 52% of the height - exactly the share an adaptive
# icon wants inside its 72dp safe zone, so it doubles as the foreground source.
set -euo pipefail

cd "$(dirname "$0")/.."

SRC=assets/logo.png
OUT=native/android/res
BRAND="#00855b"          # --brand in src/app/globals.css
SPLASH_BG="#064e3b"      # the colour capacitor.config.ts already declares

if [ ! -f "$SRC" ]; then
  echo "missing $SRC - the white rupee glyph on a transparent canvas" >&2
  exit 1
fi
command -v convert >/dev/null || { echo "ImageMagick (convert) is required" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"

# density name → multiplier of 1dp, in the order Android's buckets expect
DENSITIES=(mdpi:1 hdpi:1.5 xhdpi:2 xxhdpi:3 xxxhdpi:4)

glyph_at() {  # glyph_at <px> <outfile>  - white glyph, centred, transparent
  convert "$SRC" -resize "${1}x${1}" -background none -gravity center \
    -extent "${1}x${1}" "$2"
}

# ── Launcher ────────────────────────────────────────────────────────────────
# Adaptive icons (Android 8+) are two layers: a flat colour and the glyph, which
# the launcher masks to whatever shape the device uses. Legacy icons (7 and
# below) are a single image the launcher shows as drawn, so the shape has to be
# baked in - hence the rounded square and the circle.
for entry in "${DENSITIES[@]}"; do
  d=${entry%%:*}; m=${entry##*:}
  size=$(awk -v m="$m" 'BEGIN{printf "%d", 48*m}')
  fg=$(awk -v m="$m" 'BEGIN{printf "%d", 108*m}')
  icon="$OUT/mipmap-$d"
  mkdir -p "$icon"

  # adaptive foreground: transparent canvas, glyph inside the 72dp safe zone
  glyph_at "$fg" "$icon/ic_launcher_foreground.png"

  # legacy square: rounded rect worth 22% radius
  radius=$(awk -v s="$size" 'BEGIN{printf "%d", s*0.22}')
  convert -size "${size}x${size}" xc:none -fill "$BRAND" \
    -draw "roundrectangle 0,0,$((size-1)),$((size-1)),$radius,$radius" \
    /tmp/launcher-shape.png
  convert "$SRC" -resize "$(awk -v s="$size" 'BEGIN{printf "%d", s*0.60}')x" \
    -background none -gravity center -extent "${size}x${size}" /tmp/launcher-glyph.png
  convert /tmp/launcher-shape.png /tmp/launcher-glyph.png -gravity center \
    -composite "$icon/ic_launcher.png"

  # legacy round
  r=$(awk -v s="$size" 'BEGIN{printf "%d", s/2}')
  convert -size "${size}x${size}" xc:none -fill "$BRAND" \
    -draw "circle $r,$r $r,0" /tmp/launcher-circle.png
  convert /tmp/launcher-circle.png /tmp/launcher-glyph.png -gravity center \
    -composite "$icon/ic_launcher_round.png"

  # notification silhouette: white on transparent, 24dp, no background - Android
  # tints this itself and anything coloured comes out as a grey blob
  stat=$(awk -v m="$m" 'BEGIN{printf "%d", 24*m}')
  mkdir -p "$OUT/drawable-$d"
  glyph_at "$stat" "$OUT/drawable-$d/ic_stat_icon.png"
done

# the adaptive icon's background layer is a colour, not an image
mkdir -p "$OUT/values"
cat > "$OUT/values/ic_launcher_background.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- The design system's brand green (the brand token in globals.css),
         kept in step with assets/logo.png. -->
    <color name="ic_launcher_background">$BRAND</color>
</resources>
XML

# ── Splash ──────────────────────────────────────────────────────────────────
# Capacitor's splash is CENTER_CROP, so each density is the generated size for
# that bucket; the glyph is sized off the shorter side so portrait and
# landscape land at the same visual weight.
splash() { # splash <w> <h> <file>
  local w=$1 h=$2 f=$3 short=$1
  [ "$h" -lt "$w" ] && short=$h
  local g
  g=$(awk -v s="$short" 'BEGIN{printf "%d", s*0.34}')
  glyph_at "$g" /tmp/splash-glyph.png
  convert -size "${w}x${h}" "xc:$SPLASH_BG" /tmp/splash-glyph.png \
    -gravity center -composite "$f"
}

# These are the exact sizes Capacitor's own generator writes for each bucket,
# copied from a freshly generated project rather than derived from a multiplier
# (their table is not a consistent aspect ratio). Matching them means this
# overlay replaces artwork and nothing else - no drawable changes shape.
SPLASH_SIZES=(
  "mdpi:320x480:480x320"
  "hdpi:480x800:800x480"
  "xhdpi:720x1280:1280x720"
  "xxhdpi:960x1600:1600x960"
  "xxxhdpi:1280x1920:1920x1280"
)
for entry in "${SPLASH_SIZES[@]}"; do
  IFS=: read -r d port land <<< "$entry"
  mkdir -p "$OUT/drawable-port-$d" "$OUT/drawable-land-$d"
  splash ${port%x*} ${port#*x} "$OUT/drawable-port-$d/splash.png"
  splash ${land%x*} ${land#*x} "$OUT/drawable-land-$d/splash.png"
done

# aapt2 refuses a resource file with a malformed comment - notably one
# containing a double hyphen - and the failure only surfaces minutes later
# inside Gradle as ":app:mergeDebugResources". Parse the generated XML with a
# real parser instead of a grep: XML's comment rule is not a single-line rule,
# which a grep is (this exact bug cost a CI cycle).
if command -v python3 >/dev/null 2>&1; then
  python3 - "$OUT" <<'PYCHECK'
import glob, sys, xml.dom.minidom

bad = []
for path in glob.glob(sys.argv[1] + "/**/*.xml", recursive=True):
    try:
        xml.dom.minidom.parse(path)
    except Exception as exc:  # noqa: BLE001 - report every file, not the first
        bad.append(f"{path}: {exc}")
if bad:
    print("generated XML is not well-formed:", *bad, sep="\n  ", file=sys.stderr)
    sys.exit(1)
PYCHECK
fi

echo "generated $(find "$OUT" -name '*.png' | wc -l) images + 1 colour into $OUT"
echo
echo "Apply to a generated project with:"
echo "  npx cap add android && cp -R $OUT/. android/app/src/main/res/"
