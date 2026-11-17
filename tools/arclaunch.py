#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.13"
# dependencies = [
#     "riscos-conv",
# ]
# ///
"""Launch a software catalogue title in upstream (native) Arculator.

Sets Arculator up the way Archimedes Live does for #disc=ID&autoboot
(loadMachineConfig in frontend/worker/arculator-worker.js), then runs it:

- picks the machine preset the title recommends (recommendMachinePreset in
  frontend/shared/machines.js), unless --preset is given
- empties HostFS and unpacks the title's archive, and those of the titles it
  depends on, onto it (frontend/worker/hostfs.js), with riscos-conv
- puts a disc image in drive 0 (disc_name_0)
- writes HostFS !Boot with the title's boot commands
  (getAutobootScript in frontend/worker/machine-setup.js)
- writes the machine config and CMOS (getMachineConfigFile in machines.js,
  makeCmos in frontend/worker/cmos.js), set to boot from HostFS
- runs ./arculator CONFIG

There's no fast-forward, so the title's ff-ms (the time it takes to boot) is
just printed. The ROMs must already be in Arculator's roms/ directory.

    uv run tools/arclaunch.py lander
    uv run tools/arclaunch.py bs-django01 --arculator ~/projects/arculator
    uv run tools/arclaunch.py --list
    # with a riscos-conv checkout instead of the PyPI release:
    uv run --with ~/projects/riscos-conv tools/arclaunch.py lander

The presets, config text and CMOS settings are copies of the JS ones, so keep
them in step with machines.js and cmos.js.
"""

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from zipfile import ZipFile

from riscosconv.arcfs import ArcFSArchive
from riscosconv.indentify import KnownFileType, identify_file
from riscosconv.riscos_path import PureRiscOsPath, as_ro_path
from riscosconv.spark import SparkArchive

REPO = Path(__file__).resolve().parent.parent
LIVE_SOFTWARE_BASE = 'https://files-archi.medes.live/software/'

# --- Machines (frontend/shared/machines.js) ---

CPU_ARM2, CPU_ARM250, CPU_ARM3_20, CPU_ARM3_25, CPU_ARM3_26 = 0, 1, 2, 3, 4
CPU_ARM3_33, CPU_ARM3_35, CPU_ARM3_24 = 6, 7, 8
MEMC_MEMC1, MEMC_MEMC1A_8, MEMC_MEMC1A_12 = 0, 1, 2
FDC_WD1770, FDC_82C711 = 0, 1

DEFAULTS = dict(mem_size=4096, cpu_type=0, memc_type=0, fpa_enabled=0, fpa_type=1,
                rom_set='riscos311', fdc_type=FDC_82C711, monitor_type='multisync')

PRESETS = {
    'a310-arthur': dict(machine='a310', cpu_type=CPU_ARM2, mem_size=1024,
                        memc_type=MEMC_MEMC1, fdc_type=FDC_WD1770, rom_set='arthur120'),
    'a310-ro2':    dict(machine='a310', cpu_type=CPU_ARM2, mem_size=4096,
                        memc_type=MEMC_MEMC1, fdc_type=FDC_WD1770, rom_set='riscos201'),
    'a3000':       dict(machine='a3000', cpu_type=CPU_ARM2, mem_size=2048,
                        memc_type=MEMC_MEMC1A_8, fdc_type=FDC_WD1770, rom_set='riscos311'),
    'a5000':       dict(machine='a5000', cpu_type=CPU_ARM3_25, mem_size=4096,
                        memc_type=MEMC_MEMC1A_12, rom_set='riscos311'),
    'a3020':       dict(machine='a3020', cpu_type=CPU_ARM250, mem_size=4096,
                        memc_type=MEMC_MEMC1A_12, rom_set='riscos311'),
    'a540':        dict(machine='a540', cpu_type=CPU_ARM3_26, mem_size=16384,
                        memc_type=MEMC_MEMC1A_12, rom_set='riscos311'),
}


def recommend_preset(meta):
    mem = meta.get('min-mem', 0)
    os_ = meta.get('best-os', 'riscos311')
    cpu = meta.get('best-cpu')
    if cpu in ('arm2', None):
        if os_ == 'arthur120' and mem <= 1024:
            return 'a310-arthur'
        if os_ == 'riscos201' and mem <= 2048:
            return 'a310-ro2'
    if os_ == 'riscos311':
        if cpu in (None, 'arm2') and mem <= 2048:
            return 'a3000'
        if cpu in (None, 'arm250') and mem <= 4096:
            return 'a3020'
        if cpu == 'arm3' and mem <= 4096:
            return 'a5000'
    return None


def cmos_name(c):
    rom = c['rom_set']
    if rom.startswith('arthur'):
        return 'arthur'
    if rom.startswith('riscos2'):
        return 'riscos2'
    if rom.startswith('riscos3'):
        return 'riscos3_new' if c['fdc_type'] == FDC_82C711 else 'riscos3_old'
    return ''


def machine_config_file(c, disc):
    return f"""machine = {c['machine']}
disc_name_0 = {disc}
disc_name_1 =
disc_name_2 =
disc_name_3 =
mem_size = {c['mem_size']}
cpu_type = {c['cpu_type']}
memc_type = {c['memc_type']}
fpa = {1 if c['fpa_enabled'] else 0}
fpu_type = {c['fpa_type']}
display_mode = 0
double_scan = 1
video_scale = 1
video_fullscreen_scale = 0
video_linear_filtering = 0
video_black_level = 1
fdc_type = {c['fdc_type']}
st506_present = 1
rom_set = {c['rom_set']}
monitor_type = {c['monitor_type']}
joystick_if = none
unique_id = -490017344
hd4_fn =
hd4_sectors = 63
hd4_heads = 16
hd4_cylinders = 100
hd5_fn =
hd5_sectors = 63
hd5_heads = 16
hd5_cylinders = 100
renderer_driver = auto
podule_0 = arculator_rom
podule_1 =
podule_2 =
podule_3 =
5th_column_fn =
support_rom_enabled = 1

[Joysticks]
joystick_0_nr = 0
joystick_1_nr = 0
"""

# --- CMOS (frontend/worker/cmos.js) ---

class CMOS:
    NET_FS_STATION = 1; NET_PS_STATION = 3; FILESYSTEM = 5; SCREEN = 10
    KEYBOARD = 11; KEY_DELAY = 12; KEY_REPEAT = 13; PRINTER_IGNORE = 14
    PRINTER = 15; MISC_FLAGS = 16; NETFILER = 17; FILESWITCH = 28
    YEAR_LO = 128; YEAR_HI = 129; DUMP_FORMAT = 132; MONITOR = 133
    FONT_SIZE = 134; ADFS_DRIVES = 135; ADFS_STEP = 136; ADFS_BUFFERS = 137
    CDROMFS = 138; TIMEZONE = 139; DESKTOP_FEATURES = 140; SELECTED_PRINTER = 141
    RMA_SIZE = 146; SPRITE_SIZE = 147; SOUND_DEFAULT = 148; LANGUAGE = 185
    COUNTRY = 186; MOUSE_STEP = 194; SYSTEM_FLAGS = 195; MODE = 196
    WIMP_FLAGS = 197; DESKTOP_STATE = 198; CHECKSUM = 239

MISC_FLAGS_BOOT = 0x10
SYSTEM_FLAGS_CMOS_RESET = 0x04
SYSTEM_FLAGS_MODE_AUTO = 0x10
FS_ADFS, FS_HOSTFS = 8, 153

COMMON = {
    CMOS.NET_FS_STATION: 0xfe, CMOS.NET_PS_STATION: 0xeb, CMOS.FILESYSTEM: FS_ADFS,
    CMOS.SCREEN: 0x10, CMOS.KEY_DELAY: 0x20, CMOS.KEY_REPEAT: 0x08,
    CMOS.PRINTER_IGNORE: 0x0a, CMOS.PRINTER: 0x2c, CMOS.MISC_FLAGS: 0x80,
    CMOS.ADFS_DRIVES: 0x01, CMOS.ADFS_STEP: 0xff, CMOS.SOUND_DEFAULT: 0xf0,
    CMOS.COUNTRY: 0x01,
}
RISC_OS_2 = {
    **COMMON,
    CMOS.KEYBOARD: 0x60, CMOS.MONITOR: 0x01, CMOS.FONT_SIZE: 0x06,
    CMOS.CDROMFS: 0x08, CMOS.TIMEZONE: 0xff, CMOS.SELECTED_PRINTER: 0xff,
    CMOS.DESKTOP_FEATURES: 0xff, CMOS.RMA_SIZE: 0x02, CMOS.SPRITE_SIZE: 0x01,
    CMOS.LANGUAGE: 0x03,
}
CMOS_SETTINGS = {
    'arthur': RISC_OS_2,
    'riscos2': {**RISC_OS_2, CMOS.NETFILER: 0x02, CMOS.DUMP_FORMAT: 0x04,
                CMOS.ADFS_BUFFERS: 0x01},
    'riscos3': {
        **COMMON,
        CMOS.KEYBOARD: 0x50, CMOS.NETFILER: 0x02, CMOS.FILESWITCH: 0x01,
        CMOS.DUMP_FORMAT: 0x04, CMOS.MONITOR: 0xfd, CMOS.FONT_SIZE: 0x08,
        CMOS.ADFS_BUFFERS: 0x01, CMOS.LANGUAGE: 0x0a, CMOS.MOUSE_STEP: 0x03,
        CMOS.SYSTEM_FLAGS: SYSTEM_FLAGS_MODE_AUTO | SYSTEM_FLAGS_CMOS_RESET,
        CMOS.WIMP_FLAGS: 0x6f, CMOS.DESKTOP_STATE: 0x40,
    },
}
ROM_YEARS = dict(arthur030=1987, arthur120=1987, riscos200=1988, riscos201=1990,
                 riscos300=1991, riscos310=1992, riscos311=1992, riscos319=1993)
BOOT_FILESYSTEMS = {'adfs': FS_ADFS, 'hostfs': FS_HOSTFS}


def rom_year(rom_set):
    return ROM_YEARS.get(re.sub(r'_a500$', '', rom_set))


def cmos_family(name):
    return 'riscos3' if name.startswith('riscos3') else name


def can_boot_from(name, boot_fs):
    if boot_fs == 'hostfs':   # HostFS is in the support ROM, which only RISC OS 3 loads
        return cmos_family(name) == 'riscos3'
    return boot_fs in BOOT_FILESYSTEMS and cmos_family(name) in CMOS_SETTINGS


def _physical(logical):
    return (logical + 0x40) & 0xff if logical < 0xc0 else logical - 0xb0


def make_cmos(name, boot_fs=None, year=None):
    settings = CMOS_SETTINGS[cmos_family(name)]
    cmos = bytearray(256)

    def write(logical, value):
        cmos[_physical(logical)] = value & 0xff

    for logical, value in settings.items():
        write(logical, value)
    if year:
        write(CMOS.YEAR_LO, year % 100)
        write(CMOS.YEAR_HI, year // 100)
    if boot_fs:
        write(CMOS.FILESYSTEM, BOOT_FILESYSTEMS[boot_fs])
        write(CMOS.MISC_FLAGS, cmos[_physical(CMOS.MISC_FLAGS)] | MISC_FLAGS_BOOT)
    if cmos_family(name) == 'riscos3':
        write(CMOS.CHECKSUM, 1 + sum(cmos[_physical(i)] for i in range(CMOS.CHECKSUM)))
    return bytes(cmos)

# --- Boot commands (frontend/worker/machine-setup.js) ---

# A BASIC program that clicks the last icon on the icon bar
CLICK_ICON_BASIC = 'DQAKDd4gYiUgMTAyNA0AFCnImSAiV2ltcF9Jbml0aWFsaXNlIiwzMTAsJjRiNTM0MTU0LCIiDQAeCiFiJT0tMg0AKB/ImSAiV2ltcF9HZXRXaW5kb3dJbmZvIiwsYiUNADIN3iBtc2clIDIwDQA8E2ljb25ubyU9YiUhODgtMQ0ARgxtc2clITg9NA0AUA5tc2clITEyPS0yDQBaE21zZyUhMTY9aWNvbm5vJQ0AZCvImSAiV2ltcF9TZW5kTWVzc2FnZSIsNixtc2clLC0yLGljb25ubyUN/w=='


def autoboot_script(meta, catalogue, hostfs):
    cmd = ''
    for dep in meta.get('depends', []):
        cmd += autoboot_script(catalogue[dep], catalogue, hostfs)
    if 'autoboot' in meta:
        cmd += meta['autoboot'] + '\n'
    if 'app-path' in meta:
        if 'archive' in meta:
            app = f"HostFS:$.{meta['app-path']}"
        elif 'disc' in meta:
            app = f"ADFS::0.$.{meta['app-path']}"
        else:
            return ''
        cmd += f"filer_run {app[:app.rindex('.')]}\nfiler_run {app}\n"
        if meta.get('click-icon'):
            put_file(hostfs / 'click_icon,ffb', base64.b64decode(CLICK_ICON_BASIC))
            cmd += 'filer_run HostFS:$.click_icon\n'
    return cmd

# --- Loading software (frontend/worker/hostfs.js) ---

DISC_EXTS = ('.adf', '.adl', '.fdi', '.apd', '.hfe')   # what Arculator's disc.c loads
RE_COMMA_EXT = re.compile(r',[0-9a-f]{3}$', re.I)
DOT_EXT_FILETYPES = {'.zip': 0xddc, '.arc': 0x3fb, '.txt': 0xfff, '.bas': 0xffb, '.jfd': 0xfce}


def is_disc_name(name):
    return name.lower().endswith(DISC_EXTS)


def put_file(path, data, mtime=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    path.write_bytes(data)
    if mtime:
        os.utime(path, (mtime, mtime))


def hostfs_name(ro_path, ro_meta):
    return as_ro_path(ro_path).as_zipname() + ro_meta.hostfs_file_ext()


def unpack_archive(archive, hostfs):
    """Unpack a riscos-conv archive (Spark, ArcFS) onto HostFS"""
    count = 0
    for path, meta in archive.list():
        with archive.open(path) as f:
            data = f.read()
        mtime = time.mktime(meta.timestamp.timetuple()) if meta.timestamp else None
        put_file(hostfs / hostfs_name(path, meta.ro_meta), data, mtime)
        count += 1
    return count


def unpack_zip(zf, hostfs):
    """Unpack a RISC OS zip, or a zip of name,xxx files, onto HostFS. Entries
    without RISC OS metadata keep their names (unpackRiscOsZipToHostfs)"""
    count = 0
    for info in zf.infolist():
        if info.is_dir():
            continue
        ro_meta = info.getRiscOsMeta()   # added to ZipInfo by riscos-conv
        if ro_meta:
            name = hostfs_name(PureRiscOsPath.from_zipname(info.filename.replace(':', '_')), ro_meta)
            ts = ro_meta.datestamp
            mtime = time.mktime(ts.timetuple()) if ts else None
        else:
            name, mtime = info.filename, None
        put_file(hostfs / name, zf.read(info), mtime)
        count += 1
    return count


def load_software(path, hostfs, disc_dir):
    """Load a file as loadSoftware does. Returns the disc image's path if it
    was one, else None"""
    name = path.name
    if is_disc_name(name):
        dst = disc_dir / name
        shutil.copyfile(path, dst)
        print(f'  disc image {name}')
        return dst
    with open(path, 'rb') as fd:
        if name.lower().endswith('zip'):
            zf = ZipFile(fd)
            discs = [i for i in zf.infolist() if is_disc_name(i.filename)]
            if discs:
                dst = disc_dir / Path(discs[0].filename).name
                dst.write_bytes(zf.read(discs[0]))
                print(f'  disc image {dst.name} from {name}'
                      + (f' (1 of {len(discs)})' if len(discs) > 1 else ''))
                return dst
            has_comma = any(RE_COMMA_EXT.search(i.filename) for i in zf.infolist())
            if has_comma or any(i.getRiscOsMeta() for i in zf.infolist()):
                print(f'  unpacked {unpack_zip(zf, hostfs)} files from {name}')
                return None
            sys.exit(f"{name} isn't a RISC OS zip")
        kind = identify_file(name, fd)
        fd.seek(0)
        if kind in (KnownFileType.SPARK_ARCHIVE, KnownFileType.ARCFS_ARCHIVE):
            archive = (SparkArchive if kind == KnownFileType.SPARK_ARCHIVE else ArcFSArchive)(fd)
            print(f'  unpacked {unpack_archive(archive, hostfs)} files from {name}')
            return None
    if RE_COMMA_EXT.search(name) or name.lower().endswith(tuple(DOT_EXT_FILETYPES)):
        dst = name
        for ext, ft in DOT_EXT_FILETYPES.items():
            if name.lower().endswith(ext):
                dst = f'{name[:-len(ext)]},{ft:03x}'
        put_file(hostfs / dst, path.read_bytes())
        print(f'  copied {name} to HostFS as {dst}')
        return None
    sys.exit(f"{name}: unknown file type")


class Software:
    """The catalogue and its files, from a local build/software or a URL"""

    def __init__(self, base, cache):
        self.base = base
        self.cache = cache
        self.catalogue = json.loads(self.fetch('software.json').read_bytes())

    def fetch(self, name):
        if not self.base.startswith(('http://', 'https://')):
            return Path(self.base) / name
        dst = self.cache / name
        if not dst.exists() or name == 'software.json':
            print(f'downloading {self.base}{name}')
            self.cache.mkdir(parents=True, exist_ok=True)
            with urllib.request.urlopen(self.base + name) as r:
                dst.write_bytes(r.read())
        return dst


def load_title(sw, title_id, hostfs, disc_dir):
    """loadFromSoftwareCatalogue: the title, then the titles it depends on"""
    meta = sw.catalogue[title_id]
    disc = None
    if 'archive' in meta:
        load_software(sw.fetch(meta['archive']), hostfs, disc_dir)
    elif 'disc' in meta:
        disc = load_software(sw.fetch(meta['disc']), hostfs, disc_dir)
    for dep in meta.get('depends', []):
        print(f'{title_id} depends on {dep}')
        load_title(sw, dep, hostfs, disc_dir)
    return disc


def empty_hostfs(hostfs):
    """Empty HostFS, as a fresh page load is, keeping upstream's arculfs.txt"""
    for p in hostfs.iterdir():
        if p.name == 'arculfs.txt':
            continue
        shutil.rmtree(p) if p.is_dir() and not p.is_symlink() else p.unlink()


def set_global_option(arc_cfg, key, value):
    """Set one line of arc.cfg (shared by every machine), keeping the rest"""
    lines = arc_cfg.read_text().splitlines() if arc_cfg.exists() else [
        'sound_enable = 1', 'first_fullscreen = 0', 'stereo = 1', 'sound_gain = 0',
        'sound_filter = 0', 'disc_noise_gain = 0']
    lines = [l for l in lines if l.split('=')[0].strip() != key] + [f'{key} = {value}']
    arc_cfg.write_text('\n'.join(lines) + '\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('id', nargs='?', help='software catalogue ID, e.g. lander')
    ap.add_argument('--arculator', type=Path, default=Path.home() / 'projects/arculator',
                    help='the Arculator directory, with arculator and roms/ in it (default %(default)s)')
    ap.add_argument('--software', default=str(REPO / 'build/software'),
                    help=f'catalogue directory or URL (default build/software; '
                         f'"live" for {LIVE_SOFTWARE_BASE})')
    ap.add_argument('--preset', choices=PRESETS, help="machine preset (default: the title's)")
    ap.add_argument('--keep-hostfs', action='store_true', help="don't empty HostFS first")
    ap.add_argument('--no-run', action='store_true', help="set up, but don't run Arculator")
    ap.add_argument('--list', action='store_true', help='list the catalogue')
    args = ap.parse_args()

    base = LIVE_SOFTWARE_BASE if args.software == 'live' else args.software
    arc = args.arculator.expanduser().resolve()
    sw = Software(base, arc / 'discs/arclive/cache')
    catalogue = sw.catalogue

    if args.list or not args.id:
        for k, v in sorted(catalogue.items()):
            boots = 'app-path' in v or 'autoboot' in v
            print(f"{k:24} {v.get('year', ''):5} {'' if boots else '(no boot) '}{v['title']}")
        return
    if args.id not in catalogue:
        sys.exit(f'{args.id} is not in the catalogue (try --list)')
    if not (arc / 'arculator').exists():
        sys.exit(f'{arc}/arculator not found: build Arculator or give --arculator')
    meta = catalogue[args.id]

    preset = args.preset or recommend_preset(meta)
    if not preset:
        sys.exit(f'no machine preset suits {args.id}: give --preset')
    c = {**DEFAULTS, **PRESETS[preset]}
    rom_dir = arc / 'roms' / c['rom_set']
    if not any(p.name != 'roms.txt' for p in rom_dir.glob('*')):
        sys.exit(f'no ROM in {rom_dir}')
    print(f"{meta['title']} ({args.id}) on {preset} ({c['rom_set']}, {c['mem_size']} KB)")

    hostfs = arc / 'hostfs'
    hostfs.mkdir(exist_ok=True)
    if not args.keep_hostfs:
        empty_hostfs(hostfs)
    disc_dir = arc / 'discs/arclive'
    disc_dir.mkdir(parents=True, exist_ok=True)
    disc = load_title(sw, args.id, hostfs, disc_dir)

    cmos = cmos_name(c)
    boot = autoboot_script(meta, catalogue, hostfs)
    boot_fs = 'hostfs'
    if not can_boot_from(cmos, 'hostfs'):
        print(f"warning: {c['rom_set']} can't boot from HostFS, so the boot commands won't run")
        boot_fs = None
    for p in hostfs.glob('*'):
        if p.name.lower().startswith('!boot,'):
            p.unlink()
    if boot:
        put_file(hostfs / '!Boot,fea', boot.encode('latin-1'))
        print('!Boot:\n  ' + boot.rstrip('\n').replace('\n', '\n  '))
    else:
        print(f"warning: {meta['title']} has no boot commands")

    config = f'arclive-{preset}'
    (arc / 'configs').mkdir(exist_ok=True)
    (arc / 'configs' / f'{config}.cfg').write_text(machine_config_file(c, disc or ''))
    (arc / 'cmos').mkdir(exist_ok=True)
    (arc / 'cmos' / f'{config}.{cmos}.cmos.bin').write_bytes(
        make_cmos(cmos, boot_fs, rom_year(c['rom_set'])))
    set_global_option(arc / 'arc.cfg', 'sound_filter', meta.get('sound-filter', 0))
    print(f'config {config}' + (f', disc {disc.name} in drive 0' if disc else ''))
    if 'ff-ms' in meta:
        print(f"it takes about {meta['ff-ms'] / 1000:g} s to boot (no fast-forward here)")
    if 'mouse-capture' in meta:
        print(f"mouse capture: {meta['mouse-capture']}")

    if args.no_run:
        print(f'run: cd {arc} && ./arculator {config}')
        return
    os.chdir(arc)
    os.execv('./arculator', ['./arculator', config])


if __name__ == '__main__':
    main()
