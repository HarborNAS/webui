# HarborOS Assistant deployment

The WebUI remains part of the normal `truenas-webui` package. The NAS middleware
nginx template sends `/api/harbor-beacon` to the HarborGate session edge on
loopback 4176, which preserves the Beacon protocol and supplies the real NAS
user identity. Gate packages the edge adapter and its service. Model endpoints,
source settings, route policies and conversations remain owned by Beacon.

For the existing read-only demo appliance, `deploy.py` installs versioned
WebUI/binary/transport artifacts under `/var/lib/harborbeacon-agent-ci/releases`.
It snapshots the current dist location, generated nginx, relevant units and
environment files, Beacon state and knowledge index. Credentials are copied
privately to the new release without changing their effective values. Failed
Beacon startup or invalid nginx causes automatic rollback. Browser smoke failure
must invoke the printed rollback snapshot explicitly.

The generated-nginx override service and path watcher are for this appliance;
normal HarborNAS images use the source nginx template and packaged WebUI.
Reapplying the override is idempotent and validates the complete config before
replacing it. Runtime/model paths are persistent under `/var/lib`; the package
includes service definitions, the ASR wrapper and TTS adapter separately in
HarborBeacon `scripts/harbor_demo/multimodal`.

## Install on the appliance

Copy this directory, a normal production WebUI dist tarball (index.html at the
archive root), the Linux Beacon binary, and HarborGate's edge script/unit to a
staging directory. Run as root:

```sh
python3 deploy.py install --webui webui.tgz --webui-commit COMMIT \
  --beacon-binary harboros-beacon --beacon-revision REVISION \
  --edge-script edge_proxy.py --edge-unit harbor-gate-webui-edge.service \
  --asr-bin /var/lib/harborbeacon-agent-ci/runtime/whisper-cli-demo \
  --asr-model /var/lib/harborbeacon-agent-ci/models/multimodal/ggml-small.bin
python3 /var/lib/harborbeacon-agent-ci/deployment/deploy.py health
```

Backups contain private service credentials and must remain root-only. Models
are reused; installing the WebUI does not replace model files. Existing runtime
services are not restarted by the WebUI installer.

## Rollback

```sh
sudo python3 deploy.py restore /var/lib/harborbeacon-agent-ci/backups/SNAPSHOT
```

The previous deployment scripts, static files, state, credentials and unit
activation state are restored. The replaced knowledge index is retained beside
the restored index for diagnosis. GPU and iSCSI source modifications are outside
this deployment and are never changed.

## Validation

```sh
python3 -m unittest discover -s scripts/harbor-demo -p 'test_*.py'
```

Run the browser smoke after deployment and again after a full reboot. Report
Chat, cited RAG, VLM, ASR and TTS independently. A health response or registry
entry alone does not establish that inference succeeded. Example documents are
explicitly labeled synthetic rehearsal data; replace them with approved customer
documents when available.
