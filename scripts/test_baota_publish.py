"""Offline regression tests for the Baota publisher (no real server or GitHub access)."""
import hashlib
import importlib.util
import io
from pathlib import Path
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name('baota-publish.py')
spec = importlib.util.spec_from_file_location('baota_publish', MODULE_PATH)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        publisher.SITE = root / 'site'
        publisher.INCOMING = root / 'incoming'
        publisher.BACKUPS = root / 'backups'
        publisher.STAGING_ROOT = root
        publisher.SITE.mkdir()
        publisher.INCOMING.mkdir()
        (publisher.SITE / 'index.html').write_bytes(b'old index')
        (publisher.SITE / 'config').mkdir()
        (publisher.SITE / 'config/index.html').write_bytes(b'old config')
        (publisher.SITE / '.user.ini').write_bytes(b'protected')
        (publisher.SITE / '.htaccess').write_bytes(b'panel')
        (publisher.SITE / '.well-known').mkdir()
        (publisher.SITE / '.well-known/acme').write_bytes(b'challenge')
        (publisher.SITE / 'blog').mkdir()
        (publisher.SITE / 'blog/removed-post.html').write_bytes(b'stale')
        self.archive = publisher.INCOMING / 'ryuchan-12345-1.tar.gz'

    def make_archive(self, entries):
        with tarfile.open(self.archive, 'w:gz') as out:
            for name, data in entries.items():
                item = tarfile.TarInfo(name)
                item.size = len(data)
                out.addfile(item, io.BytesIO(data))
        return hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def publish(self, digest):
        fake_pwd = SimpleNamespace(getpwnam=lambda _: SimpleNamespace(pw_uid=self.archive.stat().st_uid))
        with patch.object(publisher.os, 'geteuid', return_value=0, create=True), patch.dict(sys.modules, {'pwd': fake_pwd}):
            publisher.publish(self.archive, digest)

    def manifest(self, files):
        lines = [f'{sha(data)}  ./{name}' for name, data in files.items()]
        return ('\n'.join(lines) + '\n').encode()

    def site_manifest(self):
        files = {}
        for path in publisher.SITE.rglob('*'):
            if path.is_file() and not path.is_symlink():
                files[str(path.relative_to(publisher.SITE))] = path.read_bytes()
        return files

    def test_legacy_bundle_copies_files_and_preserves_panel_files(self):
        checksum = self.make_archive({
            './index.html': b'new index',
            './config/index.html': b'new config',
            './_astro/main.js': b'new js',
            './.user.ini': b'overwrite attempt',
        })
        self.publish(checksum)
        self.assertEqual((publisher.SITE / '.user.ini').read_bytes(), b'protected')
        self.assertEqual((publisher.SITE / 'config/index.html').read_bytes(), b'new config')
        self.assertEqual((publisher.SITE / '_astro/main.js').read_bytes(), b'new js')
        # Legacy bundles never delete: the previously published stale page stays.
        self.assertTrue((publisher.SITE / 'blog/removed-post.html').exists())
        self.assertEqual(len(list(publisher.BACKUPS.glob('*.tar.gz'))), 1)
        self.assertFalse(self.archive.exists())

    def test_manifest_bundle_reconciles_site_and_removes_stale_files(self):
        files = {
            'index.html': b'new index',
            'config/index.html': b'new config',
            '_astro/main.js': b'new js',
            '.ryuchan-content-sha': b'abcdef0123456789',
        }
        entries = {f'./{name}': data for name, data in files.items()}
        entries['./.ryuchan-manifest'] = self.manifest(files)
        checksum = self.make_archive(entries)
        self.publish(checksum)
        self.assertEqual((publisher.SITE / '.user.ini').read_bytes(), b'protected')
        self.assertEqual((publisher.SITE / '.htaccess').read_bytes(), b'panel')
        self.assertEqual((publisher.SITE / '.well-known/acme').read_bytes(), b'challenge')
        self.assertEqual((publisher.SITE / 'index.html').read_bytes(), b'new index')
        self.assertEqual((publisher.SITE / '.ryuchan-content-sha').read_bytes(), b'abcdef0123456789')
        self.assertFalse((publisher.SITE / 'blog/removed-post.html').exists())
        self.assertFalse((publisher.SITE / '.ryuchan-manifest').exists())
        self.assertEqual(len(list(publisher.BACKUPS.glob('*.tar.gz'))), 1)
        self.assertFalse(self.archive.exists())

    def test_manifest_bundle_can_carry_only_changed_files(self):
        files = {'index.html': b'new index', 'config/index.html': b'old config'}
        # The live site already has the manifest values for unchanged files.
        (publisher.SITE / 'index.html').write_bytes(b'new index')
        entries = {'./index.html': b'new index', './.ryuchan-manifest': self.manifest(files)}
        checksum = self.make_archive(entries)
        self.publish(checksum)
        self.assertEqual((publisher.SITE / 'index.html').read_bytes(), b'new index')

    def test_rejects_file_missing_from_manifest_before_live_backup(self):
        files = {'index.html': b'new', 'config/index.html': b'old config'}
        checksum = self.make_archive({
            './index.html': b'new',
            './extra.js': b'not in manifest',
            './.ryuchan-manifest': self.manifest(files),
        })
        with self.assertRaises(SystemExit):
            self.publish(checksum)
        self.assertEqual((publisher.SITE / 'index.html').read_bytes(), b'old index')
        self.assertFalse(publisher.BACKUPS.exists())

    def test_rejects_manifest_hash_mismatch_before_live_backup(self):
        checksum = self.make_archive({
            './index.html': b'tampered',
            './.ryuchan-manifest': self.manifest({'index.html': b'expected', 'config/index.html': b'old config'}),
        })
        with self.assertRaises(SystemExit):
            self.publish(checksum)
        self.assertFalse(publisher.BACKUPS.exists())

    def test_rejects_manifest_without_index(self):
        checksum = self.make_archive({
            './.ryuchan-manifest': self.manifest({'config/index.html': b'old config'}),
        })
        with self.assertRaises(SystemExit):
            self.publish(checksum)
        self.assertFalse(publisher.BACKUPS.exists())

    def test_rejects_path_traversal_before_live_backup(self):
        checksum = self.make_archive({'../escaped': b'bad', './index.html': b'new', './config/index.html': b'new'})
        with self.assertRaises(SystemExit):
            self.publish(checksum)
        self.assertEqual((publisher.SITE / 'index.html').read_bytes(), b'old index')
        self.assertFalse(publisher.BACKUPS.exists())

    def test_rejects_symlink_before_live_backup(self):
        with tarfile.open(self.archive, 'w:gz') as out:
            item = tarfile.TarInfo('./index.html')
            item.size = 3
            out.addfile(item, io.BytesIO(b'new'))
            item = tarfile.TarInfo('./config/index.html')
            item.size = 3
            out.addfile(item, io.BytesIO(b'new'))
            item = tarfile.TarInfo('./escape')
            item.type = tarfile.SYMTYPE
            item.linkname = '/etc/passwd'
            out.addfile(item)
        with self.assertRaises(SystemExit):
            self.publish(hashlib.sha256(self.archive.read_bytes()).hexdigest())
        self.assertEqual((publisher.SITE / 'index.html').read_bytes(), b'old index')
        self.assertFalse(publisher.BACKUPS.exists())

    def test_manifest_rejects_path_traversal(self):
        checksum = self.make_archive({
            './.ryuchan-manifest': (b'0' * 64) + b'  ../escaped\n',
        })
        with self.assertRaises(SystemExit):
            self.publish(checksum)
        self.assertFalse(publisher.BACKUPS.exists())

    def test_rejects_mismatched_archive_hash_before_live_backup(self):
        self.make_archive({'./index.html': b'new', './config/index.html': b'new'})
        with self.assertRaises(SystemExit):
            self.publish('0' * 64)
        self.assertEqual((publisher.SITE / 'index.html').read_bytes(), b'old index')
        self.assertFalse(publisher.BACKUPS.exists())


if __name__ == '__main__':
    unittest.main()
