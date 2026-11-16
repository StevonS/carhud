#!/usr/bin/env python3
"""Bake the EVA HUD fonts/layouts with a substitute for the commercial MatissePro font.

    MATISSE=/path/font.ttf EVA_FONT_SCALE=0.9 python3 eva_bake.py /opt/evahud [x y w h]

The layout generator checks that nothing overlaps. A substitute font with taller glyphs than
MatissePro fails those checks, so this shrinks only the substitute font by EVA_FONT_SCALE.
With the real MatissePro, leave EVA_FONT_SCALE unset (1.0). The repository is not modified.
"""
import os, sys
repo = sys.argv[1]
sys.path.insert(0, os.path.join(repo, 'tools'))
import bake_fonts  # noqa: E402
scale = float(os.environ.get('EVA_FONT_SCALE', '1'))
# per-atlas overrides, e.g. EVA_FONT_SCALES="label=0.75,line=0.75"
per = dict((k, float(v)) for k, v in (kv.split('=') for kv in os.environ.get('EVA_FONT_SCALES', '').split(',') if kv))
matisse = os.environ.get('MATISSE', '')
_orig = bake_fonts.bake
def bake(out, name, file, size, chars):
    if os.path.abspath(file) == os.path.abspath(matisse):
        key = name if name in per else name.split('_', 1)[-1]   # dash atlases are prefixed: c2_word -> word
        size = max(1, round(size * per.get(key, scale)))
    return _orig(out, name, file, size, chars)
bake_fonts.bake = bake
import eva_layout  # noqa: E402
eva_layout.bake_fonts.bake = bake
args = [int(v) for v in sys.argv[2:]]
eva_layout.main(*(args if len(args) == 4 else eva_layout.DEFAULT_AREA))
print('baked: %d font files' % len(os.listdir(os.path.join(repo, 'apps', 'eva_hud', 'hud', 'fonts'))))
