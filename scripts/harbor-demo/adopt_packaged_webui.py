#!/usr/bin/env python3
"""Point an existing appliance override at the WebUI installed by this package."""
from datetime import datetime, timezone
import json
from pathlib import Path


def adopt(base, packaged):
    current = base / 'harbor-assistant-webui'
    if not (base / 'deployment').exists() or not current.exists():
        return False
    if not (packaged / 'index.html').is_file():
        raise ValueError('The packaged WebUI is missing index.html')
    if current.resolve() == packaged.resolve():
        return False
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = base / 'backups' / ('package-webui-' + stamp)
    backup.mkdir(parents=True, mode=0o700)
    previous = current.resolve()
    legacy_directory = not current.is_symlink()
    if legacy_directory:
        previous = backup / 'webui'
    (backup / 'webui-pointer.json').write_text(json.dumps({
        'previous_dist':str(previous), 'packaged_dist':str(packaged),
    },indent=2))
    # Prepare the new pointer before touching a legacy directory. A stale staging
    # link from an interrupted upgrade cannot collide with this unique name.
    staged = current.with_name(current.name + '.package-next-' + stamp)
    staged.symlink_to(packaged, target_is_directory=True)
    moved = False
    try:
        if legacy_directory:
            current.rename(previous)
            moved = True
        staged.replace(current)
    except Exception:
        if moved and not current.exists() and not current.is_symlink():
            previous.rename(current)
        raise
    return True


if __name__ == '__main__':
    adopt(Path('/var/lib/harborbeacon-agent-ci'), Path('/usr/share/truenas/webui'))
