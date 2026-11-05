# Harbor Assistant formal WebUI integration

This change builds on the formal 26.04 base b8dc9017d2. Reviewed media, authenticated dual-stack RAG, and HarborNavi build prerequisites are taken from 5fbb53ddfa. The Composer and model-selection behavior is ported at the feature level; Demo authentication and Debian service overrides are excluded.

## Protocol and product boundaries

- Nexus browser calls use a fresh 30-second, single-use middleware token through AuthService. The scoped interceptor attaches X-HarborOS-Auth-Token only to relative same-origin Assistant proxy paths. Existing explicitly authenticated content calls retain their token. Retrying a cold request obtains fresh user proof.
- Knowledge search, conversations, previews, and model selection use the Gate proxy. Chat continues through knowledge/search. No direct llama.cpp browser protocol is added.
- Response preference is auto, fast, or careful. Requests persist that preference with response_preference_persist. Fast indexed photos are labelled as not visually verified; careful mode reports actual verification metadata and blockers.
- Model selection submits model_id and optional model_endpoint_id. Selected and running identities remain separate until the server confirms activation. Failed transitions show last_error. Downloads require a later explicit activation action.
- HarborNavi retains its own API prefix and authentication boundary. local_model_policy=fixed disables selection; explicitly unsupported capabilities remain visible and do not inflate supported-capability readiness counts. The reviewed media-stack package pins remain unchanged.
- Feishu credentials and WeChat actions are native protected WebUI requests. Feishu success appears only after success=true. Secrets are cleared after submission, and the setup session code is held only in component memory. The QR is rendered locally from the login response. Nexus Feishu identity pairing creates a caller-owned, five-minute one-time challenge; the user sends the exact message through their real Feishu account. Only backend confirmation reports a successful binding.

## Automated verification

Run the Assistant, desktop, admin route, and AuthService Jest suites. Coverage includes initial loading, bounded transient retries, actual endpoint metadata, failed desired/active transitions, fixed-product controls, authenticated search/photo previews, per-request and per-retry tokens, the Navi authentication fence, and native connection success/failure.

Run production build, app TypeScript checks, ESLint, Stylelint, check:harbor-assistant-i18n, and check:harbor-assistant-profiles. The HarborNavi build uses its separate Angular configuration. Windows builds may set NG_BUILD_MAX_WORKERS=2 and GOMAXPROCS=2 to bound memory.

## Browser acceptance after deployment

1. Log in to /ui/ and open Harbor Assistant from the desktop. Confirm direct /ui/harbor-assistant navigation also works.
2. Navigate to another HarborOS page while a Composer request is pending. Confirm one request completes, the draft and result survive navigation, and the page remains usable beside the result pane.
3. Use + to choose sources, retrieval mode, result type, time range, and conversation history. Verify these selections reach knowledge/search.
4. Test fast photo search and careful photo search. Confirm authenticated previews, indexed snippets, stable result order, and accurate skipped/completed/degraded/not-run verification labels.
5. Open Models. Delay or temporarily fail the capabilities API and verify Loading model status, bounded retry, and no premature 0/4 Ready.
6. Verify desired model, active model, transition/error, backend/device, endpoint URL, and persistence against the actual API response. A download alone must not claim the model is running.
7. Confirm unavailable embeddings, source/index prerequisites, VLM/OCR/ASR/TTS, and unsupported N2 capabilities show blockers. On N2, fixed models have no installation or switching controls.
8. In Message connections, verify Feishu rejects invalid credentials without success, then validate approved credentials. Verify secrets and session code never appear in page text or evidence. Test WeChat QR expiry, confirmation, reconnect, and explicit disconnect.
9. Reload and repeat entry into Models. Compare capabilities and endpoints JSON with the displayed state.
10. Smoke Dashboard, Apps, System, existing camera/live controls, and search/history settings. Save screenshots and redacted API evidence.

This source change does not deploy to a NAS, alter runtime services or model files, or qualify a new RISC-V runtime artifact. Production hardware and account verification remain release acceptance steps.

## Local browser verification limit

An isolated Angular fixture reused the real Composer, Models, native Connections, formal workspace/header styles, and synthetic provider data. It did not contact a NAS or a real account. A measured 320 CSS-pixel Connections view showed the repaired header, shrinking input fields and Composer within their bounds. A near-768 view exposed another header wrap case, which was fixed in Assistant-scoped CSS afterward.

Windows computer-use policy then stopped browser control because it could not reliably confirm the active browser URL. No alternate driver was used. Final-source visual checks at 320, 390, 768, 1024 and 1440 remain pending; TypeScript, unit tests, style checks and production builds do not replace those visual checks.
