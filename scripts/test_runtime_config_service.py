import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('runtime_config_service', Path(__file__).with_name('runtime_config_service.py'))
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class RuntimeServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        service.DATA_DIR = Path(self.temp.name)
        service.SITE_SHA = Path(self.temp.name) / 'site-sha'
        service.ADMIN_TOKEN = 'test-secret-' + 'x' * 40
        service.ORIGIN = 'https://luokk.top'

    def request(self, method, path, payload=None, token=None, origin='https://luokk.top'):
        data = json.dumps(payload).encode() if payload is not None else b''
        env = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'wsgi.input': io.BytesIO(data),
               'CONTENT_LENGTH': str(len(data)), 'CONTENT_TYPE': 'application/json',
               'HTTP_ORIGIN': origin, 'HTTP_X_RUNTIME_TOKEN': token or ''}
        response = {}
        def start(code, headers):
            response.update(code=code, headers=dict(headers))
        chunks = service.application(env, start)
        response['body'] = b''.join(chunks)
        return response

    def payload(self, image=False):
        avatar = '/profile.png'
        images = {}
        if image:
            data = b'\xff\xd8\xff' + b'0123456789' * 10
            avatar = '/profile-' + hashlib.sha256(data).hexdigest()[:16] + '.jpg'
            images['user.avatar'] = base64.b64encode(data).decode()
        return {'commit': 'a' * 40, 'config': {
            'site': {'tab': 'Luokk', 'title': 'Luokk', 'description': 'Site', 'title_type': 'text', 'favicon': '/favicon.ico'},
            'user': {'name': 'Alice', 'description': 'Hello', 'avatar': avatar, 'site': 'https://luokk.top',
                     'title_image': '/logo.png', 'qr_wechat': '/WeChat.jpg', 'qr_alipay': '/Alipay.jpg'}}, 'images': images}

    def test_public_config_and_authorized_publish(self):
        self.assertEqual(json.loads(self.request('GET', '/__runtime/config')['body'])['config'], None)
        self.assertEqual(self.request('POST', '/__runtime/publish', self.payload())['code'], '403 Forbidden')
        self.assertEqual(self.request('POST', '/__runtime/publish', self.payload(), service.ADMIN_TOKEN,
                                      'https://evil.example')['code'], '403 Forbidden')
        posted = self.request('POST', '/__runtime/publish', self.payload(True), service.ADMIN_TOKEN)
        self.assertEqual(posted['code'], '200 OK')
        live = json.loads(self.request('GET', '/__runtime/config')['body'])
        self.assertEqual(live['config']['user']['name'], 'Alice')
        self.assertTrue(live['config']['user']['avatar'].startswith('/__runtime/media/profile-'))
        media = self.request('GET', live['config']['user']['avatar'])
        self.assertEqual(media['code'], '200 OK')
        self.assertEqual(media['headers']['Content-Type'], 'image/jpeg')
        self.assertEqual(media['headers']['Cache-Control'], 'no-store')

    def test_new_build_supersedes_stale_overlay(self):
        service.SITE_SHA.write_text('b' * 40)
        self.assertEqual(self.request('POST', '/__runtime/publish', self.payload(), service.ADMIN_TOKEN)['code'], '200 OK')
        self.assertEqual(json.loads(self.request('GET', '/__runtime/config')['body'])['config']['user']['name'], 'Alice')
        service.SITE_SHA.write_text('a' * 40)
        self.assertIsNone(json.loads(self.request('GET', '/__runtime/config')['body'])['config'])

    def test_other_saves_preserve_uploaded_media_url_until_build(self):
        self.assertEqual(self.request('POST', '/__runtime/publish', self.payload(True), service.ADMIN_TOKEN)['code'], '200 OK')
        next_save = self.payload(True)
        next_save['images'] = {}
        self.assertEqual(self.request('POST', '/__runtime/publish', next_save, service.ADMIN_TOKEN)['code'], '200 OK')
        self.assertTrue(json.loads(self.request('GET', '/__runtime/config')['body'])['config']['user']['avatar'].startswith('/__runtime/media/'))

    def test_bad_image_cannot_change_live_config(self):
        ok = self.request('POST', '/__runtime/publish', self.payload(), service.ADMIN_TOKEN)
        self.assertEqual(ok['code'], '200 OK')
        forged = self.payload(True)
        forged['images']['user.avatar'] = base64.b64encode(b'not a jpeg').decode()
        self.assertEqual(self.request('POST', '/__runtime/publish', forged, service.ADMIN_TOKEN)['code'], '400 Bad Request')
        self.assertEqual(json.loads(self.request('GET', '/__runtime/config')['body'])['config']['user']['avatar'], '/profile.png')
        self.assertEqual(self.request('GET', '/__runtime/media/../config.json')['code'], '404 Not Found')

    def test_untrusted_markup_and_javascript_urls_rejected(self):
        payload = self.payload()
        payload['config']['user']['avatar'] = 'javascript:alert(1)'
        self.assertEqual(self.request('POST', '/__runtime/publish', payload, service.ADMIN_TOKEN)['code'], '400 Bad Request')
        payload['config']['user']['avatar'] = '/profile.png'
        payload['config']['site']['title_type'] = '<script>'
        self.assertEqual(self.request('POST', '/__runtime/publish', payload, service.ADMIN_TOKEN)['code'], '400 Bad Request')


if __name__ == '__main__':
    unittest.main()
