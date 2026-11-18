#!/usr/bin/env python3
"""Builds src/ui/index.html (the plugin window) from the reference page sources."""
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent
t = (root / 'reference/template.html').read_text()
dsp = (root / 'reference/dsp.js').read_text(); ui = (root / 'reference/ui.js').read_text()
assert '</script' not in dsp + ui
(root / 'src/ui').mkdir(parents=True, exist_ok=True)
(root / 'src/ui/index.html').write_text(t.replace('/*DSP*/', dsp).replace('/*UI*/', ui))
