# HarborDesk WebUI Integration

HarborDesk is developed as a native HarborOS WebUI module in this repository.
HarborBeacon remains the owner of the HarborDesk admin API and business state.

## Baseline checkout

Use a WebUI baseline that matches the HarborOS target before building a native
HarborDesk bundle. The first 182 validation target reports:

- HarborOS version: `26.04.0-MASTER-20260419-231332`
- `truenas-webui` package: `20260419231504~truenas+1`
- Matching WebUI source candidate: `a055c72b46923fe8ee6c25cfb3be30ee4c50dc57`

Keep this work in an independent checkout instead of copying WebUI sources into
HarborBeacon:

```bash
git clone https://github.com/HarborNAS/webui.git C:/Users/beanw/OpenSource/HarborNAS-webui
cd C:/Users/beanw/OpenSource/HarborNAS-webui
git checkout -b feature/harbordesk-settings-182 a055c72b46923fe8ee6c25cfb3be30ee4c50dc57
```

## Development proxy

The dev proxy reserves `/api/harbordesk/**` for the HarborBeacon admin API:

```text
/api/harbordesk/state -> http://127.0.0.1:4174/api/state
```

Run HarborBeacon `agent-hub-admin-api` on `127.0.0.1:4174` before testing
HarborDesk. The normal HarborOS `/api/**` proxy remains separate. Customers
should access HarborDesk through `/ui/harbordesk`; port `4174` is an internal
admin API endpoint and is not the customer-facing entry.

## Current slice

`/ui/harbordesk` contains the first customer Settings slice:

- Overview for HarborOS principal, writable root, default CIDR, default camera,
  and same-origin HarborBeacon connectivity.
- Devices & AIoT management for discovery scan, manual device add, default
  camera selection, RTSP checks, snapshot checks, share-link create/revoke, and
  device credential configured/redacted status.
- All HarborDesk backend calls use `/api/harbordesk/*` and are rewritten by the
  dev proxy to the HarborBeacon `agent-hub-admin-api`.

The old standalone HarborBeacon `frontend/harbordesk` remains a temporary API
validation shell and should not receive new product UI work.

## 182 live safety rule

Do not deploy a WebUI bundle to 182 unless it is built from the matching
HarborOS WebUI baseline. The safe live fallback is the original HarborOS WebUI
bundle plus the narrow `/ui/harbordesk/` standalone page and `/api/harbordesk/`
same-origin proxy.

## Live smoke validation

After a 197 build passes and the HarborDesk bundle is staged on 182, run the
Python Playwright smoke runner from this checkout:

```bash
python scripts/harbordesk/live_smoke.py \
  --base-url http://192.168.3.182 \
  --username "$HARBORDESK_SMOKE_USERNAME" \
  --password "$HARBORDESK_SMOKE_PASSWORD"
```

Use `--self-test` first when validating a new workstation. The runner opens the
customer-facing `/ui/harbordesk` path, captures screenshots per tab, records
console and network failures, verifies that HarborDesk uses same-origin
`/api/harbordesk/*` instead of direct `4174` browser calls, and writes
`report.json` plus `report.md` under `artifacts/harbordesk-live-smoke/`.

The default mode is read-only except for opening setup pages. Use
`--mode safe-actions` only during live acceptance when camera RTSP, snapshot,
share-link create/revoke, and model health checks are explicitly in scope.
The runner never performs device deletion and never submits IM credentials.

## Ownership boundaries

- HarborDesk uses HarborOS WebUI login and layout.
- HarborBeacon owns HarborDesk admin API, approvals, artifacts, audit, and
  business settings state.
- HarborGate owns IM credentials, platform transport, setup URLs, and redacted
  connector status.
- AIoT device management remains in the AIoT lane and is not part of HarborOS
  System Domain control.
