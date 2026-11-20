#!/usr/bin/env python3
"""Builds the Mani Amazon extension for Chrome and Firefox into amazon-extension/dist/.

  dist/chrome/                    load in Chrome: chrome://extensions → Developer mode → Load unpacked
  dist/firefox/                   try in Firefox: about:debugging → This Firefox → Load Temporary Add-on (manifest.json)
  dist/mani-amazon-firefox.zip    upload to addons.mozilla.org to have Mozilla sign it for permanent install
"""
import shutil
import zipfile
from pathlib import Path

SRC = Path(__file__).resolve().parent
DIST = SRC / 'dist'
SHARED = ['parse.js', 'sync-core.js', 'popup.html', 'popup.js', 'options.html', 'options.js', 'icon48.png', 'icon128.png']
BUILDS = {
    'chrome': {'manifest.json': 'manifest.json', 'files': ['background.js', 'offscreen.html', 'offscreen.js']},
    'firefox': {'manifest.json': 'manifest.firefox.json', 'files': ['background-firefox.html', 'background-firefox.js', 'tab-reader.js', 'reader.js']},
}

shutil.rmtree(DIST, ignore_errors=True)
for name, b in BUILDS.items():
    out = DIST / name
    out.mkdir(parents=True)
    shutil.copy(SRC / b['manifest.json'], out / 'manifest.json')
    for f in SHARED + b['files']:
        shutil.copy(SRC / f, out / f)
    print(f'built {out.relative_to(SRC.parent)}')

# Mozilla wants the files at the top level of the zip, not inside a folder.
zip_path = DIST / 'mani-amazon-firefox.zip'
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in sorted((DIST / 'firefox').iterdir()):
        z.write(f, f.name)
print(f'built {zip_path.relative_to(SRC.parent)}')
