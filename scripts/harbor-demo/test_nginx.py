import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('harbor_nginx', Path(__file__).with_name('nginx.py'))
nginx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nginx)

class NginxOverrideTests(unittest.TestCase):
    def test_idempotent_generation_and_edge(self):
        generated = """http { server {
        root /usr/share/truenas/webui;
        location /websocket { proxy_pass http://127.0.0.1:6000; }
        location /api/harbor-beacon { proxy_pass http://127.0.0.1:4174; }
        } }"""
        patched = nginx.render(generated, Path('/var/lib/demo/current'), 4176)
        self.assertIn('root /var/lib/demo/current;', patched)
        self.assertIn('proxy_pass http://127.0.0.1:4176;', patched)
        self.assertIn('client_max_body_size 32m;', patched)
        self.assertEqual(patched, nginx.render(patched, Path('/var/lib/demo/current'), 4176))
        self.assertEqual(1, patched.count('location /api/harbor-llama/'))

    def test_unrecognized_config_fails_before_write(self):
        with self.assertRaises(ValueError):
            nginx.render('http { }', Path('/var/lib/demo/current'), 4176)

if __name__ == '__main__':
    unittest.main()
