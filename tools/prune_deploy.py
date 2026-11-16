#!/usr/bin/env python3
"""Delete files from a bucket that no deployed page or catalogue still uses.

Run by `make deploy` after uploading. What's kept is everything referenced by
the files given: the new build's, and the ones that were live before the
upload, so pages that were already open can still load what they need.

  prune_deploy.py software s3://files-archi.medes.live/software/ \
      build/software/software.json live/software.json
  prune_deploy.py versions s3://archi.medes.live/v/ build/index.html live/index.html

`software` keeps software.json, each title's disc or archive, its icon and its
screenshots. `versions` keeps the v/<tag>/ directories the pages load from.
Everything else under the prefix is deleted. --dry-run lists what would go.
"""

import argparse
import json
import re
import shlex
import subprocess
import sys


def software_keep(catalogues):
    keep = {'software.json'}
    for path in catalogues:
        with open(path) as f:
            catalogue = json.load(f)
        for software_id, meta in catalogue.items():
            for key in ('disc', 'archive'):
                if key in meta:
                    keep.add(meta[key])
            keep.add(f'icons/{software_id}-icon.png')
            for shot in meta.get('screenshots', []):
                keep.add(f'screenshots/{shot}')
    return lambda key: key in keep


def versions_keep(pages):
    tags = set()
    for path in pages:
        with open(path) as f:
            tags.update(re.findall(r'["\']v/([^/"\']+)/', f.read()))
    if not tags:
        sys.exit(f'no v/<tag>/ found in {", ".join(pages)}')
    print(f'keeping versions: {", ".join(sorted(tags))}')
    return lambda key: key.split('/', 1)[0] in tags


def list_bucket(s3cmd, prefix):
    out = subprocess.run([*s3cmd, 'ls', '-r', prefix], check=True,
                         capture_output=True, text=True).stdout
    urls = []
    for line in out.splitlines():
        # <date> <time> <size> <url>
        parts = line.split(None, 3)
        if len(parts) == 4 and parts[3].startswith(prefix):
            urls.append(parts[3])
    return urls


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('kind', choices=('software', 'versions'))
    p.add_argument('prefix', help='bucket prefix, e.g. s3://bucket/software/')
    p.add_argument('keep_from', nargs='+',
                   help='catalogues (software) or pages (versions) whose files to keep')
    p.add_argument('--dry-run', action='store_true')
    p.add_argument('--s3cmd', default='s3cmd', help='s3cmd command line to use')
    args = p.parse_args()

    prefix = args.prefix.rstrip('/') + '/'
    keep = (software_keep if args.kind == 'software' else versions_keep)(args.keep_from)

    s3cmd = shlex.split(args.s3cmd)
    urls = list_bucket(s3cmd, prefix)
    doomed = [u for u in urls if not keep(u[len(prefix):])]
    print(f'{prefix}: {len(urls)} files, deleting {len(doomed)}')
    if len(doomed) == len(urls) and urls:
        sys.exit('refusing to delete everything')
    for u in doomed:
        print(f'  {u}')
    if args.dry_run or not doomed:
        return
    for i in range(0, len(doomed), 100):
        subprocess.run([*s3cmd, 'del', *doomed[i:i + 100]], check=True)


if __name__ == '__main__':
    main()
