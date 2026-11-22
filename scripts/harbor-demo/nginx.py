#!/usr/bin/env python3
"""Apply the HarborOS static/edge override after middleware regenerates nginx."""
import argparse
from pathlib import Path
import re
import subprocess
import tempfile


def render(text, dist, edge_port):
    text = text.replace('/usr/share/truenas/webui', dist.as_posix())
    pattern = r'(location /api/harbor-beacon/?\s*\{)([^{}]*)(\})'
    def edge(match):
        body, count = re.subn(r'proxy_pass\s+http://127\.0\.0\.1:\d+;','proxy_pass http://127.0.0.1:%d;' % edge_port,match[2])
        if count != 1:
            raise ValueError('Expected one HarborBeacon proxy_pass in each location')
        if 'client_max_body_size' not in body:
            body += '            client_max_body_size 32m;\n            proxy_read_timeout 180s;\n        '
        return match[1] + body + match[3]
    text, count = re.subn(pattern, edge, text)
    if not count:
        raise ValueError('HarborBeacon nginx location is missing')
    if 'location /api/harbor-llama/' not in text:
        marker = '        location /websocket {'
        if marker not in text:
            raise ValueError('nginx websocket location is missing')
        block = ('        location /api/harbor-llama/ {\n'
                 '            proxy_pass http://127.0.0.1:11435/;\n'
                 '            proxy_http_version 1.1;\n'
                 '            proxy_read_timeout 180s;\n'
                 '        }\n\n')
        text = text.replace(marker, block + marker)
    return text


def apply(config, dist, edge_port, reload_service=True):
    original = config.read_text()
    updated = render(original, dist, edge_port)
    if updated == original:
        return False
    # Validate the complete candidate before replacing the live generated file.
    with tempfile.NamedTemporaryFile(mode='w', suffix='.conf', dir=config.parent) as candidate:
        candidate.write(updated)
        candidate.flush()
        subprocess.run(['nginx','-t','-c',candidate.name], check=True, capture_output=True)
    staged = config.with_name(config.name + '.harbor-next')
    staged.write_text(updated)
    staged.chmod(config.stat().st_mode & 0o777)
    staged.replace(config)
    if reload_service:
        subprocess.run(['systemctl','reload','nginx'], check=True)
    return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('/etc/nginx/nginx.conf'))
    parser.add_argument('--dist', type=Path, default=Path('/var/lib/harborbeacon-agent-ci/harbor-assistant-webui'))
    parser.add_argument('--edge-port', type=int, default=4176)
    parser.add_argument('--no-reload', action='store_true')
    args = parser.parse_args()
    apply(args.config, args.dist, args.edge_port, not args.no_reload)
