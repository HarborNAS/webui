"""Installer lifecycle tests: every absolute appliance path is remapped to a temp root."""
import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


deploy = module('harbor_deploy', 'deploy.py')
adoption = module('harbor_adopt', 'adopt_packaged_webui.py')


class IsolatedAppliance(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.base = self.root / 'var/lib/harborbeacon-agent-ci'
        self.dist = self.base / 'harbor-assistant-webui'
        self.base.mkdir(parents=True)
        # Unknown absolute paths are sandboxed as well: production paths are never opened.
        def appliance_path(value):
            path = Path(value)
            if path.is_relative_to(self.root):
                return path
            raw = str(value).replace('\\', '/')
            if raw.startswith('/'):
                return self.root / raw.lstrip('/')
            if path.is_absolute():
                return self.root / 'external' / path.relative_to(path.anchor)
            return path
        self.path = appliance_path
        self.configs = [self.path(path) for path in deploy.CONFIGS]
        for name, value in [('Path', appliance_path), ('BASE', self.base),
                            ('DIST', self.dist), ('CONFIGS', self.configs)]:
            replacement = patch.object(deploy, name, value)
            replacement.start()
            self.addCleanup(replacement.stop)

    def write(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return path


class ServiceInventoryTests(unittest.TestCase):
    def test_health_reports_failed_grounded_runtime_without_changing_services(self):
        def status(*args, **kwargs):
            grounded = args[-1] == 'harbor-demo-rag-llama'
            value = ('failed' if args[1] == 'is-active' else 'disabled') if grounded else 'active'
            return subprocess.CompletedProcess(args, int(grounded), stdout=value + '\n', stderr='')
        with patch.object(deploy, 'run', side_effect=status) as commands:
            states = deploy.service_states()
        self.assertEqual(states['harbor-demo-rag-llama'], {'active':'failed', 'enabled':'disabled'})
        self.assertTrue(all(call.args[:2] in [('systemctl','is-active'), ('systemctl','is-enabled')]
                            for call in commands.call_args_list))


class CredentialTests(IsolatedAppliance):
    def test_configured_file_wins_over_legacy_environment(self):
        credential = self.write(self.root / 'current', 'file-token')
        with patch.object(deploy, 'read_env', return_value={
            'HARBOR_GATE_TO_BEACON_TOKEN_FILE':str(credential),
            'HARBORBEACON_WEB_API_TOKEN':'old-token',
        }):
            self.assertEqual(('file-token',''), deploy.effective_gate_tokens())

    def test_unreadable_explicit_file_does_not_rotate_to_legacy(self):
        with patch.object(deploy, 'read_env', return_value={
            'HARBOR_GATE_TO_BEACON_TOKEN_FILE':'/no-such-harbor-demo-credential',
            'HARBORBEACON_WEB_API_TOKEN':'old-token',
        }):
            with self.assertRaises(FileNotFoundError):
                deploy.effective_gate_tokens()


@unittest.skipUnless(os.name == 'posix', 'Lifecycle fixtures require POSIX symlinks; run on Linux')
class LifecycleTests(IsolatedAppliance):
    def setUp(self):
        super().setUp()
        self.events = []
        self.services = {
            'harbor-webui-override.path': {'active':'active', 'enabled':'enabled'},
            'harbor-webui-override': {'active':'active', 'enabled':'enabled-runtime'},
            'harbor-gate-webui-edge': {'active':'inactive', 'enabled':'disabled'},
            'harboros-beacon': {'active':'active', 'enabled':'enabled-runtime'},
            'nginx': {'active':'inactive', 'enabled':'disabled'},
        }
        self.activation = {name: {'persistent': state['enabled'] == 'enabled',
                                  'runtime': state['enabled'] == 'enabled-runtime'}
                           for name, state in self.services.items()}
        def run(*args, **kwargs):
            self.events.append(('command', args))
            if len(args) > 2 and args[:2] in (('systemctl','enable'), ('systemctl','disable')):
                runtime = '--runtime' in args
                for name in args[2:]:
                    if name.startswith('-'):
                        continue
                    name = name.removesuffix('.service')
                    state = self.activation.setdefault(name, {'persistent':False, 'runtime':False})
                    # A runtime enable does not erase an earlier /etc persistent link.
                    state['runtime' if runtime else 'persistent'] = args[1] == 'enable'
            return subprocess.CompletedProcess(args, 0, stdout='', stderr='')
        original_copy = shutil.copy2
        def copy(source, target, *args, **kwargs):
            self.assertTrue(Path(source).is_relative_to(self.root), 'Copy source escaped sandbox')
            self.assertTrue(Path(target).is_relative_to(self.root), 'Copy destination escaped sandbox')
            self.events.append(('copy', str(target)))
            return original_copy(source, target, *args, **kwargs)
        replacements = [patch.object(deploy, 'run', side_effect=run),
                        patch.object(deploy, 'service_states', return_value=self.services),
                        patch.object(deploy, 'wait_beacon'), patch.object(deploy.shutil, 'copy2', side_effect=copy),
                        patch('builtins.print')]
        for replacement in replacements:
            mocked = replacement.start()
            self.addCleanup(replacement.stop)
            if replacement.attribute == 'wait_beacon':
                self.wait = mocked

    def pointer(self, name, marker):
        target = self.base / 'releases' / name / marker
        target.mkdir(parents=True)
        self.write(target / 'marker', name)
        return target

    def snapshot(self):
        snapshot = self.base / 'backups' / 'before'
        snapshot.mkdir(parents=True)
        old_dist = self.pointer('old', 'webui')
        old_deployment = self.pointer('old', 'deployment')
        self.dist.symlink_to(self.pointer('new', 'webui'), target_is_directory=True)
        (self.base / 'deployment').symlink_to(self.pointer('new', 'deployment'), target_is_directory=True)
        config = self.write(self.configs[0], 'new nginx')
        backup = snapshot / 'files' / config.relative_to('/')
        self.write(backup, 'old nginx')
        added = self.write(self.configs[3], 'new-only configuration')
        manifest = {'configs':{str(config):True, str(added):False}, 'services':self.services,
                    'previous_dist':str(old_dist), 'previous_deployment':str(old_deployment)}
        self.write(snapshot / 'manifest.json', json.dumps(manifest))
        return snapshot, old_dist, old_deployment

    def test_restore_quiesces_both_watcher_and_override_before_copy_then_restores_pointers_and_units(self):
        snapshot, old_dist, old_deployment = self.snapshot()
        deploy.restore(snapshot)
        first_copy = next(index for index, event in enumerate(self.events) if event[0] == 'copy')
        for service in ('harbor-webui-override.path', 'harbor-webui-override',
                        'harbor-gate-webui-edge', 'harboros-beacon'):
            self.assertLess(self.events.index(('command', ('systemctl','stop',service))), first_copy)
        self.assertEqual(self.dist.resolve(), old_dist)
        self.assertEqual((self.base / 'deployment').resolve(), old_deployment)
        self.assertEqual(self.configs[0].read_text(), 'old nginx')
        self.assertFalse(self.configs[3].exists())
        commands = [event[1] for event in self.events if event[0] == 'command']
        for service in ('harboros-beacon', 'harbor-webui-override'):
            self.assertIn(('systemctl','enable','--runtime',service), commands)
            self.assertNotIn(('systemctl','enable',service), commands)
        self.assertIn(('systemctl','enable','harbor-webui-override.path'), commands)
        self.assertIn(('systemctl','stop','nginx'), commands)
        self.assertNotIn(('systemctl','reload','nginx'), commands)
        self.assertNotIn(('systemctl','start','harbor-gate-webui-edge'), commands)
        self.wait.assert_called_once()

    def test_restore_reload_preserves_active_nginx_and_keeps_replaced_index_for_diagnosis(self):
        snapshot, _, _ = self.snapshot()
        self.services['nginx'] = {'active':'active', 'enabled':'enabled'}
        index = self.root / 'knowledge/index'
        self.write(index / 'new', 'new index')
        self.write(snapshot / 'knowledge-index/old', 'old index')
        manifest_path = snapshot / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest.update(services=self.services, index_root=str(index))
        self.write(manifest_path, json.dumps(manifest))
        deploy.restore(snapshot)
        self.assertEqual((index / 'old').read_text(), 'old index')
        self.assertEqual((index.with_name('index.after-before') / 'new').read_text(), 'new index')
        commands = [event[1] for event in self.events if event[0] == 'command']
        self.assertIn(('systemctl','reload','nginx'), commands)
        self.assertNotIn(('systemctl','stop','nginx'), commands)

    def test_failed_beacon_start_automatically_restores_existing_release_and_environment(self):
        old_dist = self.pointer('old', 'webui')
        old_deployment = self.pointer('old', 'deployment')
        self.dist.symlink_to(old_dist, target_is_directory=True)
        (self.base / 'deployment').symlink_to(old_deployment, target_is_directory=True)
        for config in self.configs:
            self.write(config, 'OLD_CONFIG=preserve\n' if '/default/' in str(config) else 'old configuration')
        index = self.root / 'knowledge/index'
        self.write(index / 'entry', 'original index')
        self.write(self.path('/var/lib/harboros-beacon/admin-console.json'),
                   json.dumps({'knowledge':{'index_root':str(index)}}))
        source = self.root / 'package'
        for name in ('deploy.py', 'nginx.py', 'harbor-webui-override.service', 'harbor-webui-override.path'):
            self.write(source / name, 'packaged helper')
        archive = self.root / 'webui.tgz'
        with tarfile.open(archive, 'w:gz') as bundle:
            entry = tarfile.TarInfo('index.html')
            entry.size = 8
            bundle.addfile(entry, io.BytesIO(b'new web!'))
        args = argparse.Namespace(webui=archive, webui_commit='fixture', beacon_revision='fixture',
                                  edge_script=None, edge_unit=None, beacon_binary=None, asr_bin=None, asr_model=None)
        self.wait.side_effect = [RuntimeError('simulated startup failure'), None]
        with patch.object(deploy, '__file__', str(source / 'deploy.py')), \
                patch.object(deploy, 'effective_gate_tokens', return_value=('fixture-current','fixture-previous')):
            with self.assertRaisesRegex(RuntimeError, 'simulated startup failure'):
                deploy.install(args)
        self.assertEqual(self.dist.resolve(), old_dist)
        self.assertEqual((self.base / 'deployment').resolve(), old_deployment)
        self.assertEqual(self.path('/etc/default/harboros-beacon').read_text(), 'OLD_CONFIG=preserve\n')
        self.assertEqual(self.configs[4].read_text(), 'old configuration')
        self.assertEqual((index / 'entry').read_text(), 'original index')
        self.assertEqual(self.wait.call_count, 2)
        self.assertTrue(self.activation['harboros-beacon']['runtime'])
        self.assertFalse(self.activation['harboros-beacon']['persistent'],
                         'Rollback left a persistent enable link for an originally runtime-only service')


@unittest.skipUnless(os.name == 'posix', 'Packaged adoption requires POSIX symlinks; run on Linux')
class PackagedAdoptionTests(IsolatedAppliance):
    def legacy(self):
        (self.base / 'deployment').mkdir()
        self.write(self.dist / 'index.html', 'legacy UI')
        packaged = self.root / 'usr/share/truenas/webui'
        self.write(packaged / 'index.html', 'packaged UI')
        return packaged

    def test_adopts_legacy_directory_preserves_backup_and_is_idempotent(self):
        packaged = self.legacy()
        self.write(self.base / 'harbor-assistant-webui.package-next', 'stale interrupted staging')
        self.assertTrue(adoption.adopt(self.base, packaged))
        self.assertTrue(self.dist.is_symlink())
        self.assertEqual(self.dist.resolve(), packaged)
        backups = list((self.base / 'backups').glob('package-webui-*'))
        self.assertEqual(len(backups), 1)
        pointer = json.loads((backups[0] / 'webui-pointer.json').read_text())
        self.assertEqual((Path(pointer['previous_dist']) / 'index.html').read_text(), 'legacy UI')
        self.assertFalse(adoption.adopt(self.base, packaged))
        self.assertEqual(len(list((self.base / 'backups').glob('package-webui-*'))), 1)

    def test_missing_packaged_index_never_moves_existing_ui(self):
        packaged = self.legacy()
        (packaged / 'index.html').unlink()
        with self.assertRaises(ValueError):
            adoption.adopt(self.base, packaged)
        self.assertFalse(self.dist.is_symlink())
        self.assertEqual((self.dist / 'index.html').read_text(), 'legacy UI')

    def test_failed_pointer_replace_restores_legacy_directory_and_preserves_original_error(self):
        packaged = self.legacy()
        with patch.object(Path, 'replace', side_effect=OSError('simulated pointer failure')):
            with self.assertRaisesRegex(OSError, 'simulated pointer failure'):
                adoption.adopt(self.base, packaged)
        self.assertFalse(self.dist.is_symlink())
        self.assertEqual((self.dist / 'index.html').read_text(), 'legacy UI')


if __name__ == '__main__':
    unittest.main()
