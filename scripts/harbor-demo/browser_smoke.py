#!/usr/bin/env python3
"""Run real HarborOS Assistant browser gates with native Chrome.

Credentials are read only from HARBOR_DEMO_USERNAME/HARBOR_DEMO_PASSWORD.
No HAR, trace, storage state, WebSocket payload, Authorization header, or /state
response is saved. The report uses an explicit API field allowlist.
"""
import argparse
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import quote, urljoin, urlsplit, urlunsplit

from playwright.async_api import Error as PlaywrightError, async_playwright, expect


PREFIX = '/api/harbor-beacon'
SEARCH = PREFIX + '/knowledge/search'
VISION = PREFIX + '/inference/v1/vision/chat/completions'
TRANSCRIBE = PREFIX + '/inference/v1/audio/transcriptions'
SPEECH = PREFIX + '/inference/v1/audio/speech'
CAPABILITIES = PREFIX + '/models/capabilities'
WIDTHS = (320, 390, 768, 1024, 1440)
TOOLS = ['Sources and search options', 'Time range', 'New conversation', 'Conversation history']
SAFE_PATHS = {
    SEARCH, VISION, TRANSCRIBE, SPEECH, CAPABILITIES,
    PREFIX + '/models/endpoints', PREFIX + '/models/runtimes',
    PREFIX + '/models/local-downloads', PREFIX + '/inference/healthz',
    PREFIX + '/knowledge/settings', PREFIX + '/knowledge/index/status',
    PREFIX + '/rag/readiness', PREFIX + '/knowledge/conversations',
}
GATES = {'desktop_entry', 'tools_keyboard', 'draft_routes', 'initial_loading_retry', 'models_truth',
         'data_sources', 'ordinary_chat', 'rag_citations', 'history_reload', 'vlm_image',
         'asr_en', 'asr_zh', 'tts_playback'} | {'layout_' + str(width) for width in WIDTHS}
SAFE_METADATA = ('runtime_backend_kind', 'runtime_device', 'base_url', 'persistent',
                 'last_test_status', 'last_test_http_status', 'health_status', 'http_status')


def qualified_model_endpoints(endpoints, expected_model=None):
    qualified = []
    for endpoint in endpoints:
        if not endpoint or endpoint.get('model_kind') != 'llm' or endpoint.get('status') != 'active':
            continue
        metadata = endpoint.get('metadata') or {}
        last_test = metadata.get('last_test') or {}
        device = str(metadata.get('runtime_device', '')).lower()
        if (endpoint.get('endpoint_kind') != 'local'
                or metadata.get('runtime_backend_kind') != 'llama.cpp'
                or 'w7900' not in device or 'vulkan' not in device
                or metadata.get('persistent') is not True
                or last_test.get('ok') is not True
                or (last_test.get('details') or {}).get('http_status') != 200):
            continue
        if expected_model and expected_model.lower() not in str(endpoint.get('model_name', '')).lower():
            continue
        qualified.append(endpoint)
    return qualified


class GateBlocked(Exception):
    """An earlier required gate did not supply a usable result."""


def clipped(value, limit=4000):
    return value[:limit] if isinstance(value, str) else None


def safe_url(value):
    parts = urlsplit(value)
    hostname = parts.hostname or ''
    if ':' in hostname and not hostname.startswith('['):
        hostname = '[' + hostname + ']'
    authority = hostname + (':' + str(parts.port) if parts.port else '')
    return urlunsplit((parts.scheme, authority, parts.path, '', ''))


def scalar_fields(value, keys):
    if not isinstance(value, dict):
        return {}
    return {key: (clipped(value[key]) if isinstance(value[key], str) else value[key])
            for key in keys if key in value and isinstance(value[key], (str, bool, int, float, type(None)))}


def safe_model(value):
    if isinstance(value, str):
        return clipped(value)
    if not isinstance(value, dict):
        return None
    result = scalar_fields(value, ('name', 'model_name', 'model_endpoint_id', 'model_kind', 'endpoint_kind',
                                  'provider_key', 'status', 'available', 'answer_generation_enabled', 'latency_ms') + SAFE_METADATA)
    metadata = scalar_fields(value.get('metadata'), SAFE_METADATA)
    for fields in (result, metadata):
        if isinstance(fields.get('base_url'), str):
            fields['base_url'] = safe_url(fields['base_url'])
    last_test = (value.get('metadata') or {}).get('last_test') if isinstance(value.get('metadata'), dict) else None
    if isinstance(last_test, dict):
        metadata['last_test'] = scalar_fields(last_test, ('ok', 'status', 'tested_at'))
        metadata['last_test']['details'] = scalar_fields(last_test.get('details'), ('http_status',))
    if metadata:
        result['metadata'] = metadata
    return result


def safe_messages(value):
    if not isinstance(value, list):
        return []
    return [clipped(item, 600) for item in value[:30] if isinstance(item, str)]


def project(path, value):
    """Do not broaden this to arbitrary response bodies or metadata dictionaries."""
    if not isinstance(value, dict):
        return {'response_kind': type(value).__name__}
    result = scalar_fields(value, ('status', 'degraded', 'degraded_reason', 'total_matches',
                                  'conversation_id', 'generated_at', 'checked_at'))
    error = value.get('error')
    if isinstance(error, str):
        result['error'] = clipped(error, 600)
    elif isinstance(error, dict):
        result['error'] = scalar_fields(error, ('code', 'message'))
    for key in ('blockers', 'warnings'):
        if isinstance(value.get(key), list):
            result[key] = safe_messages(value[key])
    if path == SEARCH:
        reply = value.get('reply_pack') or {}
        result['reply_pack'] = {'summary': clipped(reply.get('summary')),
                                'citations': [scalar_fields(item, ('path', 'source_path', 'title', 'citation_id',
                                                                   'modality', 'line_start', 'line_end'))
                                              if isinstance(item, dict) else clipped(item, 300)
                                              for item in reply.get('citations', [])[:20]]}
        result['model'] = safe_model(value.get('model'))
    elif path == VISION:
        result['model'] = safe_model(value.get('model'))
        result['answers'] = [clipped((item.get('message') or {}).get('content'))
                             for item in value.get('choices', [])[:3] if isinstance(item, dict)]
    elif path == TRANSCRIBE:
        result.update(scalar_fields(value, ('text', 'language')))
    elif path.endswith('/models/endpoints'):
        result['endpoints'] = [safe_model(item) for item in value.get('endpoints', [])[:30]]
    elif path.endswith('/models/runtimes'):
        result['runtimes'] = [scalar_fields(item, ('runtime_id', 'display_name', 'runtime_kind', 'status',
                                                  'installed', 'active', 'enabled', 'managed'))
                              for item in value.get('runtimes', [])[:30]]
    elif path == CAPABILITIES:
        capabilities = value.get('capabilities', [])
        if isinstance(capabilities, dict):
            capabilities = list(capabilities.values())
        result['capabilities'] = [scalar_fields(item, ('capability_id', 'model_kind', 'label', 'status',
                                                      'ready', 'configured', 'next_action'))
                                  for item in capabilities[:30]] if isinstance(capabilities, list) else []
    elif path.endswith('/knowledge/settings'):
        result['source_roots'] = [scalar_fields(item, ('root_id', 'label', 'path', 'enabled', 'last_indexed_at'))
                                  for item in value.get('source_roots', [])[:30]]
    elif path.endswith('/knowledge/conversations'):
        result['conversations'] = [scalar_fields(item, ('conversation_id', 'title', 'turn_count', 'updated_at'))
                                   for item in value.get('conversations', [])[:30]]
    elif '/knowledge/conversations/' in path:
        result['turn_count'] = len(value.get('turns', []))
    elif path.endswith('/knowledge/index/status'):
        result.update(scalar_fields(value, ('document_count', 'image_count', 'chunk_count', 'indexed_count')))
    elif path.endswith('/rag/readiness') or path.endswith('/inference/healthz'):
        result.update(scalar_fields(value, ('ready', 'answer_ready', 'retrieval_ready', 'llm_ready',
                                            'embedder_ready', 'runtime_backend_kind', 'runtime_device')))
        if isinstance(value.get('embedding_model'), dict):
            result['embedding_model'] = scalar_fields(value['embedding_model'], ('status', 'ready', 'summary'))
        components = value.get('components', [])
        if isinstance(components, list):
            result['components'] = [scalar_fields(item, ('id', 'component_id', 'status', 'ready', 'summary'))
                                     for item in components[:20]]
    return result


class BrowserSmoke:
    def __init__(self, args, username, password):
        self.args = args
        self.username = username
        self.password = password
        self.page = None
        self.report = {'started_at': datetime.now(timezone.utc).isoformat(),
                       'target': safe_url(args.url), 'browser': 'native Chrome',
                       'gates': [], 'api': [], 'injections': [],
                       'scope': 'selected' if args.only else 'full',
                       'selected_gates': sorted(args.only) if args.only else sorted(GATES),
                       'expected_model': getattr(args, 'expected_model', None),
                       'evidence_policy': 'Allowlisted response fields only; no state/tokens/headers/HAR/trace'}
        self.capture_tasks = set()
        self.posts = []
        self.rag = None
        self.args.output.mkdir(parents=True, exist_ok=True)

    def redact(self, value):
        text = str(value)
        for secret in (self.password, self.username):
            if secret:
                text = text.replace(secret, '[redacted]')
        text = re.sub(r'(?i)(Bearer\s+)[^\s\"\']+', r'\1[redacted]', text)
        return text[:3000]

    def url(self, path):
        return urljoin(self.args.url.rstrip('/') + '/', path)

    def observe(self, response):
        task = asyncio.create_task(self.capture_response(response))
        self.capture_tasks.add(task)
        task.add_done_callback(self.capture_tasks.discard)

    def observe_request(self, request):
        path = urlsplit(request.url).path
        if path.startswith(PREFIX + '/') and request.method not in ('GET', 'HEAD', 'OPTIONS'):
            self.posts.append({'path': path, 'method': request.method})

    async def capture_response(self, response):
        path = urlsplit(response.url).path
        if path not in SAFE_PATHS and not path.startswith(PREFIX + '/knowledge/conversations/'):
            return
        entry = {'path': path, 'method': response.request.method, 'status': response.status,
                 'request_started_at_ms': response.request.timing.get('startTime'),
                 'authorization_header_present': bool(await response.request.header_value('authorization'))}
        try:
            timing = response.request.timing
            entry['timing_ms'] = {key: round(timing[key], 2)
                                  for key in ('responseStart', 'responseEnd', 'requestStart')
                                  if isinstance(timing.get(key), (int, float)) and timing[key] >= 0}
            if timing.get('responseStart', -1) >= 0 and timing.get('requestStart', -1) >= 0:
                entry['ttfb_ms'] = round(timing['responseStart'] - timing['requestStart'], 2)
            headers = await response.all_headers()
            entry['content_type'] = headers.get('content-type', '').split(';')[0]
            if headers.get('x-harbor-smoke'):
                entry['injected'] = headers['x-harbor-smoke']
            if path == SPEECH and response.ok:
                entry['bytes'] = len(await response.body())
            else:
                try:
                    entry['data'] = project(path, await response.json())
                except json.JSONDecodeError:
                    if response.status in (401, 403):
                        reason = self.redact((await response.text())[:600])
                        entry['error_text'] = re.sub(r'[A-Za-z0-9_-]{32,}', '[redacted-long-value]', reason)
                    else:
                        raise
        except Exception as error:
            entry['capture_error_kind'] = type(error).__name__
        self.report['api'].append(entry)

    async def screenshot(self, name):
        filename = re.sub(r'[^a-zA-Z0-9_-]', '-', name) + '.png'
        path = self.args.output / filename
        await self.page.screenshot(path=str(path), full_page=False,
                                   mask=[self.page.locator('ix-signin-form input, input[type="password"]')])
        return filename

    async def gate(self, name, operation):
        if self.args.only and name not in self.args.only:
            return
        started = time.perf_counter()
        entry = {'gate': name}
        print('RUN ' + name, flush=True)
        try:
            entry['facts'] = await operation() or {}
            entry['status'] = 'passed'
        except GateBlocked as error:
            entry.update(status='blocked', error=self.redact(error))
        except Exception as error:
            entry.update(status='failed', error=self.redact(error), error_kind=type(error).__name__)
            try:
                entry['screenshot'] = await self.screenshot(name + '-failed')
            except Exception:
                pass
        entry['elapsed_ms'] = round((time.perf_counter() - started) * 1000, 1)
        self.report['gates'].append(entry)
        print(entry['status'].upper() + ' ' + name, flush=True)
        self.write_report()

    def write_report(self):
        gates = self.report['gates']
        self.report['overall'] = ('passed' if gates and all(item['status'] == 'passed' for item in gates)
                                  else 'partial' if any(item['status'] == 'passed' for item in gates) else 'failed')
        self.report['finished_at'] = datetime.now(timezone.utc).isoformat()
        (self.args.output / 'report.json').write_text(json.dumps(self.report, indent=2, ensure_ascii=False), encoding='utf-8')

    async def login(self):
        await self.page.goto(self.args.url, wait_until='domcontentloaded')
        await self.page.locator('ix-signin-form input, ix-admin-layout').first.wait_for()
        if not await self.page.locator('ix-admin-layout').is_visible():
            await self.page.locator('ix-input[formcontrolname="username"] input').fill(self.username)
            await self.page.locator('ix-input[formcontrolname="password"] input').fill(self.password)
            await self.page.locator('ix-signin-form button[type="submit"]').click()
        await self.page.locator('ix-admin-layout').wait_for(timeout=self.args.timeout * 1000)
        await self.composer().wait_for()
        return {'authenticated': True, 'screenshot': await self.screenshot('authenticated-desktop')}

    def composer(self):
        return self.page.locator('.assistant-composer')

    def prompt(self):
        return self.composer().locator('textarea[name="assistantPrompt"]')

    async def show_page(self):
        close = self.page.locator('.assistant-results button[aria-label="Close assistant results"]')
        if await close.is_visible():
            await close.click()

    async def close_options(self):
        close = self.page.locator('button[aria-label="Close conversation options"]')
        if await close.is_visible():
            try:
                await close.click(timeout=5000)
            except PlaywrightError:
                if await close.is_visible():
                    raise
            await expect(close).to_be_hidden()

    async def desktop(self):
        await self.show_page()
        await self.close_options()
        back = self.page.locator('a[routerlink="/desktop"]:visible').first
        if await back.is_visible():
            await back.click()
        elif not await self.page.locator('ix-desktop').is_visible():
            await self.page.goto(self.url('desktop'), wait_until='domcontentloaded')
        await self.page.locator('ix-desktop').wait_for()
        await self.composer().wait_for()

    async def assistant(self):
        await self.show_page()
        await self.close_options()
        if not await self.page.locator('ix-harbor-assistant').is_visible():
            await self.desktop()
            await self.page.locator('ix-desktop').get_by_role('button', name='Harbor Assistant', exact=True).click()
        await self.page.locator('ix-harbor-assistant').wait_for()

    async def ai_tab(self, name):
        await self.assistant()
        await self.page.locator(f'.workspace-navigation [data-section="{name}"]').click()
        selector = '.model-capability-list' if name == 'models' else '.sources-settings-panel'
        await self.page.locator(selector).first.wait_for()

    async def desktop_entry(self):
        await self.desktop()
        entry = self.page.locator('ix-desktop').get_by_role('button', name='Harbor Assistant', exact=True)
        await expect(entry).to_be_visible()
        await entry.click()
        await self.page.locator('ix-harbor-assistant').wait_for()
        return {'entry': 'Desktop Harbor Assistant', 'screenshot': await self.screenshot('desktop-entry')}

    async def layout(self, width):
        await self.page.set_viewport_size({'width': width, 'height': self.args.height})
        layouts = []
        for name in ('desktop', 'models', 'sources'):
            if name == 'desktop':
                await self.desktop()
            else:
                await self.ai_tab(name)
                await expect(self.page.locator('.ai-settings-subtabs')).not_to_contain_text(
                    'Loading', timeout=self.args.timeout * 1000)
            await self.prompt().wait_for()
            await self.page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            metrics = await self.page.evaluate("""() => {
              const composer = document.querySelector('.assistant-composer');
              const workspace = document.querySelector('.assistant-page-workspace');
              const prompt = composer?.querySelector('textarea');
              const footer = document.querySelector('ix-topbar .topbar-mobile-footer');
              const navigation = document.querySelector('.assistant-mobile-home');
              if (!composer || !workspace || !prompt) return null;
              const c = composer.getBoundingClientRect();
              const w = workspace.getBoundingClientRect();
              const p = prompt.getBoundingClientRect();
              const f = footer?.getBoundingClientRect();
              const n = navigation?.getBoundingClientRect();
              const navigationHit = n && document.elementFromPoint(n.x+n.width/2,n.y+n.height/2);
              const hit = document.elementFromPoint(p.x + p.width / 2, p.y + p.height / 2);
              return {composer: {x:c.x,y:c.y,width:c.width,height:c.height,bottom:c.bottom,right:c.right},
                      workspace: {bottom:w.bottom,width:w.width,height:w.height},
                      viewport: {width:innerWidth,height:innerHeight},
                      composer_count:document.querySelectorAll('.assistant-composer').length,
                      input_unobscured:!!hit && composer.contains(hit),
                      mobile_footer: f && getComputedStyle(footer).position === 'fixed'
                        ? {top:f.top,bottom:f.bottom,right:f.right,width:f.width,height:f.height} : null,
                      mobile_navigation: n && getComputedStyle(navigation).display !== 'none'
                        ? {top:n.top,bottom:n.bottom,right:n.right,width:n.width,
                           unobscured:!!navigationHit && navigation.contains(navigationHit)} : null,
                      document_width:document.documentElement.scrollWidth};
            }""")
            assert metrics and metrics['composer_count'] == 1, 'Expected one global Composer'
            c, w = metrics['composer'], metrics['workspace']
            assert c['x'] >= -1 and c['right'] <= width + 1, 'Composer extends outside viewport'
            assert c['bottom'] <= self.args.height + 1 and c['y'] >= 0, 'Composer extends outside viewport height'
            assert w['bottom'] <= c['y'] + 1, 'Page workspace overlaps Composer'
            assert metrics['input_unobscured'], 'Composer text input is obscured'
            assert metrics['document_width'] <= width + 2, 'Horizontal document overflow'
            if width < 768:
                footer, navigation = metrics['mobile_footer'], metrics['mobile_navigation']
                assert footer and c['bottom'] <= footer['top'] + 1, 'Composer obscures native OS footer controls'
                assert footer['right'] <= width + 1, 'Native OS footer exceeds viewport width'
                assert navigation and navigation['unobscured'], 'Compact Desktop navigation is missing or obscured'
                assert navigation['right'] <= width + 1 and navigation['bottom'] <= 104, 'Desktop navigation exceeds top bar'
            layouts.append({'route': name, 'metrics': metrics,
                            'screenshot': await self.screenshot('layout-' + str(width) + '-' + name)})
        return {'width': width, 'routes': layouts}

    async def choose_tool(self, index):
        await self.close_options()
        trigger = self.composer().get_by_role('button', name='Add to conversation', exact=True)
        await trigger.focus()
        await self.page.keyboard.press('Enter')
        menu = self.page.get_by_role('menu')
        await menu.wait_for()
        items = menu.get_by_role('menuitem')
        assert await items.count() == 4, 'The + menu must offer exactly four tools'
        labels = [text.strip() for text in await items.all_text_contents()]
        assert labels == TOOLS, 'Unexpected + menu tools: ' + repr(labels)
        await self.page.keyboard.press('Home')
        for _ in range(index):
            await self.page.keyboard.press('ArrowDown')
        await self.page.keyboard.press('Enter')
        await menu.wait_for(state='hidden')
        return labels

    async def tools(self):
        await self.page.set_viewport_size({'width': 1440, 'height': self.args.height})
        await self.assistant()
        counts = []
        for index in range(4):
            before = len(self.posts)
            labels = await self.choose_tool(index)
            if index in (0, 1, 3):
                await self.page.locator('.assistant-options').wait_for()
            await self.page.wait_for_timeout(150)
            assert len(self.posts) == before, 'Selecting a + tool executed an API mutation'
            counts.append({'tool': labels[index], 'mutations': 0})
            await self.close_options()
        return {'tools': counts, 'keyboard': 'Enter/Home/ArrowDown/Enter',
                'screenshot': await self.screenshot('tools-no-action')}

    async def mode(self, mode, source=None):
        await self.choose_tool(0)
        options = self.page.locator('.assistant-options')
        await options.locator('label').filter(has_text='Conversation mode').locator('select').select_option(mode)
        checkboxes = options.locator('.assistant-source input[type="checkbox"]')
        for index in range(await checkboxes.count()):
            await checkboxes.nth(index).uncheck()
        if source:
            source_label = options.locator('.assistant-source').filter(has_text='Demo Documents')
            assert await source_label.count() == 1, 'The synthetic Demo Documents source is not configured'
            await source_label.locator('input').check()
        await options.locator('label').filter(has_text='Result type').locator('select').select_option('text' if source else 'all')
        await self.close_options()

    async def draft_persistence(self):
        await self.assistant()
        await self.mode('off')
        draft = 'Draft persists across HarborOS pages — smoke'
        await self.prompt().fill(draft)
        visits = []
        for name in ('desktop', 'models', 'sources'):
            await (self.desktop() if name == 'desktop' else self.ai_tab(name))
            await expect(self.prompt()).to_have_value(draft)
            await expect(self.composer().locator('.assistant-context-chips')).to_contain_text('Ordinary chat')
            visits.append(name)
        await self.prompt().fill('')
        return {'routes': visits, 'draft_and_mode_preserved': True,
                'screenshot': await self.screenshot('draft-persists')}

    async def initial_loading(self):
        held, release = asyncio.Event(), asyncio.Event()
        attempts = 0
        route_failure = None
        active_handlers = set()

        async def intercept(route):
            nonlocal attempts, route_failure
            handler = asyncio.current_task()
            active_handlers.add(handler)
            attempts += 1
            try:
                if attempts == 1:
                    self.report['injections'].append({'path': CAPABILITIES, 'status': 500, 'purpose': 'transient retry'})
                    await route.fulfill(status=500, content_type='application/json',
                                        headers={'x-harbor-smoke': 'transient-capabilities'},
                                        body=json.dumps({'error': 'Browser smoke transient failure'}))
                else:
                    # Hold the real retry before sending it, then let Chrome
                    # receive the original response. Each route is handled once.
                    held.set()
                    await asyncio.wait_for(release.wait(), timeout=30)
                    await route.continue_()
            except Exception as error:
                route_failure = self.redact(error)
                held.set()
            finally:
                active_handlers.discard(handler)

        pattern = '**' + CAPABILITIES
        await self.page.route(pattern, intercept)
        try:
            await self.page.goto(self.url('harbor-assistant?tab=settings&section=ai&focus=models'),
                                 wait_until='domcontentloaded')
            await asyncio.wait_for(held.wait(), timeout=min(30, self.args.timeout))
            assert not route_failure, 'The capability retry route failed: ' + str(route_failure)
            toolbar = self.page.locator('.ai-settings-subtabs')
            await toolbar.wait_for()
            pending = await toolbar.inner_text()
            assert not re.search(r'0\s*/\s*4\s+ready', pending, re.I), 'False 0/4 Ready during API loading'
            assert re.search(r'loading', pending, re.I), 'Missing loading label while real capability request is held'
            screenshot = await self.screenshot('loading-retry-before-capabilities')
            async with self.page.expect_response(lambda response: urlsplit(response.url).path == CAPABILITIES
                                                  and response.status == 200,
                                                  timeout=self.args.timeout * 1000) as completed:
                release.set()
            actual = await completed.value
            await actual.body()
            assert not route_failure, 'The capability retry route failed: ' + str(route_failure)
            await expect(toolbar).not_to_contain_text('Loading', timeout=self.args.timeout * 1000)
            return {'attempts': attempts, 'injected_500': True, 'actual_response_delayed': True,
                    'loading_text': pending, 'screenshot': screenshot}
        finally:
            release.set()
            await self.page.unroute(pattern, intercept)
            if active_handlers:
                await asyncio.wait_for(asyncio.gather(*list(active_handlers), return_exceptions=True), timeout=10)

    async def model_truth(self):
        await self.ai_tab('models')
        await expect(self.page.locator('.ai-settings-subtabs')).not_to_contain_text('Loading',
                                                                                  timeout=self.args.timeout * 1000)
        if self.capture_tasks:
            await asyncio.gather(*list(self.capture_tasks), return_exceptions=True)
        endpoint_response = next((item for item in reversed(self.report['api'])
                                  if item['path'] == PREFIX + '/models/endpoints' and item['status'] == 200), None)
        endpoints = (endpoint_response or {}).get('data', {}).get('endpoints', [])
        expected_model = getattr(self.args, 'expected_model', None)
        qualified = qualified_model_endpoints(endpoints, expected_model)
        assert qualified, ('No active persistent local llama.cpp/W7900 endpoint with a successful HTTP 200 health test'
                           + (f' for expected model {expected_model}' if expected_model else ''))
        endpoint = qualified[0]
        text = await self.page.locator('.models-tab').inner_text()
        assert 'llama.cpp' in text, 'Models UI does not show the true llama.cpp backend'
        assert 'W7900' in text and 'Vulkan' in text, 'Models UI does not show W7900 Vulkan device'
        assert 'persistent' in text.lower(), 'Models UI does not show runtime persistence'
        return {'llama_cpp': True, 'W7900_Vulkan': True, 'persistent': True, 'active': True, 'health_http_status': 200,
                'endpoint': endpoint,
                'screenshot': await self.screenshot('model-runtime-truth')}

    async def data_sources(self):
        await self.ai_tab('sources')
        await expect(self.page.locator('.sources-settings-panel')).to_contain_text(
            'Demo Documents', timeout=self.args.timeout * 1000)
        text = await self.page.locator('.sources-settings-panel').inner_text()
        return {'synthetic_source_visible': True, 'status_text': clipped(text, 1800),
                'screenshot': await self.screenshot('data-sources-readiness')}

    async def refreshed_model_status(self, request_started_at_ms):
        paths = {CAPABILITIES, PREFIX + '/models/runtimes', PREFIX + '/models/endpoints',
                 PREFIX + '/inference/healthz', PREFIX + '/models/local-downloads', PREFIX + '/rag/readiness'}
        await expect(self.page.locator('.ai-settings-subtabs')).not_to_contain_text(
            'Loading', timeout=min(self.args.timeout, 45) * 1000)
        deadline = time.monotonic() + min(self.args.timeout, 45)
        latest = {}
        while time.monotonic() < deadline:
            for entry in self.report['api']:
                if (entry['method'] == 'GET' and entry['path'] in paths
                        and (entry.get('request_started_at_ms') or 0) >= request_started_at_ms):
                    previous = latest.get(entry['path'])
                    if not previous or entry['request_started_at_ms'] >= previous['request_started_at_ms']:
                        latest[entry['path']] = entry
            if paths.issubset(latest):
                break
            await self.page.wait_for_timeout(100)
        assert paths.issubset(latest), 'Completed RAG did not trigger all six model/readiness GET refreshes'
        assert all(entry['status'] == 200 for entry in latest.values()), 'Post-RAG model status refresh failed'
        capabilities = latest[CAPABILITIES].get('data', {}).get('capabilities', [])
        embedder = next((item for item in capabilities
                         if item.get('capability_id') == 'embedder' or item.get('model_kind') == 'embedder'), None)
        assert embedder and embedder.get('status') == 'ready', 'Real capabilities still report embedding unavailable'
        health = latest[PREFIX + '/inference/healthz'].get('data', {})
        assert health.get('ready') is True, 'Real inference health is unavailable after RAG'
        await expect(self.page.locator('.ai-status-toolbar')).not_to_contain_text('Vector search model required')
        core_ids = {'semantic_router', 'embedder', 'retrieval_answer', 'vlm'}
        core = [item for item in capabilities if item.get('capability_id') in core_ids]
        if len(core) == len(core_ids):
            ready = sum(item.get('status') == 'ready' for item in core)
            await expect(self.page.locator('.ai-settings-subtabs .ai-settings-subtab').nth(1)).to_contain_text(
                str(ready) + '/' + str(len(core)) + ' Ready')
        return {'refreshed_paths': sorted(latest), 'embedder': embedder, 'inference_health': health,
                'rag_readiness': latest[PREFIX + '/rag/readiness'].get('data', {}),
                'model_tab': await self.page.locator('.ai-settings-subtabs .ai-settings-subtab').nth(1).inner_text(),
                'status_toolbar': await self.page.locator('.ai-status-toolbar').inner_text()}

    async def send(self, text=None, expected_mode=None):
        if text is not None:
            await self.prompt().fill(text)
        question = (await self.prompt().input_value()).strip()
        assert question, 'Conversation draft is empty'
        started = time.perf_counter()
        async with self.page.expect_response(lambda response: urlsplit(response.url).path == SEARCH
                                              and response.request.method == 'POST',
                                              timeout=self.args.timeout * 1000) as pending:
            await self.composer().get_by_role('button', name='Send', exact=True).click()
        response = await pending.value
        payload = response.request.post_data_json
        if expected_mode:
            assert payload.get('retrieval_mode') == expected_mode, 'Unexpected Knowledge Search retrieval mode'
        selected_filter = payload.get('filter')
        assert selected_filter in ('all', 'text', 'images', 'videos'), 'Missing literal Knowledge Search filter'
        assert payload.get('include_audio') is (selected_filter in ('all', 'text')), 'Unexpected explicit audio selection'
        assert response.ok, 'Knowledge Search returned HTTP ' + str(response.status)
        body = await response.json()
        summary = (body.get('reply_pack') or {}).get('summary', '').strip()
        model = body.get('model') or {}
        assert isinstance(model, dict) and model.get('available') is True, 'The selected answer model is unavailable'
        assert model.get('answer_generation_enabled') is True, 'Knowledge Search did not enable real answer generation'
        assert not body.get('degraded', False), 'Knowledge Search returned a degraded answer'
        assert summary and summary != question, 'Knowledge Search did not return an assistant answer'
        assert summary != 'The server returned no answer.', 'Missing model answer'
        answer = self.page.locator('.assistant-turn').last.locator('.assistant-answer')
        await expect(answer).to_have_text(summary, timeout=self.args.timeout * 1000)
        return body, {'elapsed_ms': round((time.perf_counter() - started) * 1000, 1),
                      'request_started_at_ms': response.request.timing['startTime'],
                      'summary': clipped(summary), 'conversation_id': body.get('conversation_id'),
                      'model': safe_model(body.get('model'))}, payload

    async def ordinary_chat(self):
        await self.assistant()
        await self.mode('off')
        body, facts, _ = await self.send('Reply exactly: HARBOR CHAT READY', 'off')
        assert 'qwen' in json.dumps(body.get('model', {})).lower(), 'Answer does not identify the real Qwen model'
        facts['screenshot'] = await self.screenshot('ordinary-chat-answer')
        return facts

    async def rag_chat(self):
        await self.ai_tab('sources')
        await self.mode('on', source='demo-documents-209')
        body, facts, payload = await self.send(self.args.rag_query, 'on')
        assert payload.get('source_root_ids') == ['demo-documents-209'], 'RAG did not select the synthetic source'
        summary = (body.get('reply_pack') or {}).get('summary', '')
        citations = (body.get('reply_pack') or {}).get('citations', [])
        assert self.args.rag_expect.lower() in summary.lower(), 'RAG answer is missing the seeded verification code'
        assert len(citations) > 0, 'RAG returned no citations'
        await expect(self.page.locator('.assistant-turn').last.locator('.assistant-citations')).to_be_visible()
        self.rag = body
        facts['readiness_after_answer'] = await self.refreshed_model_status(facts['request_started_at_ms'])
        facts.update(citation_count=len(citations), screenshot=await self.screenshot('rag-answer-citations'))
        return facts

    async def history(self):
        if not self.rag or not self.rag.get('conversation_id'):
            raise GateBlocked('A successful RAG conversation is required for history validation')
        expected_id = self.rag['conversation_id']
        expected_answer = self.rag['reply_pack']['summary'].strip()
        await self.show_page()
        async with self.page.expect_response(lambda response: urlsplit(response.url).path == PREFIX + '/knowledge/conversations'
                                              and response.request.method == 'GET') as pending:
            await self.choose_tool(3)
        listing = await (await pending.value).json()
        matches = [item for item in listing.get('conversations', []) if item.get('conversation_id') == expected_id]
        assert matches, 'Server history does not contain the conversation that just answered'
        title = matches[0].get('title') or expected_id
        item = self.page.locator('.assistant-history-item').filter(has_text=title).first
        await expect(item).to_be_visible()
        detail_path = PREFIX + '/knowledge/conversations/' + quote(expected_id, safe='')
        async with self.page.expect_response(lambda response: urlsplit(response.url).path == detail_path) as detail:
            await item.click()
        assert (await detail.value).ok, 'Conversation history detail could not be loaded'
        await expect(self.page.locator('.assistant-turn').last.locator('.assistant-answer')).to_have_text(expected_answer)
        await self.page.reload(wait_until='domcontentloaded')
        await self.composer().wait_for()
        await expect(self.page.locator('.assistant-turn').last.locator('.assistant-answer')).to_have_text(
            expected_answer, timeout=self.args.timeout * 1000)
        return {'server_conversation_id': expected_id, 'reopened_and_reloaded': True,
                'screenshot': await self.screenshot('history-restored-after-reload')}

    async def multimodal(self):
        await self.ai_tab('models')
        await expect(self.page.locator('.workspace-navigation [data-section="models"]')).to_have_attribute('aria-current', 'page')
        await self.page.locator('.integrated-multimodal-panel').wait_for()

    async def vision(self):
        await self.multimodal()
        image = self.args.samples / 'shapes.png'
        assert image.is_file(), 'Missing local sample shapes.png (set --samples)'
        card = self.page.locator('.multimodal-tool').nth(0)
        await card.locator('input[type="file"]').set_input_files(image)
        await card.locator('textarea').fill('Describe the shapes and their colors in this image.')
        started = time.perf_counter()
        async with self.page.expect_response(lambda response: urlsplit(response.url).path == VISION,
                                              timeout=self.args.timeout * 1000) as pending:
            await card.get_by_role('button', name='Ask about image', exact=True).click()
        response = await pending.value
        assert response.ok, 'VLM returned HTTP ' + str(response.status)
        body = await response.json()
        choices = body.get('choices') or []
        answer = (choices[0].get('message') or {}).get('content', '').strip() if choices else ''
        assert answer, 'VLM endpoint returned no actual answer'
        expected_image_facts = {
            'red': r'\bred\b|红',
            'blue': r'\bblue\b|蓝',
            'rectangle': r'\brectang(?:le|ular)\b|矩形|长方形',
            'circle': r'\b(?:circle|circular)\b|圆',
        }
        missing = [fact for fact, pattern in expected_image_facts.items() if not re.search(pattern, answer, re.I)]
        assert not missing, 'VLM answer is missing sample image facts: ' + ', '.join(missing)
        await expect(card.locator('.endpoint-output')).to_have_text(answer)
        return {'answer': clipped(answer), 'elapsed_ms': round((time.perf_counter() - started) * 1000, 1),
                'screenshot': await self.screenshot('vlm-real-image-answer')}

    async def asr(self, language):
        await self.multimodal()
        await self.choose_tool(2)
        await self.mode('off')
        await self.prompt().fill('')
        sample = self.args.samples / (language + '-demo.wav')
        assert sample.is_file(), 'Missing local audio sample ' + sample.name + ' (set --samples)'
        card = self.page.locator('.multimodal-tool').nth(1)
        await card.locator('input[type="file"]').set_input_files(sample)
        await card.locator('select').select_option(language)
        before = len([item for item in self.posts if item['path'] == SEARCH])
        started = time.perf_counter()
        async with self.page.expect_response(lambda response: urlsplit(response.url).path == TRANSCRIBE,
                                              timeout=self.args.timeout * 1000) as pending:
            await card.get_by_role('button', name='Transcribe audio', exact=True).click()
        response = await pending.value
        assert response.ok, 'ASR returned HTTP ' + str(response.status)
        transcript = (await response.json()).get('text', '').strip()
        assert transcript, 'ASR endpoint returned no transcription'
        expected = self.args.asr_en_expect if language == 'en' else self.args.asr_zh_expect
        assert expected.lower() in transcript.lower(), 'ASR transcript is missing the expected fixture keyword'
        await expect(card.locator('.endpoint-output')).to_have_text(transcript)
        assert len([item for item in self.posts if item['path'] == SEARCH]) == before, 'Transcription automatically sent a conversation'
        await expect(self.prompt()).to_have_value('')
        await card.get_by_role('button', name='Add transcript to conversation draft', exact=True).click()
        await expect(self.prompt()).to_have_value(transcript)
        assert len([item for item in self.posts if item['path'] == SEARCH]) == before, 'Adding transcript automatically sent a conversation'
        screenshot = await self.screenshot('asr-' + language + '-explicit-draft')
        question = ('Please acknowledge the voice message above in one short sentence.' if language == 'en'
                    else '请用一句简短的话确认收到以上语音消息。')
        await self.prompt().fill(transcript + '\n\n' + question)
        body, answer, payload = await self.send(expected_mode='off')
        assert payload.get('query') == transcript + '\n\n' + question, 'The user-edited draft changed the raw transcript'
        assert 'qwen' in json.dumps(body.get('model', {})).lower(), 'Voice conversation did not use the real Qwen model'
        return {'language': language, 'transcript': clipped(transcript), 'explicit_send': True,
                'new_conversation': True, 'raw_transcript_preserved': True, 'user_question': question,
                'asr_elapsed_ms': round((time.perf_counter() - started) * 1000 - answer['elapsed_ms'], 1),
                'conversation_answer': answer, 'screenshot': screenshot}

    async def tts(self):
        await self.multimodal()
        card = self.page.locator('.multimodal-tool').nth(2)
        results = []
        for language, text in [('en', 'Harbor Assistant is ready for the customer demonstration.'),
                               ('zh', '你好，Harbor Assistant 演示已经准备好了。')]:
            await card.locator('textarea').fill(text)
            await card.locator('select').select_option('')
            old_source = await card.locator('audio').get_attribute('src') if await card.locator('audio').count() else None
            started = time.perf_counter()
            async with self.page.expect_response(lambda response: urlsplit(response.url).path == SPEECH,
                                                  timeout=self.args.timeout * 1000) as pending:
                await card.get_by_role('button', name='Generate speech', exact=True).click()
            response = await pending.value
            assert response.ok, 'TTS returned HTTP ' + str(response.status)
            assert 'audio/' in (await response.all_headers()).get('content-type', ''), 'TTS did not return real audio'
            size = len(await response.body())
            assert size > 44, 'TTS response has no WAV sample data'
            await card.locator('audio').wait_for()
            await self.page.wait_for_function("""old => {
              const audio = document.querySelector('.multimodal-tool audio');
              return audio && audio.src !== old && Number.isFinite(audio.duration) && audio.duration > 0
                     && audio.readyState >= 2 && !audio.error;
            }""", arg=old_source, timeout=self.args.timeout * 1000)
            audio = card.locator('audio')
            await audio.evaluate('(audio) => { audio.muted = true; return audio.play(); }')
            await self.page.wait_for_function("""() => {
              const audio = document.querySelector('.multimodal-tool audio');
              return audio && audio.currentTime > 0.05;
            }""", timeout=15000)
            media = await audio.evaluate('(audio) => ({duration:audio.duration,current_time:audio.currentTime,ready_state:audio.readyState,paused:audio.paused,error:audio.error?.code ?? null})')
            await audio.evaluate('(audio) => audio.pause()')
            results.append({'language': language, 'voice': 'Automatic', 'bytes': size, 'media': media,
                            'elapsed_ms': round((time.perf_counter() - started) * 1000, 1),
                            'screenshot': await self.screenshot('tts-' + language + '-playing')})
        return {'audio_outputs': results}

    async def run(self):
        async with async_playwright() as playwright:
            options = {'headless': not self.args.headful,
                       'args': ['--autoplay-policy=no-user-gesture-required']}
            if self.args.chrome:
                options['executable_path'] = str(self.args.chrome)
            else:
                options['channel'] = 'chrome'
            browser = await playwright.chromium.launch(**options)
            context = await browser.new_context(ignore_https_errors=False, locale='en-US',
                                                viewport={'width': 1440, 'height': self.args.height})
            context.set_default_timeout(self.args.timeout * 1000)
            self.page = await context.new_page()
            self.page.on('response', self.observe)
            self.page.on('request', self.observe_request)
            try:
                # Authentication is always required, even when --only selects subsequent gates.
                saved_only = self.args.only
                self.args.only = None
                await self.gate('login', self.login)
                self.args.only = saved_only
                if self.report['gates'][-1]['status'] != 'passed':
                    return
                await self.gate('desktop_entry', self.desktop_entry)
                for width in WIDTHS:
                    await self.gate('layout_' + str(width), lambda width=width: self.layout(width))
                await self.page.set_viewport_size({'width': 1440, 'height': self.args.height})
                await self.gate('tools_keyboard', self.tools)
                await self.gate('draft_routes', self.draft_persistence)
                await self.gate('initial_loading_retry', self.initial_loading)
                await self.gate('models_truth', self.model_truth)
                await self.gate('data_sources', self.data_sources)
                await self.gate('ordinary_chat', self.ordinary_chat)
                await self.gate('rag_citations', self.rag_chat)
                await self.gate('history_reload', self.history)
                await self.gate('vlm_image', self.vision)
                await self.gate('asr_en', lambda: self.asr('en'))
                await self.gate('asr_zh', lambda: self.asr('zh'))
                await self.gate('tts_playback', self.tts)
            finally:
                self.page.remove_listener('response', self.observe)
                self.page.remove_listener('request', self.observe_request)
                if self.capture_tasks:
                    try:
                        await asyncio.wait_for(asyncio.gather(*list(self.capture_tasks), return_exceptions=True), timeout=15)
                    except asyncio.TimeoutError:
                        self.report['capture_incomplete'] = True
                self.write_report()
                await context.close()
                await browser.close()


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='https://192.168.3.209/ui/', help='HarborOS WebUI base URL')
    chrome = os.environ.get('HARBOR_DEMO_CHROME')
    standard_chrome = Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe')
    parser.add_argument('--chrome', type=Path, default=chrome or (standard_chrome if standard_chrome.exists() else None),
                        help='Native Chrome executable; otherwise Playwright channel=chrome')
    parser.add_argument('--samples', type=Path, default=Path(os.environ.get('HARBOR_DEMO_SAMPLES',
                        'plans/harboros-demo-209-evidence/multimodal')), help='Directory containing shapes.png/en-demo.wav/zh-demo.wav')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    parser.add_argument('--output', type=Path, default=Path('plans/harboros-demo-209-evidence') / ('browser-' + stamp))
    parser.add_argument('--timeout', type=int, default=180, help='Maximum UI/inference wait in seconds per action')
    parser.add_argument('--height', type=int, default=900, help='Viewport height for all five required widths')
    parser.add_argument('--headful', action='store_true', help='Show native Chrome while testing')
    parser.add_argument('--expected-model', help='Require this model-name substring in the real active model endpoint')
    parser.add_argument('--rag-query', default='What is the demo verification code?')
    parser.add_argument('--rag-expect', default='HARBOR-RAG-209')
    parser.add_argument('--asr-en-expect', default='Assistant')
    parser.add_argument('--asr-zh-expect', default='准备好')
    parser.add_argument('--only', help='Comma-separated gate names; login always runs. Default: run all gates')
    args = parser.parse_args()
    if args.timeout < 10 or args.height < 480:
        parser.error('--timeout must be >=10 and --height must be >=480')
    if urlsplit(args.url).scheme not in ('http', 'https') or urlsplit(args.url).username or urlsplit(args.url).password:
        parser.error('--url must be an HTTP(S) URL without embedded credentials')
    args.only = {name.strip() for name in args.only.split(',') if name.strip()} if args.only else None
    if args.only and args.only - GATES:
        parser.error('Unknown --only gate(s): ' + ', '.join(sorted(args.only - GATES)))
    args.output = args.output.resolve()
    args.samples = args.samples.resolve()
    return args


async def main():
    args = arguments()
    username = os.environ.get('HARBOR_DEMO_USERNAME', '')
    password = os.environ.get('HARBOR_DEMO_PASSWORD', '')
    if not username or not password:
        print('Set HARBOR_DEMO_USERNAME and HARBOR_DEMO_PASSWORD in the environment.', file=sys.stderr)
        return 2
    smoke = BrowserSmoke(args, username, password)
    try:
        await smoke.run()
    except Exception as error:
        smoke.report['runner_error'] = smoke.redact(error)
        smoke.write_report()
        print('FAILED browser runner: ' + type(error).__name__, file=sys.stderr)
    print('Report: ' + str(args.output / 'report.json'))
    return 0 if smoke.report.get('overall') == 'passed' and not smoke.report.get('runner_error') else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
