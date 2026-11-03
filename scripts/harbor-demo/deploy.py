#!/usr/bin/env python3
"""Root-only local installer/rollback for HarborNAS Assistant demo artifacts."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tarfile
import time
import urllib.request

BASE = Path('/var/lib/harborbeacon-agent-ci')
DIST = BASE / 'harbor-assistant-webui'
UNITS = ['harboros-beacon', 'harbor-demo-llama', 'harbor-demo-rag-llama', 'harbor-demo-vlm', 'harbor-demo-asr',
         'harbor-demo-tts', 'harbor-gate-webui-edge', 'nginx',
         'harbor-webui-override', 'harbor-webui-override.path']
CONFIGS = [Path('/etc/nginx/nginx.conf'), Path('/etc/default/harboros-beacon'),
           Path('/etc/default/harboros-beacon-gate'), Path('/etc/default/harbor-gate-webui-edge'),
           Path('/etc/systemd/system/harboros-beacon.service.d/harbor-assistant-dist.conf')]
CONFIGS += [Path('/etc/systemd/system') / (name + suffix)
            for name, suffix in [('harbor-webui-override','.service'), ('harbor-webui-override','.path'),
                                 ('harbor-gate-webui-edge','.service')]]


def run(*args, check=True):
    return subprocess.run(args, check=check, text=True, capture_output=True)


def service_states():
    return {name: {'active': run('systemctl','is-active',name,check=False).stdout.strip(),
                   'enabled': run('systemctl','is-enabled',name,check=False).stdout.strip()}
            for name in UNITS}


def read_env(path):
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            values[key.removeprefix('export ').strip()] = shlex.split(value)[0] if value.strip() else ''
    return values


def write_env(path, values):
    path.write_text(''.join(key + '=' + shlex.quote(value) + '\n' for key,value in values.items()))
    path.chmod(0o600)


def wait_beacon():
    for attempt in range(40):
        try:
            with urllib.request.urlopen('http://127.0.0.1:4174/healthz', timeout=2) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(.5)
    raise RuntimeError('Beacon did not become healthy')


def switch_link(link, target):
    staged = link.with_name(link.name + '.next')
    if staged.is_symlink():
        staged.unlink()
    staged.symlink_to(target, target_is_directory=True)
    staged.replace(link)


def effective_gate_tokens():
    values = read_env(Path('/etc/default/harboros-beacon-gate'))
    values.update(read_env(Path('/etc/default/harboros-beacon')))
    def resolve(file_key, env_keys, credential_name, optional=False):
        systemd = Path('/run/credentials/harboros-beacon.service') / credential_name
        if systemd.exists():
            return systemd.read_text().strip()
        if values.get(file_key):
            return Path(values[file_key]).read_text().strip()
        for key in env_keys:
            if values.get(key):
                return values[key]
        if optional:
            return ''
        raise ValueError('Existing Gate service credential is required')
    current = resolve('HARBOR_GATE_TO_BEACON_TOKEN_FILE',
                      ['HARBOR_GATE_TO_BEACON_TOKEN','HARBORBEACON_WEB_API_TOKEN'],
                      'gate-to-beacon-accept-current')
    previous = resolve('HARBOR_GATE_TO_BEACON_TOKEN_PREVIOUS_FILE',
                       ['HARBOR_GATE_TO_BEACON_TOKEN_PREVIOUS'],
                       'gate-to-beacon-accept-previous', optional=True)
    if not current:
        raise ValueError('Existing Gate service credential is empty')
    return current, previous


def restore(snapshot):
    manifest = json.loads((snapshot / 'manifest.json').read_text())
    # Stop watchers before restoring generated nginx or the deployment symlink.
    for name in ['harbor-webui-override.path','harbor-webui-override','harbor-gate-webui-edge','harboros-beacon']:
        run('systemctl','stop',name,check=False)
    changed_units = ['harbor-webui-override','harbor-webui-override.path','harbor-gate-webui-edge']
    for name in changed_units + ['harboros-beacon','nginx']:
        run('systemctl','disable',name,check=False)
        run('systemctl','disable','--runtime',name,check=False)
    for target_name, existed in manifest['configs'].items():
        target = Path(target_name)
        backup = snapshot / 'files' / target.relative_to('/')
        if existed:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(backup, target)
        elif target.exists():
            target.unlink()
    for name in ['admin-console.json','device-registry.json','task-api-conversations.json']:
        backup = snapshot / 'state' / name
        if backup.exists():
            shutil.copy2(backup, Path('/var/lib/harboros-beacon') / name)
    index_root = manifest.get('index_root')
    index_backup = snapshot / 'knowledge-index'
    if index_root and index_backup.exists():
        current_index = Path(index_root)
        if current_index.exists():
            after = current_index.with_name(current_index.name + '.after-' + snapshot.name)
            if not after.exists():
                current_index.rename(after)
            else:
                raise ValueError('Rollback index destination already exists')
        shutil.copytree(index_backup, current_index, symlinks=True)
    for link, key in [(DIST,'previous_dist'), (BASE / 'deployment','previous_deployment')]:
        target = manifest.get(key)
        if target and Path(target).exists():
            if not (link.exists() and not link.is_symlink()):
                switch_link(link, Path(target))
        elif not target and link.is_symlink():
            link.unlink()
    run('systemctl','daemon-reload')
    for name in changed_units + ['harboros-beacon','nginx']:
        enabled = manifest['services'].get(name,{}).get('enabled')
        if enabled == 'enabled-runtime':
            run('systemctl','enable','--runtime',name)
        elif enabled == 'enabled':
            run('systemctl','enable',name)
        elif enabled == 'disabled':
            run('systemctl','disable',name,check=False)
    run('nginx','-t')
    if manifest['services'].get('nginx',{}).get('active') == 'active':
        run('systemctl','reload','nginx')
    if manifest['services'].get('nginx',{}).get('active') != 'active':
        run('systemctl','stop','nginx',check=False)
    for name in ['harboros-beacon','harbor-gate-webui-edge','harbor-webui-override','harbor-webui-override.path']:
        if manifest['services'].get(name,{}).get('active') == 'active':
            run('systemctl','start',name)
    if manifest['services'].get('harboros-beacon',{}).get('active') == 'active':
        wait_beacon()
    print(json.dumps({'restored': str(snapshot), 'services':service_states()}))


def install(args):
    release_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    release = BASE / 'releases' / release_id
    snapshot = BASE / 'backups' / release_id
    release.mkdir(parents=True)
    snapshot.mkdir(parents=True)
    # data filter rejects traversal and device nodes; links are not valid WebUI artifacts.
    webui = release / 'webui'
    webui.mkdir()
    with tarfile.open(args.webui) as archive:
        members = archive.getmembers()
        if any(member.issym() or member.islnk() for member in members):
            raise ValueError('WebUI archive may contain only directories and regular files')
        archive.extractall(webui, filter='data')
    if not (webui / 'index.html').is_file():
        raise ValueError('WebUI archive must contain index.html at its root')
    manifest = {'release':str(release),'configs':{},'services':service_states(),
                'previous_dist':str(DIST.resolve()) if DIST.exists() else None,
                'webui_commit':args.webui_commit,'beacon_revision':args.beacon_revision}
    for target in CONFIGS:
        manifest['configs'][str(target)] = target.exists()
        if target.exists():
            backup = snapshot / 'files' / target.relative_to('/')
            backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, backup)
    token, previous_token = effective_gate_tokens()
    deployment_link = BASE / 'deployment'
    manifest['previous_deployment'] = str(deployment_link.resolve()) if deployment_link.exists() else None
    legacy_dist = release / 'previous-webui'
    legacy_deployment = release / 'previous-deployment'
    if DIST.exists() and not DIST.is_symlink():
        manifest['previous_dist'] = str(legacy_dist)
    if deployment_link.exists() and not deployment_link.is_symlink():
        manifest['previous_deployment'] = str(legacy_deployment)
    (snapshot / 'manifest.json').write_text(json.dumps(manifest,indent=2))
    snapshot.chmod(0o700)
    try:
        run('systemctl','stop','harbor-webui-override.path',check=False)
        run('systemctl','stop','harbor-webui-override',check=False)
        run('systemctl','stop','harboros-beacon')
        state_backup = snapshot / 'state'
        state_backup.mkdir()
        for name in ['admin-console.json','device-registry.json','task-api-conversations.json']:
            source = Path('/var/lib/harboros-beacon') / name
            if source.exists():
                shutil.copy2(source, state_backup / name)
        admin_state = state_backup / 'admin-console.json'
        if admin_state.exists():
            index_root = Path(json.loads(admin_state.read_text())['knowledge']['index_root'])
            if index_root.is_absolute() and len(index_root.parts) >= 4 and index_root.is_dir():
                if index_root.is_relative_to(BASE / 'backups') or BASE.is_relative_to(index_root):
                    raise ValueError('Knowledge index path overlaps deployment state')
                shutil.copytree(index_root, snapshot / 'knowledge-index', symlinks=True)
                manifest['index_root'] = str(index_root)
                (snapshot / 'manifest.json').write_text(json.dumps(manifest,indent=2))
        if DIST.exists() and not DIST.is_symlink():
            DIST.rename(legacy_dist)
        if deployment_link.exists() and not deployment_link.is_symlink():
            deployment_link.rename(legacy_deployment)
        deployment = release / 'deployment'
        deployment.mkdir()
        source_dir = Path(__file__).resolve().parent
        shutil.copy2(source_dir / 'nginx.py', deployment / 'nginx.py')
        shutil.copy2(source_dir / 'deploy.py', deployment / 'deploy.py')
        for name in ['harbor-webui-override.service','harbor-webui-override.path']:
            shutil.copy2(source_dir / name, Path('/etc/systemd/system') / name)
        if args.edge_script:
            shutil.copy2(args.edge_script, deployment / 'edge_proxy.py')
            shutil.copy2(args.edge_unit, Path('/etc/systemd/system/harbor-gate-webui-edge.service'))
        env_path = Path('/etc/default/harboros-beacon')
        values = read_env(env_path)
        credential_dir = release / 'credentials'
        credential_dir.mkdir(mode=0o700)
        current = credential_dir / 'gate-to-beacon'
        previous = credential_dir / 'gate-to-beacon-previous'
        current.write_text(token); current.chmod(0o600)
        previous.write_text(previous_token); previous.chmod(0o600)
        values.update({'HARBOR_GATE_TO_BEACON_TOKEN_FILE':str(current),
                       'HARBOR_GATE_TO_BEACON_TOKEN_PREVIOUS_FILE':str(previous),
                       'HARBORBEACON_SOUTHBOUND_MODE':'harborlink'})
        if args.asr_bin:
            values['HARBOR_ASR_BIN'] = str(args.asr_bin)
        if args.asr_model:
            values['HARBOR_ASR_MODEL'] = str(args.asr_model)
            values['HARBOR_ASR_LANGUAGE'] = 'auto'
            values['HARBOR_ASR_THREADS'] = '8'
        write_env(env_path, values)
        if args.edge_script:
            state = json.loads((Path('/var/lib/harboros-beacon') / 'admin-console.json').read_text())
            workspace = next((item['workspace_id'] for item in state['platform']['workspaces']
                              if item.get('status') == 'active'), None)
            if not workspace:
                raise ValueError('An active Beacon workspace is required')
            write_env(Path('/etc/default/harbor-gate-webui-edge'), {
                'HARBOR_GATE_TO_BEACON_TOKEN_FILE':str(current),
                'HARBOR_EDGE_WORKSPACE_ID':workspace})
        binary = Path('/usr/bin/harboros-beacon')
        if args.beacon_binary:
            binary = release / 'harboros-beacon'
            shutil.copy2(args.beacon_binary, binary)
            binary.chmod(0o755)
        dropin = Path('/etc/systemd/system/harboros-beacon.service.d/harbor-assistant-dist.conf')
        dropin.parent.mkdir(parents=True,exist_ok=True)
        dropin.write_text('[Service]\nExecStart=\nExecStart=' + str(binary)
            + ' --bind 127.0.0.1:4174 --admin-state /var/lib/harboros-beacon/admin-console.json'
            + ' --device-registry /var/lib/harboros-beacon/device-registry.json'
            + ' --conversations /var/lib/harboros-beacon/task-api-conversations.json'
            + ' --harbor-assistant-dist ' + str(DIST) + ' --public-origin http://127.0.0.1:4174\n')
        switch_link(DIST, webui)
        switch_link(deployment_link, deployment)
        run('systemctl','daemon-reload')
        run('systemctl','enable','harboros-beacon','nginx')
        run('systemctl','start','harboros-beacon')
        wait_beacon()
        if args.edge_script:
            run('systemctl','enable','--now','harbor-gate-webui-edge')
            run('systemctl','restart','harbor-gate-webui-edge')
        run('systemctl','enable','harbor-webui-override.service')
        run('systemctl','enable','--now','harbor-webui-override.path')
        run('systemctl','restart','harbor-webui-override.service')
        print(json.dumps({'installed':str(release),'rollback_snapshot':str(snapshot),'services':service_states()}))
    except Exception:
        restore(snapshot)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command',required=True)
    deployment = commands.add_parser('install')
    deployment.add_argument('--webui',type=Path,required=True)
    deployment.add_argument('--webui-commit',required=True)
    deployment.add_argument('--beacon-revision',default='existing')
    deployment.add_argument('--beacon-binary',type=Path)
    deployment.add_argument('--edge-script',type=Path)
    deployment.add_argument('--edge-unit',type=Path)
    deployment.add_argument('--asr-bin',type=Path)
    deployment.add_argument('--asr-model',type=Path)
    rollback = commands.add_parser('restore')
    rollback.add_argument('snapshot',type=Path)
    commands.add_parser('health')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run this installer as root via sudo')
    if args.command == 'install':
        install(args)
    elif args.command == 'restore':
        restore(args.snapshot)
    else:
        print(json.dumps(service_states(),indent=2))
