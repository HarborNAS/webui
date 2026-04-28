#!/usr/bin/env python3
"""HarborDesk live smoke runner for the HarborOS WebUI integration.

The runner uses Python Playwright so it can run from the local Codex desktop
environment without relying on the WebUI Node Playwright stack.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import traceback
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

from playwright.sync_api import (
    Browser,
    BrowserContext,
    Error as PlaywrightError,
    Page,
    TimeoutError as PlaywrightTimeoutError,
    sync_playwright,
)


CONNECTED_DEVICES_ZH = "\u5468\u8fb9\u8bbe\u5907"
SYSTEM_INTEGRATION_ZH = "\u7cfb\u7edf\u8054\u52a8"
OVERVIEW_ZH = "\u6982\u89c8"
IM_CONNECTORS_ZH = "IM \u8fde\u63a5"
MODELS_RAG_ZH = "\u6a21\u578b\u4e0e RAG"
OPEN_SETUP_ZH = "\u6253\u5f00\u914d\u7f6e"


@dataclass
class Issue:
    severity: str
    area: str
    title: str
    detail: str
    evidence: dict[str, Any] = field(default_factory=dict)


@dataclass
class Artifact:
    kind: str
    label: str
    path: str


@dataclass
class SmokeReport:
    base_url: str
    ui_path: str
    started_at: str
    finished_at: str | None = None
    mode: str = "read-only"
    login_attempted: bool = False
    harbordesk_loaded: bool = False
    console_errors: list[dict[str, str]] = field(default_factory=list)
    network_failures: list[dict[str, str]] = field(default_factory=list)
    api_failures: list[dict[str, Any]] = field(default_factory=list)
    direct_admin_api_requests: list[str] = field(default_factory=list)
    disabled_buttons: dict[str, list[str]] = field(default_factory=dict)
    overflow_candidates: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    setup_urls: dict[str, str] = field(default_factory=dict)
    tab_results: dict[str, str] = field(default_factory=dict)
    issues: list[Issue] = field(default_factory=list)
    artifacts: list[Artifact] = field(default_factory=list)


TAB_PATTERNS: dict[str, re.Pattern[str]] = {
    "overview": re.compile(rf"^(Overview|{OVERVIEW_ZH})$", re.I),
    "im": re.compile(rf"^(IM Connectors|{IM_CONNECTORS_ZH})$", re.I),
    "models": re.compile(rf"^(Models|Models & RAG|{MODELS_RAG_ZH})$", re.I),
    "devices": re.compile(
        rf"^({CONNECTED_DEVICES_ZH}|Connected Devices|Devices & AIoT)$",
        re.I,
    ),
    "system": re.compile(
        rf"^({SYSTEM_INTEGRATION_ZH}|System Integration|HarborOS)$",
        re.I,
    ),
}


SENSITIVE_QUERY_KEYS = {
    "access_token",
    "api_key",
    "code",
    "password",
    "session",
    "token",
}

IGNORED_CONSOLE_PATTERNS = [
    re.compile(r"Clear-Site-Data header .*Not supported for insecure origins", re.I),
]


def now_label() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def timestamp_for_path() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def clean_base_url(raw: str) -> str:
    value = raw.strip().rstrip("/")
    if not value:
        raise ValueError("base URL is required")
    if not value.startswith(("http://", "https://")):
        value = f"http://{value}"
    return value


def absolutize(base_url: str, path: str) -> str:
    if path.startswith(("http://", "https://")):
        return path
    return urljoin(f"{base_url}/", path.lstrip("/"))


def redact_url(url: str) -> str:
    parts = urlsplit(url)
    query = []
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if key.lower() in SENSITIVE_QUERY_KEYS:
            query.append((key, "[REDACTED]"))
        else:
            query.append((key, value))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def add_issue(
    report: SmokeReport,
    severity: str,
    area: str,
    title: str,
    detail: str,
    evidence: dict[str, Any] | None = None,
) -> None:
    report.issues.append(Issue(severity, area, title, detail, evidence or {}))


def safe_texts(page: Page, selector: str) -> list[str]:
    try:
        return [
            text.strip()
            for text in page.locator(selector).all_inner_texts()
            if text.strip()
        ]
    except PlaywrightError:
        return []


def page_text(page: Page) -> str:
    try:
        return page.evaluate("""() => document.body?.textContent || """)
    except PlaywrightError:
        return "\n".join(safe_texts(page, "body"))


def scroll_harbordesk_content(page: Page, direction: str = "bottom") -> None:
    page.evaluate(
        """(direction) => {
          const targetTop = direction === 'bottom' ? 1_000_000 : 0;
          window.scrollTo(0, targetTop);
          for (const element of Array.from(document.querySelectorAll('*'))) {
            const style = window.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const canScroll = element.scrollHeight > element.clientHeight + 8;
            if (canScroll) element.scrollTop = targetTop;
          }
        }""",
        direction,
    )
    page.wait_for_timeout(200)


def screenshot(page: Page, output_dir: Path, report: SmokeReport, label: str) -> None:
    path = output_dir / f"{label}.png"
    page.screenshot(path=str(path), full_page=True)
    report.artifacts.append(Artifact("screenshot", label, str(path)))


def write_reports(report: SmokeReport, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    report.finished_at = now_label()
    json_path = output_dir / "report.json"
    markdown_path = output_dir / "report.md"
    json_path.write_text(
        json.dumps(asdict(report), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    markdown_path.write_text(render_markdown(report), encoding="utf-8")


def render_markdown(report: SmokeReport) -> str:
    lines = [
        "# HarborDesk Live Smoke Report",
        "",
        f"- Base URL: `{report.base_url}`",
        f"- UI path: `{report.ui_path}`",
        f"- Mode: `{report.mode}`",
        f"- Started: `{report.started_at}`",
        f"- Finished: `{report.finished_at or 'running'}`",
        f"- HarborDesk loaded: `{report.harbordesk_loaded}`",
        "",
        "## Issues",
        "",
    ]
    if report.issues:
        for issue in sorted(report.issues, key=lambda item: severity_rank(item.severity)):
            lines.extend(
                [
                    f"- **{issue.severity.upper()}** `{issue.area}`: {issue.title}",
                    f"  {issue.detail}",
                ],
            )
            if issue.evidence:
                lines.append(f"  Evidence: `{json.dumps(issue.evidence, ensure_ascii=False)}`")
    else:
        lines.append("- No issues recorded by the runner.")

    lines.extend(["", "## Tabs", ""])
    for tab, status in report.tab_results.items():
        lines.append(f"- `{tab}`: {status}")

    lines.extend(["", "## IM Setup URLs", ""])
    if report.setup_urls:
        for platform, url in report.setup_urls.items():
            lines.append(f"- `{platform}`: `{url}`")
    else:
        lines.append("- No setup URLs captured.")

    lines.extend(["", "## Network", ""])
    lines.append(f"- Console errors: `{len(report.console_errors)}`")
    lines.append(f"- Network failures: `{len(report.network_failures)}`")
    lines.append(f"- API failures: `{len(report.api_failures)}`")
    lines.append(f"- Direct `:4174` requests from UI: `{len(report.direct_admin_api_requests)}`")

    lines.extend(["", "## Artifacts", ""])
    for artifact in report.artifacts:
        lines.append(f"- `{artifact.kind}` {artifact.label}: `{artifact.path}`")
    return "\n".join(lines) + "\n"


def severity_rank(severity: str) -> int:
    return {"blocker": 0, "high": 1, "medium": 2, "low": 3}.get(severity, 4)


def attach_observers(page: Page, report: SmokeReport) -> None:
    def on_console(message: Any) -> None:
        if message.type in {"error", "warning"}:
            if any(pattern.search(message.text) for pattern in IGNORED_CONSOLE_PATTERNS):
                return
            report.console_errors.append(
                {
                    "type": message.type,
                    "text": message.text,
                    "location": str(message.location),
                },
            )

    def on_request_failed(request: Any) -> None:
        failure = request.failure
        if isinstance(failure, dict):
            error_text = failure.get("errorText", "")
        else:
            error_text = str(failure or "")
        report.network_failures.append(
            {
                "method": request.method,
                "url": redact_url(request.url),
                "error": error_text,
            },
        )

    def on_response(response: Any) -> None:
        url = response.url
        if ":4174" in url:
            report.direct_admin_api_requests.append(redact_url(url))
        if "/api/harbordesk/" in url and response.status >= 400:
            report.api_failures.append(
                {
                    "status": response.status,
                    "url": redact_url(url),
                    "status_text": response.status_text,
                },
            )

    page.on("console", on_console)
    page.on("requestfailed", on_request_failed)
    page.on("response", on_response)


def maybe_login(page: Page, args: argparse.Namespace, report: SmokeReport) -> None:
    page.goto(absolutize(args.base_url, "/ui/"), wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle", timeout=args.timeout_ms)

    password = page.locator("input[type='password']").first
    if password.count() == 0 or not password.is_visible(timeout=2_000):
        return

    if not args.username or not args.password:
        add_issue(
            report,
            "blocker",
            "login",
            "Login form is visible but credentials are missing",
            "Set HARBORDESK_SMOKE_USERNAME and HARBORDESK_SMOKE_PASSWORD or pass --username/--password.",
        )
        return

    report.login_attempted = True
    username = first_visible(
        page,
        [
            "input[autocomplete='username']",
            "input[name='username']",
            "input[formcontrolname='username']",
            "input[type='text']",
        ],
    )
    if username is None:
        add_issue(report, "blocker", "login", "Username input not found", "Could not identify the HarborOS login username field.")
        return

    username.fill(args.username)
    password.fill(args.password)

    submit = first_visible_role_button(
        page,
        re.compile(r"(log in|login|sign in|登录)", re.I),
    )
    if submit is None:
        submit = first_visible(page, ["button[type='submit']"])
    if submit is None:
        add_issue(report, "blocker", "login", "Login submit button not found", "Could not identify the HarborOS login action.")
        return

    submit.click()
    try:
        page.wait_for_url(lambda url: "/signin" not in url, timeout=args.timeout_ms)
    except PlaywrightTimeoutError:
        page.wait_for_timeout(2_000)
    page.wait_for_load_state("domcontentloaded", timeout=args.timeout_ms)
    try:
        password.wait_for(state="hidden", timeout=5_000)
    except PlaywrightTimeoutError:
        pass
    if page.locator("input[type='password']").count() > 0 and page.locator("input[type='password']").first.is_visible(timeout=1_000):
        add_issue(report, "blocker", "login", "Login did not complete", "The password input remains visible after submit.")


def first_visible(page: Page, selectors: list[str]) -> Any | None:
    for selector in selectors:
        locator = page.locator(selector).first
        try:
            if locator.count() > 0 and locator.is_visible(timeout=500):
                return locator
        except PlaywrightError:
            continue
    return None


def first_visible_role_button(page: Page, name: re.Pattern[str]) -> Any | None:
    locator = page.get_by_role("button", name=name).first
    try:
        if locator.count() > 0 and locator.is_visible(timeout=1_000):
            return locator
    except PlaywrightError:
        return None
    return locator


def first_button_by_text(page: Page, pattern: re.Pattern[str]) -> Any | None:
    buttons = page.locator("button")
    try:
        count = buttons.count()
    except PlaywrightError:
        return None
    for index in range(count):
        button = buttons.nth(index)
        try:
            if not button.is_visible(timeout=250):
                continue
            label = (button.inner_text(timeout=500) or "").strip()
            if pattern.search(label):
                return button
        except PlaywrightError:
            continue
    return None


def open_harbordesk(page: Page, args: argparse.Namespace, report: SmokeReport, output_dir: Path) -> None:
    page.goto(absolutize(args.base_url, args.ui_path), wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle", timeout=args.timeout_ms)
    screenshot(page, output_dir, report, "harbordesk-initial")
    if page.locator("ix-harbordesk, .harbordesk-page").count() > 0:
        report.harbordesk_loaded = True
    else:
        add_issue(
            report,
            "blocker",
            "load",
            "HarborDesk root component was not found",
            "The page loaded, but neither ix-harbordesk nor .harbordesk-page is present.",
            {"url": redact_url(page.url), "title": page.title()},
        )


def click_tab(page: Page, tab_id: str, pattern: re.Pattern[str], args: argparse.Namespace) -> bool:
    nav = page.locator("nav.tab-strip").first
    candidates = [nav.get_by_role("button", name=pattern).first, page.get_by_role("button", name=pattern).first]
    for candidate in candidates:
        try:
            if candidate.count() > 0 and candidate.is_visible(timeout=1_000):
                candidate.click()
                page.wait_for_load_state("networkidle", timeout=args.timeout_ms)
                return True
        except PlaywrightError:
            continue
    return False


def inspect_tab(page: Page, tab_id: str, args: argparse.Namespace, report: SmokeReport, output_dir: Path) -> None:
    if not click_tab(page, tab_id, TAB_PATTERNS[tab_id], args):
        report.tab_results[tab_id] = "missing"
        add_issue(report, "high", tab_id, "Tab button not found", f"Could not locate tab matching {TAB_PATTERNS[tab_id].pattern}.")
        return

    page.wait_for_timeout(300)
    report.tab_results[tab_id] = "opened"
    screenshot(page, output_dir, report, f"tab-{tab_id}")
    report.disabled_buttons[tab_id] = disabled_button_labels(page)
    report.overflow_candidates[tab_id] = overflow_candidates(page, args.max_overflow)

    if report.overflow_candidates[tab_id]:
        add_issue(
            report,
            "medium",
            tab_id,
            "Possible layout overflow detected",
            "One or more visible elements have scroll dimensions larger than their client dimensions.",
            {"count": len(report.overflow_candidates[tab_id])},
        )

    if tab_id == "im":
        inspect_im(page, args, report)
    elif tab_id == "models":
        inspect_models(page, args, report)
    elif tab_id == "devices":
        inspect_devices(page, args, report)
    elif tab_id == "system":
        inspect_system_integration(page, report)
    scroll_harbordesk_content(page, "top")


def disabled_button_labels(page: Page) -> list[str]:
    return page.evaluate(
        """() => Array.from(document.querySelectorAll('button:disabled'))
          .map((button) => (button.innerText || button.textContent || '').trim())
          .filter(Boolean)
          .slice(0, 40)""",
    )


def overflow_candidates(page: Page, limit: int) -> list[dict[str, Any]]:
    return page.evaluate(
        """(limit) => Array.from(document.querySelectorAll('body *'))
          .filter((element) => {
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return false;
            const rect = element.getBoundingClientRect();
            if (rect.width < 24 || rect.height < 10) return false;
            const style = window.getComputedStyle(element);
            if (style.visibility === 'hidden' || style.display === 'none') return false;
            return element.scrollWidth > Math.ceil(element.clientWidth) + 4;
          })
          .slice(0, limit)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            className: String(element.className || '').slice(0, 120),
            text: (element.innerText || element.textContent || '').trim().slice(0, 160),
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
          }))""",
        limit,
    )


def inspect_im(page: Page, args: argparse.Namespace, report: SmokeReport) -> None:
    for platform in ["weixin", "feishu"]:
        card = card_by_heading(page, re.compile(platform, re.I))
        if card is None:
            add_issue(report, "high", "im", f"{platform} connector card missing", "The IM tab did not render the expected connector card.")
            continue
        setup = card.get_by_role("link", name=re.compile(rf"^(open setup|{OPEN_SETUP_ZH})$", re.I)).first
        if setup.count() == 0:
            if platform == "weixin":
                report.setup_urls[platform] = "not-exposed"
                continue
            add_issue(report, "high", "im", f"{platform} setup link missing", "The connector card has no Open setup link.")
            continue
        href = setup.get_attribute("href") or ""
        report.setup_urls[platform] = redact_url(href)

    weixin_url = report.setup_urls.get("weixin", "")
    feishu_url = report.setup_urls.get("feishu", "")
    if weixin_url and feishu_url and weixin_url == feishu_url:
        add_issue(
            report,
            "high",
            "im",
            "Weixin and Feishu setup URLs are identical",
            "This reproduces the setup routing bug: both connectors enter the same setup page.",
            {"url": weixin_url},
        )
    if "weixin" in report.setup_urls and "?session=" in report.setup_urls["weixin"]:
        add_issue(
            report,
            "high",
            "im",
            "Weixin setup URL looks like a Feishu session URL",
            "Weixin should use the QR/static setup entry rather than the top-level Feishu setup session.",
            {"url": report.setup_urls["weixin"]},
        )
    if "weixin" in report.setup_urls and report.setup_urls["weixin"].endswith("/setup/qr"):
        add_issue(
            report,
            "high",
            "im",
            "Weixin setup URL opens the Feishu QR page",
            "Current HarborGate /setup/qr is the Feishu mobile setup page; HarborDesk must not present it as Weixin setup.",
            {"url": report.setup_urls["weixin"]},
        )
    if args.open_setup_links:
        open_setup_page(page, "weixin", report)
        open_setup_page(page, "feishu", report)


def open_setup_page(page: Page, platform: str, report: SmokeReport) -> None:
    card = card_by_heading(page, re.compile(platform, re.I))
    if card is None:
        return
    link = card.get_by_role("link", name=re.compile(rf"^(open setup|{OPEN_SETUP_ZH})$", re.I)).first
    if link.count() == 0:
        return
    try:
        with page.expect_popup(timeout=4_000) as popup_info:
            link.click()
        popup = popup_info.value
        popup.wait_for_load_state("domcontentloaded", timeout=10_000)
        report.setup_urls[f"{platform}_opened"] = redact_url(popup.url)
        popup.close()
    except PlaywrightTimeoutError:
        # Some builds may open same-tab despite target=_blank.
        try:
            link.click()
            page.wait_for_load_state("domcontentloaded", timeout=10_000)
            report.setup_urls[f"{platform}_opened"] = redact_url(page.url)
            page.go_back(wait_until="domcontentloaded", timeout=10_000)
        except PlaywrightError as error:
            add_issue(report, "medium", "im", f"{platform} setup page did not open", str(error))
    except PlaywrightError as error:
        add_issue(report, "medium", "im", f"{platform} setup page did not open", str(error))


def card_by_heading(page: Page, heading: re.Pattern[str]) -> Any | None:
    cards = page.locator("mat-card, .settings-card")
    for index in range(cards.count()):
        card = cards.nth(index)
        try:
            titles = card.locator("mat-card-title, h1, h2, h3").all_inner_texts()
            if any(heading.search(title.strip()) for title in titles):
                return card
        except PlaywrightError:
            continue
    return None


def inspect_models(page: Page, args: argparse.Namespace, report: SmokeReport) -> None:
    edit = first_button_by_text(page, re.compile(r"^(Switch\s*/\s*edit|Edit)$", re.I))
    if edit is None:
        if page.get_by_text(re.compile(r"No model endpoints", re.I)).count() == 0:
            add_issue(report, "high", "models", "Model endpoint edit button missing", "No endpoint switch/edit action was found.")
        return

    edit.click()
    page.wait_for_timeout(300)
    scroll_harbordesk_content(page, "bottom")
    model_text = page_text(page)
    if not re.search(r"(Save Endpoint|Add Endpoint|Model Endpoints|Endpoint kind)", model_text, re.I):
        add_issue(
            report,
            "high",
            "models",
            "Edit button did not enter visible edit mode",
            "Clicking Switch / edit should expose the endpoint form or endpoint management section.",
        )

    if args.allow_model_health_test:
        health = page.get_by_role("button", name=re.compile(r"Health Test", re.I)).first
        if health.count() > 0 and health.is_enabled():
            health.click()
            page.wait_for_load_state("networkidle", timeout=args.timeout_ms)

    if not re.search(r"(Available to download|Download|Manual options|Local model downloads)", model_text, re.I):
        add_issue(report, "medium", "models", "Model download action missing", "The Models tab did not expose the local model download area.")


def inspect_devices(page: Page, args: argparse.Namespace, report: SmokeReport) -> None:
    scroll_harbordesk_content(page, "bottom")
    required_patterns = [
        (r"Run Scan", "Run Scan"),
        (r"Add Device", "Add Device"),
        (r"(Set default|Default camera|selected camera)", "Set Default"),
        (r"(Save credentials|Credentials)", "Save Credentials"),
    ]
    if args.allow_camera_actions:
        required_patterns.extend(
            [
                (r"(Validate|validation|Run validation)", "Validate"),
                (r"Check RTSP", "Check RTSP"),
                (r"(Snapshot test|Snapshot)", "Snapshot"),
                (r"(Create share link|Create Link|share links)", "Create Link"),
            ],
        )
    visible_text = page_text(page)
    for pattern, label in required_patterns:
        if not re.search(pattern, visible_text, re.I):
            add_issue(report, "medium", "devices", f"Expected action missing: {label}", "The Connected Devices tab may not expose the full management workflow.")

    if not args.allow_camera_actions:
        return

    for button_name in [r"Check RTSP", r"Snapshot", r"Create Link"]:
        button = page.get_by_role("button", name=re.compile(button_name, re.I)).first
        if button.count() > 0 and button.is_enabled():
            button.click()
            page.wait_for_load_state("networkidle", timeout=args.timeout_ms)

    revoke = page.get_by_role("button", name=re.compile(r"Revoke", re.I)).first
    if revoke.count() > 0 and revoke.is_enabled():
        revoke.click()
        page.wait_for_load_state("networkidle", timeout=args.timeout_ms)


def inspect_system_integration(page: Page, report: SmokeReport) -> None:
    visible_text = "\n".join(safe_texts(page, "body"))
    expected = ["Storage", "Files", "Jobs", "Alerts", "Services"]
    missing = [item for item in expected if item.lower() not in visible_text.lower()]
    if missing:
        add_issue(
            report,
            "medium",
            "system",
            "System Integration lacks expected HarborOS surfaces",
            "The tab should make HarborOS entry, storage/files, jobs/alerts, and services capabilities understandable.",
            {"missing": missing},
        )

    risky_controls = page.get_by_role("button", name=re.compile(r"(RTSP|Camera|Snapshot|Share Link)", re.I))
    if risky_controls.count() > 0:
        add_issue(
            report,
            "high",
            "system",
            "AIoT controls are present in System Integration",
            "Camera/RTSP controls must stay in Connected Devices, not HarborOS System Domain.",
            {"count": risky_controls.count()},
        )


def validate_global_network(report: SmokeReport) -> None:
    if report.console_errors:
        add_issue(report, "high", "console", "Console errors or warnings were recorded", "See report.console_errors for exact messages.", {"count": len(report.console_errors)})
    if report.network_failures:
        add_issue(report, "high", "network", "Network request failures were recorded", "See report.network_failures for exact requests.", {"count": len(report.network_failures)})
    if report.api_failures:
        add_issue(report, "high", "api", "HarborDesk API returned 4xx/5xx", "The UI should not have unexpected /api/harbordesk failures during smoke.", {"count": len(report.api_failures)})
    if report.direct_admin_api_requests:
        add_issue(report, "high", "api", "UI made direct requests to port 4174", "Customer-facing HarborDesk must use same-origin /api/harbordesk/*.", {"count": len(report.direct_admin_api_requests)})


def check_original_webui(page: Page, args: argparse.Namespace, report: SmokeReport, output_dir: Path) -> None:
    page.goto(absolutize(args.base_url, "/ui/"), wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle", timeout=args.timeout_ms)
    screenshot(page, output_dir, report, "harboros-ui-home")
    icon_response = page.context.request.get(absolutize(args.base_url, "/ui/assets/tn-icons/sprite.svg"), timeout=args.timeout_ms)
    if icon_response.status >= 400:
        add_issue(
            report,
            "high",
            "webui",
            "HarborOS icon sprite is not reachable",
            "Missing icon assets are a known regression risk for native HarborDesk bundles.",
            {"status": icon_response.status},
        )


def run_smoke(args: argparse.Namespace) -> SmokeReport:
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    report = SmokeReport(
        base_url=args.base_url,
        ui_path=args.ui_path,
        started_at=now_label(),
        mode=args.mode,
    )

    with sync_playwright() as playwright:
        browser: Browser = playwright.chromium.launch(headless=not args.headful)
        context: BrowserContext = browser.new_context(viewport={"width": args.width, "height": args.height})
        page = context.new_page()
        attach_observers(page, report)
        try:
            maybe_login(page, args, report)
            if not any(issue.area == "login" and issue.severity == "blocker" for issue in report.issues):
                check_original_webui(page, args, report, output_dir)
                open_harbordesk(page, args, report, output_dir)
                for tab_id in TAB_PATTERNS:
                    inspect_tab(page, tab_id, args, report, output_dir)
                validate_global_network(report)
            else:
                screenshot(page, output_dir, report, "login-blocker")
        except Exception as error:  # noqa: BLE001 - this is a smoke runner report boundary.
            add_issue(
                report,
                "blocker",
                "runner",
                "Runner crashed",
                str(error),
                {"traceback": traceback.format_exc()},
            )
        finally:
            browser.close()
            write_reports(report, output_dir)
    return report


def run_self_test(args: argparse.Namespace) -> int:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=not args.headful)
        page = browser.new_page()
        page.goto("data:text/html,<title>ok</title><h1>ok</h1>", wait_until="domcontentloaded")
        ok = page.title() == "ok"
        print(f"playwright_self_test={'ok' if ok else 'failed'}")
        print(f"chromium_executable={playwright.chromium.executable_path}")
        browser.close()
    return 0 if ok else 1


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run HarborDesk live smoke checks with Python Playwright.")
    parser.add_argument("--base-url", default=os.getenv("HARBORDESK_SMOKE_BASE_URL", "http://192.168.3.182"))
    parser.add_argument("--ui-path", default=os.getenv("HARBORDESK_SMOKE_UI_PATH", "/ui/harbordesk"))
    parser.add_argument("--username", default=os.getenv("HARBORDESK_SMOKE_USERNAME"))
    parser.add_argument("--password", default=os.getenv("HARBORDESK_SMOKE_PASSWORD"))
    parser.add_argument("--output-dir", default=os.getenv("HARBORDESK_SMOKE_OUTPUT_DIR", f"artifacts/harbordesk-live-smoke/{timestamp_for_path()}"))
    parser.add_argument("--timeout-ms", type=int, default=int(os.getenv("HARBORDESK_SMOKE_TIMEOUT_MS", "30000")))
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--height", type=int, default=1000)
    parser.add_argument("--max-overflow", type=int, default=20)
    parser.add_argument("--headful", action="store_true")
    parser.add_argument("--self-test", action="store_true", help="Only verify that Python Playwright can launch Chromium.")
    parser.add_argument("--mode", choices=["read-only", "safe-actions"], default="read-only")
    parser.add_argument("--skip-setup-links", dest="open_setup_links", action="store_false", default=True)
    parser.add_argument("--allow-model-health-test", action="store_true")
    parser.add_argument("--allow-camera-actions", action="store_true")
    return parser


def main(argv: list[str]) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    args.base_url = clean_base_url(args.base_url)

    if args.self_test:
        return run_self_test(args)

    if args.mode == "safe-actions":
        args.allow_model_health_test = True
        args.allow_camera_actions = True

    report = run_smoke(args)
    issue_counts: dict[str, int] = {}
    for issue in report.issues:
        issue_counts[issue.severity] = issue_counts.get(issue.severity, 0) + 1
    print(json.dumps({"output_dir": str(Path(args.output_dir).resolve()), "issue_counts": issue_counts}, ensure_ascii=False))
    return 1 if any(issue.severity in {"blocker", "high"} for issue in report.issues) else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
