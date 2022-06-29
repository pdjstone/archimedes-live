#!/usr/bin/env python3
import os
import sys
import toml
import json
import shutil

# map of id to toml filename
all_software_ids = {}

out_dir = None

MANDATORY_FIELDS = (
    'title', 
)

VALID_FIELDS = (
    'author', 'publisher',
    'year',
    'version',
    'disc', 'archive',
    'tags',
    'description',
    'working',
    'best-os'
)
VALID_FIELDS = set(VALID_FIELDS +  MANDATORY_FIELDS)


VALID_TAGS = (
    'game', 
    'demo', 
    'public-domain', 
    'education',
    'utility',
    'music',
    'ex-commercial',
    'demo-scene'
)

VALID_OS = (
    'arthur120',
    'riscos201',
    'riscos311'
)


def find_toml_files(root_dir):
    for root, dirs, files in os.walk(root_dir):
        for f in files:
            if f.endswith('.toml'):
                yield root, f


def parse_toml(root, file):
    
    toml_path = os.path.join(root, file)
    print(f'parsing {toml_path}')
    data = toml.load(toml_path)
   
    for software_id, disc_meta in data.items():
        if software_id in all_software_ids:
            existing_toml_file = all_software_ids[software_id]
            raise Exception(f"Duplicate software id '{software_id}' in {toml_path} (existing one in {existing_toml_file})")

        if 'disc' not in disc_meta and 'archive' not in disc_meta:
            raise Exception(f"Must have 'disc' or 'archive' field ('{software_id}' in {toml_path})")

        if 'disc' in disc_meta and 'archive' in disc_meta:
            raise Exception(f"Cannot define 'disc' and 'archive' '{software_id}' in {toml_path}")
        
        if 'disc' in disc_meta:
            disc_meta['disc'] = copy_to_out_dir(root, disc_meta['disc'], software_id)
        elif 'archive' in disc_meta:
            disc_meta['archive'] = copy_to_out_dir(root, disc_meta['archive'], software_id)

        for field in MANDATORY_FIELDS:
            if type(field) == str:
                if field not in disc_meta:
                    raise Exception(f"Field '{field}' missing from '{software_id}' in {toml_path}")
        
        if 'tags' in disc_meta:
            tags = disc_meta['tags'].split(',')
            for t in tags:
                if t not in VALID_TAGS:
                    raise Exception(f"'{software_id}' in {toml_path}: Unknown tag '{t}'")

        if 'best-os' in disc_meta and disc_meta['best-os'] not in VALID_OS:
            raise Exception(f"'{software_id}' in {toml_path}: Invalid best-os: {disc_meta['best-os']}")
        for field in disc_meta.keys():
            if field not in VALID_FIELDS:
                raise Exception(f"Unknown field '{field}' in '{software_id}' ({toml_path})")

        all_software_ids[software_id] = toml_path
        disc_meta['id'] = software_id
   
    return data


def copy_to_out_dir(root, path, software_id) -> str:
    global out_dir
    src_path = os.path.join(root, path)
    if not os.path.isfile(src_path):
        raise Exception(f"file {src_path} does not exist ({software_id})")
    base_name, ext = os.path.splitext(os.path.basename(src_path))
    if len(ext) == 0:
        raise Exception(f"bad extension on file {src_path} ({software_id}")
    new_name = f'{software_id}{ext}'
    dst_path = os.path.join(out_dir, new_name)
    print(f'Copying {src_path} to {dst_path}')
    shutil.copy(src_path, dst_path)
    return new_name 

if __name__ == '__main__':
    src_dir = None
 
    try:
        src_dir, out_dir = sys.argv[1:3]
    except:
        print(f"Usage: {sys.argv[0]} src_dir out_dir")
        sys.exit(-1)

    assert os.path.isdir(src_dir), f"No such src_dir {src_dir}"
    
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    json_data = {}
    for root, file in find_toml_files(src_dir):
        data = parse_toml(root, file)
        json_data |= data

    json_out = os.path.join(out_dir, 'software.json')
    with open(json_out, 'w') as f:
        json.dump(json_data, f, indent=True)
 