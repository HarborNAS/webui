# Formal Assistant source classification

Formal base: b8dc9017d2 (26.04). Original Demo checkout remains at f9fa96b342 on its existing branch. This integration uses the isolated formal worktree; the original checkout was read only.

## Included

- Reviewed 5fbb53ddfa Assistant media, authenticated dual-stack RAG, the single-use AuthService helper, and HarborNavi build/delivery prerequisites. Navi component variants retain their behavior in lint-compatible component directories. Existing Beacon/HarborLink media release pins are unchanged.
- Feature-level global Composer, indexed photo results, fast/careful verification metadata, truthful desired/active model selection, backend-reported runtime/device metadata, product capability blockers, native protected connection settings, and caller-owned Nexus Feishu pairing.
- W7900 remains visible through actual endpoint runtime_backend_kind/runtime_device metadata and is covered by model-card and response metadata tests. Hardware readiness remains the Beacon/DRM runtime's source of truth. Browser UI code does not probe GPU devices or connect directly to llama.cpp.

## Original Demo changes outside this feature port

The following are real differences from the formal base; they have not been silently treated as already present.

- Container GPU work changes six files: container.interface.ts and five files under container-gpu-devices. It adds structured ContainerGpuChoice readiness, unavailable-device disabling, CUDA/ROCm/Intel status, and W7900 BAR/reBAR guidance. The formal base retains its existing container GPU selection behavior. Container passthrough management is separate from Assistant Vulkan inference status and is outside this formal Assistant port. The original Demo implementation remains preserved for a separate functional port if requested.
- iSCSI work differs in 56 files under sharing/iscsi and the dashboard iSCSI card: 49 target-management files deleted, six modified, and one route test added. It removes the Targets tab and redirects targets to Extents. This Assistant port retains the formal Targets routes/components; it has no dependency on removing storage management.
- No GPU/container interface or iSCSI file is changed relative to b8dc9017d2 by this branch.
- Demo global Bearer interception, direct llama chat/proxy behavior, adopted-install postinst/override behavior, and model/weight files are excluded. Nexus Debian packaging and GitHub workflows retain the formal base.

## Preservation evidence

The four broad initial ports were snapshotted before rebuilding this isolated branch. The recoverable bundle and binary patch are at E:/HarborReleaseIntegration/20261105/snapshots/webui-root-port-before-rebuild.bundle and webui-root-port-before-rebuild.patch. No reset, deletion, or overwrite was performed in the original Demo checkout.

Validation and browser limits are recorded separately. Source builds and mocked tests do not qualify physical NAS behavior or new RISC-V artifacts.
