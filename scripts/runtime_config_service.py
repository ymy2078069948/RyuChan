#!/usr/bin/env python3
"""Same-origin runtime overlay for the static site. Serve behind nginx + gunicorn.

No GitHub credentials are stored here. A separate random admin token is required to
publish; public GETs expose only the whitelisted site/profile fields.
"""
import base64
import binascii
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit

DATA_DIR = Path(os.environ.get('RYUCHAN_RUNTIME_DIR', '/var/lib/ryuchan-runtime'))
ADMIN_TOKEN = os.environ.get('RYUCHAN_RUNTIME_TOKEN', '')
ORIGIN = os.environ.get('RYUCHAN_RUNTIME_ORIGIN', 'https://luokk.top')
SITE_SHA = Path(os.environ.get('RYUCHAN_RUNTIME_SITE_SHA', '/www/wwwroot/luokk.top/.ryuchan-content-sha'))
MAX_BODY = 12 * 1024 * 1024
MAX_IMAGE = 5 * 1024 * 1024
BRAND = {'site.favicon': 'favicon', 'user.avatar': 'profile',
         'user.title_image': 'logo', 'user.qr_wechat': 'WeChat', 'user.qr_alipay': 'Alipay'}
MIMES = {'png': 'image/png', 'jpg': 'image/jpeg', 'webp': 'image/webp',
         'gif': 'image/gif', 'ico': 'image/x-icon'}
IMAGE_NAME = re.compile(r'^(favicon|profile|logo|WeChat|Alipay)-[a-f0-9]{16}\.(png|jpg|webp|gif|ico)$')


def respond(start_response, code, payload, content_type='application/json; charset=utf-8'):
    data = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode('utf-8')
    start_response(code, [('Content-Type', content_type), ('Content-Length', str(len(data))),
                          ('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff')])
    return [data]


def safe_image(data, ext):
    return ((ext == 'png' and data.startswith(b'\x89PNG\r\n\x1a\n')) or
            (ext == 'jpg' and data.startswith(b'\xff\xd8\xff')) or
            (ext == 'gif' and data[:6] in (b'GIF87a', b'GIF89a')) or
            (ext == 'webp' and data[:4] == b'RIFF' and data[8:12] == b'WEBP') or
            (ext == 'ico' and data.startswith(b'\x00\x00\x01\x00')))


def image_url(value):
    if not isinstance(value, str) or len(value) > 1024 or any(ord(ch) < 32 or ch == '\\' for ch in value):
        raise ValueError('Invalid image URL')
    if value and not (value.startswith('/') and not value.startswith('//')):
        parsed = urlsplit(value)
        if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password:
            raise ValueError('Only same-origin paths or HTTPS image URLs are allowed')
    return value


def clean_config(config):
    if not isinstance(config, dict):
        raise ValueError('Invalid config')
    site = config.get('site', {})
    user = config.get('user', {})
    if not isinstance(site, dict) or not isinstance(user, dict):
        raise ValueError('Invalid site/user')
    result = {'site': {}, 'user': {}}
    for key in ('tab', 'title', 'description', 'title_type'):
        value = site.get(key, '')
        if not isinstance(value, str) or len(value) > 500:
            raise ValueError('Invalid site field')
        result['site'][key] = value
    if result['site']['title_type'] not in ('text', 'image', ''):
        raise ValueError('Invalid title type')
    for key in ('favicon',):
        result['site'][key] = image_url(site.get(key, ''))
    for key in ('name', 'description'):
        value = user.get(key, '')
        if not isinstance(value, str) or len(value) > 500:
            raise ValueError('Invalid user field')
        result['user'][key] = value
    value = user.get('site', '')
    result['user']['site'] = image_url(value)
    for key in ('avatar', 'title_image', 'qr_wechat', 'qr_alipay'):
        result['user'][key] = image_url(user.get(key, ''))
    return result


def write_atomic(path, data):
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.ryuchan-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, 0o640)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def deployed_sha():
    try:
        value = SITE_SHA.read_text(encoding='ascii').strip()
        return value if re.fullmatch(r'[a-f0-9]{40}', value) else ''
    except OSError:
        return ''


def application(environ, start_response):
    method = environ.get('REQUEST_METHOD')
    path = environ.get('PATH_INFO', '')
    if method == 'GET' and path == '/__runtime/config':
        config_file = DATA_DIR / 'config.json'
        if config_file.is_file():
            published = json.loads(config_file.read_bytes())
            current = deployed_sha()
            # A newer static build supersedes this overlay; stale runtime fields
            # must never hide changes made directly in the content repository.
            if not current or current == published.get('deployed_at'):
                return respond(start_response, '200 OK', published)
        return respond(start_response, '200 OK', {'version': 1, 'config': None})
    if method == 'GET' and path.startswith('/__runtime/media/'):
        filename = path[len('/__runtime/media/'):]
        if not IMAGE_NAME.fullmatch(filename):
            return respond(start_response, '404 Not Found', {'error': 'Not found'})
        file = DATA_DIR / 'media' / filename
        if not file.is_file():
            return respond(start_response, '404 Not Found', {'error': 'Not found'})
        if file.stat().st_size > MAX_IMAGE:
            return respond(start_response, '404 Not Found', {'error': 'Not found'})
        return respond(start_response, '200 OK', file.read_bytes(), MIMES[filename.rsplit('.', 1)[1]])
    if method != 'POST' or path != '/__runtime/publish':
        return respond(start_response, '404 Not Found', {'error': 'Not found'})
    token = environ.get('HTTP_X_RUNTIME_TOKEN', '')
    if not ADMIN_TOKEN or len(ADMIN_TOKEN) < 32 or not hmac.compare_digest(token, ADMIN_TOKEN):
        return respond(start_response, '403 Forbidden', {'error': 'Forbidden'})
    if environ.get('HTTP_ORIGIN') != ORIGIN or environ.get('CONTENT_TYPE', '').split(';')[0] != 'application/json':
        return respond(start_response, '403 Forbidden', {'error': 'Origin or type rejected'})
    try:
        length = int(environ.get('CONTENT_LENGTH', '0'))
        if length < 1 or length > MAX_BODY:
            raise ValueError('Request too large')
        payload = json.loads(environ['wsgi.input'].read(length))
        commit = payload.get('commit', '')
        if not isinstance(commit, str) or not re.fullmatch(r'[a-f0-9]{40}', commit):
            raise ValueError('Invalid commit')
        config = clean_config(payload.get('config'))
        images = payload.get('images', {})
        if not isinstance(images, dict) or len(images) > len(BRAND):
            raise ValueError('Invalid images')
        staged = []
        for target, encoded in images.items():
            if target not in BRAND or not isinstance(encoded, str):
                raise ValueError('Invalid image target')
            expected = config[target.split('.')[0]][target.split('.')[1]]
            filename = expected.lstrip('/')
            match = IMAGE_NAME.fullmatch(filename)
            if not match or match[1] != BRAND[target] or (match[2] == 'ico' and target != 'site.favicon'):
                raise ValueError('Image filename does not match config')
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ValueError('Invalid base64 image') from exc
            if len(raw) < 12 or len(raw) > MAX_IMAGE or not safe_image(raw, match[2]):
                raise ValueError('Invalid image bytes')
            if hashlib.sha256(raw).hexdigest()[:16] != filename.split('-', 1)[1].split('.')[0]:
                raise ValueError('Image hash mismatch')
            staged.append((filename, raw, target))
        for filename, raw, target in staged:
            write_atomic(DATA_DIR / 'media' / filename, raw)
            config[target.split('.')[0]][target.split('.')[1]] = '/__runtime/media/' + filename
        for target in BRAND:
            section, key = target.split('.')
            image = config[section][key]
            filename = image.lstrip('/')
            if (IMAGE_NAME.fullmatch(filename) and (DATA_DIR / 'media' / filename).is_file()):
                config[section][key] = '/__runtime/media/' + filename
        document = {'version': 1, 'commit': commit, 'deployed_at': deployed_sha(), 'config': config}
        write_atomic(DATA_DIR / 'config.json', json.dumps(document, ensure_ascii=False).encode('utf-8'))
        return respond(start_response, '200 OK', {'ok': True, 'commit': commit})
    except (ValueError, TypeError, UnicodeError, json.JSONDecodeError) as error:
        return respond(start_response, '400 Bad Request', {'error': str(error)})
