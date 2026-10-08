#!/usr/bin/env python
"""Load the app in headless Firefox, log console output and JS errors, and
take a screenshot a fixed time after page load.

Usage: scripts/screenshot.py [--url URL] [--wait SECONDS] [--out NAME]
Screenshots are written to build/screenshots/NAME.png
"""
import argparse
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.firefox.options import Options

SCREENSHOT_DIR = Path(__file__).resolve().parent.parent / 'build' / 'screenshots'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://localhost:8000/')
    ap.add_argument('--wait', type=float, default=15, help='seconds to wait after page load')
    ap.add_argument('--out', default='screenshot', help='screenshot name (without .png)')
    ap.add_argument('--width', type=int, default=1280)
    ap.add_argument('--height', type=int, default=800)
    args = ap.parse_args()

    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    path = SCREENSHOT_DIR / f'{args.out}.png'
    path.unlink(missing_ok=True)

    opts = Options()
    opts.add_argument('-headless')
    opts.enable_bidi = True
    driver = webdriver.Firefox(options=opts)
    logs = []
    try:
        driver.script.add_console_message_handler(lambda m: logs.append((f'console.{m.level}', m.text)))
        driver.script.add_javascript_error_handler(lambda e: logs.append(('jserror', e.text)))
        driver.set_window_size(args.width, args.height)
        driver.get(args.url)
        time.sleep(args.wait)

        # print the log first so it survives if the browser dies on screenshot
        for kind, text in logs:
            print(kind, text[:300])
        print('total', len(logs), flush=True)

        try:
            driver.save_screenshot(str(path))
            print('screenshot saved:', path)
        except Exception as e:
            print('screenshot failed:', str(e)[:200])
    finally:
        try:
            driver.quit()
        except Exception:
            pass


if __name__ == '__main__':
    main()
