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
        (publisher.SITE / '.user.ini').write_bytes(b'protected')
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

    def test_publishes_html_and_preserves_panel_file(self):
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
        self.assertEqual(len(list(publisher.BACKUPS.glob('*.tar.gz'))), 1)
        self.assertFalse(self.archive.exists())

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

    def test_rejects_mismatched_hash_before_live_backup(self):
        self.make_archive({'./index.html': b'new', './config/index.html': b'new'})
        with self.assertRaises(SystemExit):
            self.publish('0' * 64)
        self.assertEqual((publisher.SITE / 'index.html').read_bytes(), b'old index')
        self.assertFalse(publisher.BACKUPS.exists())


if __name__ == '__main__':
    unittest.main()
