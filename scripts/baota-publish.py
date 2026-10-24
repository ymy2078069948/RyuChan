#!/usr/bin/env python3
"""Restricted Baota publisher. Installed root-owned at /usr/local/sbin/ryuchan-publish.

Two archive layouts are accepted:

* Legacy full bundle: every file of the built site. Files are copied over the
  live site; nothing is deleted. Used while the CI bundle cannot compare with
  the live site.
* Manifest bundle: a ``.ryuchan-manifest`` file at the archive root lists the
  SHA-256 of every file the built site should contain, and the archive only
  carries the files that changed. The live site is reconciled with the
  manifest (changed files overwritten, stale files removed), so deleted posts
  stop being served.
"""
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tarfile
import tempfile
from datetime import datetime, timezone

SITE = Path('/www/wwwroot/luokk.top')
INCOMING = Path('/home/ryuchan-deploy/incoming')
BACKUPS = Path('/root/ryuchan-deploy-backups')
STAGING_ROOT = Path('/root')
ARCHIVE_NAME = re.compile(r'ryuchan-[0-9]+-[0-9]+\.tar\.gz\Z')
MANIFEST_NAME = '.ryuchan-manifest'
MANIFEST_LINE = re.compile(r'([0-9a-f]{64})  (.*)\Z')
PROTECTED_NAMES = frozenset({'.user.ini', '.htaccess'})
PROTECTED_DIRS = frozenset({'.well-known'})
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 1024 * 1024 * 1024
MAX_MEMBERS = 50_000
MAX_MANIFEST_BYTES = 8 * 1024 * 1024


def die(message):
    raise SystemExit(message)


def safe_relative_path(name):
    while name.startswith('./'):
        name = name[2:]
    if name in ('', '.'):
        return None
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name:
        die(f'Unsafe archive path: {name!r}')
    return Path(*path.parts)


def is_protected(relative):
    if relative.name in PROTECTED_NAMES:
        return True
    return bool(relative.parts) and relative.parts[0] in PROTECTED_DIRS


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def parse_manifest(raw):
    manifest = {}
    for line in raw.decode('utf-8').splitlines():
        if not line.strip():
            continue
        match = MANIFEST_LINE.fullmatch(line.rstrip('\r'))
        if not match:
            die(f'Invalid manifest line: {line!r}')
        relative = safe_relative_path(match.group(2))
        if relative is None:
            die(f'Invalid manifest path: {line!r}')
        if relative in manifest:
            die(f'Duplicate manifest path: {relative}')
        manifest[relative] = match.group(1)
    if Path('index.html') not in manifest or Path('config/index.html') not in manifest:
        die('Manifest missing index.html or config/index.html')
    if len(manifest) > MAX_MEMBERS:
        die('Too many manifest entries')
    return manifest


def validate_archive(archive, expected_hash):
    if os.geteuid() != 0:
        die('Publisher must be run through sudo')
    if not re.fullmatch(r'[0-9a-f]{64}', expected_hash):
        die('Invalid SHA-256')
    if not SITE.is_dir() or SITE.is_symlink() or not (SITE / 'index.html').is_file():
        die('Site root missing or invalid')
    if archive.parent != INCOMING or not ARCHIVE_NAME.fullmatch(archive.name):
        die('Archive must be in the restricted incoming directory')
    if archive.is_symlink() or not archive.is_file():
        die('Archive is not a regular file')
    import pwd
    archive_stat = archive.stat()
    if not stat.S_ISREG(archive_stat.st_mode) or archive_stat.st_uid != pwd.getpwnam('ryuchan-deploy').pw_uid:
        die('Archive owner or file type is invalid')
    if archive_stat.st_size < 1 or archive_stat.st_size > MAX_ARCHIVE_BYTES:
        die('Archive size is invalid')
    if digest(archive) != expected_hash:
        die('Archive SHA-256 mismatch')


def extract_archive(archive, staging):
    manifest = None
    staged = {}
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        if len(members) > MAX_MEMBERS:
            die('Too many archive members')
        total_bytes = 0
        for member in members:
            relative = safe_relative_path(member.name)
            if relative is None:
                continue
            if relative == Path(MANIFEST_NAME):
                if not member.isfile():
                    die('Manifest must be a regular file')
                if manifest is not None:
                    die('Duplicate manifest')
                if member.size > MAX_MANIFEST_BYTES:
                    die('Manifest size is invalid')
                with source.extractfile(member) as stream:
                    manifest = parse_manifest(stream.read())
                continue
            if not member.isfile() and not member.isdir():
                die(f'Unsupported archive entry: {member.name}')
            if is_protected(relative):
                continue  # Panel/protected files are never overwritten from a bundle.
            if member.isdir():
                continue
            total_bytes += member.size
            if member.size > MAX_FILE_BYTES or total_bytes > MAX_TOTAL_BYTES:
                die('Archive uncompressed size limit exceeded')
            output = staging / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as src, output.open('wb') as target:
                shutil.copyfileobj(src, target)
            staged[relative] = output

    if manifest is None:
        if not (staging / 'index.html').is_file() or not (staging / 'config/index.html').is_file():
            die('Archive missing index.html or config/index.html')
        return None, staged

    for relative, output in staged.items():
        if relative not in manifest:
            die(f'Archive contains file missing from manifest: {relative}')
        if digest(output) != manifest[relative]:
            die(f'Manifest hash mismatch: {relative}')
    return manifest, staged


def copy_into_site(staging, staged):
    for relative in sorted(staged):
        source = staged[relative]
        target = SITE / relative
        current = SITE
        for part in relative.parts[:-1]:
            current = current / part
            if current.is_symlink():
                die(f'Live site has a symlink directory: {current}')
        if target.is_symlink():
            die(f'Live site has a symlink file: {target}')
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmpname = tempfile.mkstemp(prefix='.ryuchan-publish-', dir=target.parent)
        try:
            with os.fdopen(fd, 'wb') as stream, source.open('rb') as src:
                shutil.copyfileobj(src, stream)
            os.chmod(tmpname, 0o644)
            os.replace(tmpname, target)
        finally:
            if os.path.exists(tmpname):
                os.unlink(tmpname)
        if digest(target) != digest(source):
            die(f'Published file verification failed: {relative}')


def prune_site(manifest):
    removed = 0
    for dirpath, dirnames, filenames in os.walk(SITE, followlinks=False):
        directory = Path(dirpath)
        dirnames[:] = [name for name in dirnames if not (directory / name).is_symlink()]
        for filename in filenames:
            target = directory / filename
            if target.is_symlink():
                continue
            relative = target.relative_to(SITE)
            if relative in manifest or is_protected(relative):
                continue
            target.unlink()
            removed += 1
    # Remove directories left empty by the prune so removed pages return 404, not 403.
    for dirpath, dirnames, filenames in os.walk(SITE, topdown=False, followlinks=False):
        directory = Path(dirpath)
        if directory == SITE or directory.is_symlink():
            continue
        relative = directory.relative_to(SITE)
        if is_protected(relative):
            continue
        try:
            directory.rmdir()
        except OSError:
            pass
    return removed


def verify_site(manifest):
    for relative, expected in manifest.items():
        target = SITE / relative
        if not target.is_file() or target.is_symlink():
            die(f'Published file missing: {relative}')
        if digest(target) != expected:
            die(f'Published file verification failed: {relative}')


def publish(archive, expected_hash):
    validate_archive(archive, expected_hash)

    with tempfile.TemporaryDirectory(prefix='ryuchan-publish-', dir=STAGING_ROOT) as staging_dir:
        staging = Path(staging_dir)
        manifest, staged = extract_archive(archive, staging)

        BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(BACKUPS, 0o700)
        label = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup = BACKUPS / f'luokk.top-{label}-{os.getpid()}.tar.gz'
        with tarfile.open(backup, 'w:gz') as out:
            out.add(SITE, arcname='luokk.top')
        with tarfile.open(backup, 'r:gz') as check:
            check.getmembers()  # Read through the backup before touching the live site.
        print(f'Full live-site backup created: {backup}', flush=True)

        copy_into_site(staging, staged)
        removed = 0
        if manifest is not None:
            removed = prune_site(manifest)
            verify_site(manifest)
        print(f'Published {len(staged)} files ({removed} removed); backup: {backup}')
    archive.unlink()


if __name__ == '__main__':
    if len(sys.argv) != 3:
        die('Usage: ryuchan-publish /home/ryuchan-deploy/incoming/ryuchan-ID-ATTEMPT.tar.gz SHA256')
    publish(Path(sys.argv[1]), sys.argv[2])
