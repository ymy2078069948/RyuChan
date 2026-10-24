#!/usr/bin/env python3
"""Restricted Baota publisher. Installed root-owned at /usr/local/sbin/ryuchan-publish."""

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
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 1024 * 1024 * 1024
MAX_MEMBERS = 50_000


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


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def publish(archive, expected_hash):
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

    with tempfile.TemporaryDirectory(prefix='ryuchan-publish-', dir=STAGING_ROOT) as staging_dir:
        staging = Path(staging_dir)
        with tarfile.open(archive, 'r:gz') as src:
            members = src.getmembers()
            if len(members) > MAX_MEMBERS:
                die('Too many archive members')
            total_bytes = 0
            for member in members:
                relative = safe_relative_path(member.name)
                if relative is None:
                    continue
                if not member.isfile() and not member.isdir():
                    die(f'Unsupported archive entry: {member.name}')
                if relative.name == '.user.ini':
                    continue  # Panel-protected file: preserve the live copy.
                if member.isdir():
                    continue
                total_bytes += member.size
                if member.size > MAX_FILE_BYTES or total_bytes > MAX_TOTAL_BYTES:
                    die('Archive uncompressed size limit exceeded')
                output = staging / relative
                output.parent.mkdir(parents=True, exist_ok=True)
                with src.extractfile(member) as source, output.open('wb') as target:
                    shutil.copyfileobj(source, target)
        if not (staging / 'index.html').is_file() or not (staging / 'config/index.html').is_file():
            die('Archive missing index.html or config/index.html')

        BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(BACKUPS, 0o700)
        label = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup = BACKUPS / f'luokk.top-{label}-{os.getpid()}.tar.gz'
        with tarfile.open(backup, 'w:gz') as out:
            out.add(SITE, arcname='luokk.top')
        with tarfile.open(backup, 'r:gz') as check:
            check.getmembers()  # Read through the backup before touching the live site.
        print(f'Full live-site backup created: {backup}', flush=True)

        # Copy assets first and HTML last, without deleting legacy files or the protected .user.ini.
        files = sorted((p for p in staging.rglob('*') if p.is_file()),
                       key=lambda p: (p.suffix.lower() == '.html', str(p)))
        for source in files:
            relative = source.relative_to(staging)
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
        print(f'Published {len(files)} files; backup: {backup}; index SHA-256: {digest(SITE / "index.html")}')
    archive.unlink()


if __name__ == '__main__':
    if len(sys.argv) != 3:
        die('Usage: ryuchan-publish /home/ryuchan-deploy/incoming/ryuchan-ID-ATTEMPT.tar.gz SHA256')
    publish(Path(sys.argv[1]), sys.argv[2])
