#!/usr/bin/env python3
"""Measure the fixed 20-case HarborOS operations demo through native Chrome.

Every case is submitted once per round. There are no answer retries, hidden
endpoint overrides, runtime resets, HAR files, traces, storage-state exports,
or WebSocket/token captures. Cold preparation belongs to the operator; a
reboot_followup phase records first observed runtime requests, not 20 cold loads.
Credentials: HARBOR_DEMO_USERNAME and HARBOR_DEMO_PASSWORD only.
"""
import argparse
import asyncio
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import unicodedata
from urllib.parse import urlsplit
import uuid

from playwright.async_api import async_playwright, expect
from browser_smoke import (BrowserSmoke, SEARCH, SPEECH, TRANSCRIBE, VISION,
                           project, safe_url)


KINDS = {'document', 'image', 'voice', 'insufficient'}
FILTERS = {'all', 'text', 'images', 'videos'}
DISTRIBUTION = {'document': 8, 'image': 6, 'voice': 4, 'insufficient': 2}
WARM_LIMITS_MS = {'text': 12000, 'vlm': 15000}


def normalize(value):
    return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())


def contains_fact(answer, phrase):
    normalized_answer, normalized_phrase = normalize(answer), normalize(phrase)
    start = r'(?<![a-z0-9_])' if normalized_phrase[:1].isascii() and normalized_phrase[:1].isalnum() else ''
    end = r'(?![a-z0-9_])' if normalized_phrase[-1:].isascii() and normalized_phrase[-1:].isalnum() else ''
    return bool(re.search(start + re.escape(normalized_phrase) + end, normalized_answer))


def fact_results(answer, facts):
    return [{'id': fact['id'], 'matched': any(contains_fact(answer, phrase) for phrase in fact['any_of'])}
            for fact in facts]


def quality_projection(path, body):
    result = project(path, body)
    if path == SEARCH and isinstance(body, dict):
        keys = ('path', 'source_path', 'title', 'snippet', 'score', 'lexical_score', 'embedding_score',
                'hybrid_score', 'chunk_id', 'line_start', 'line_end', 'provenance', 'modality')
        for collection in ('documents', 'images', 'videos'):
            result[collection] = [{key: (value[:3000] if isinstance(value, str) else value)
                                   for key, value in hit.items() if key in keys
                                   and isinstance(value, (str, int, float, bool, type(None)))}
                                  for hit in body.get(collection, [])[:10] if isinstance(hit, dict)]
    return result


def diagnostic_projection(body):
    value = body.get('controlled_synthetic_diagnostics') if isinstance(body, dict) else None
    if not isinstance(value, dict):
        return None
    limits = {'query':2048, 'raw_model_text':4096, 'post_citation_body':4096, 'decision':128}
    result = {key:value[key][:limit] for key, limit in limits.items() if isinstance(value.get(key), str)}
    for key in ('raw_model_text_truncated',):
        if isinstance(value.get(key), bool):
            result[key] = value[key]
    result['source_excerpts'] = [{key:(entry[key][:limit] if isinstance(entry[key], str) else entry[key])
        for key, limit in {'title':128, 'modality':32, 'text':1024, 'citation_index':0, 'truncated':0}.items()
        if key in entry and isinstance(entry[key], (str, int, bool))}
        for entry in value.get('source_excerpts', [])[:10] if isinstance(entry, dict)]
    return result


def diagnostics_required(case, body):
    if case['kind'] != 'insufficient':
        return True
    model = body.get('model') if isinstance(body, dict) else None
    return (isinstance(model, dict) and model.get('answer_generation_enabled') is True
            and isinstance(model.get('latency_ms'), (int, float)))


def diagnostic_request(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get('query'), str):
        raise ValueError('Expected a controlled Knowledge Search JSON object')
    return {**payload, 'controlled_synthetic_diagnostics': True}


def citation_paths(citations):
    paths = []
    for citation in citations:
        if isinstance(citation, str) and citation.startswith('/'):
            paths.append(citation)
        elif isinstance(citation, dict):
            path = citation.get('source_path') or citation.get('path')
            if isinstance(path, str):
                paths.append(path)
    return paths


def evaluate(case, observation):
    answer = observation.get('answer', '')
    required = fact_results(answer, case.get('must_facts', []))
    forbidden = fact_results(answer, case.get('forbidden_facts', []))
    issues = list(observation.get('issues', []))
    if not answer.strip():
        issues.append('empty_answer')
    issues.extend('missing_fact:' + fact['id'] for fact in required if not fact['matched'])
    issues.extend('forbidden_fact:' + fact['id'] for fact in forbidden if fact['matched'])
    refusal = case.get('refusal', {})
    refused = bool(refusal.get('required') and any(contains_fact(answer, value) for value in refusal['any_of']))
    if refusal.get('required') and not refused:
        issues.append('required_refusal_missing')
    citations = observation.get('citations', [])
    paths = citation_paths(citations)
    policy = case.get('citations', {})
    if policy.get('required') and not paths:
        issues.append('required_source_citation_missing')
    allowed = policy.get('allowed_paths', [])
    if allowed:
        if len(paths) != len(citations):
            issues.append('citation_path_unverifiable')
        if any(path not in allowed for path in paths):
            issues.append('citation_outside_allowed_sources')
    transcript = fact_results(observation.get('transcript', ''), case.get('transcript_must_facts', []))
    issues.extend('transcript_missing_fact:' + fact['id'] for fact in transcript if not fact['matched'])
    if case.get('tts') and not observation.get('tts', {}).get('played'):
        issues.append('answer_audio_not_played')
    return {'passed': not issues, 'issues': sorted(set(issues)), 'must_facts': required,
            'forbidden_facts': forbidden, 'refusal_matched': refused, 'citation_paths': paths,
            'transcript_facts': transcript,
            'evaluation': 'NFKC/casefold literal alternatives; every must-fact required; any forbidden match fails'}


def percentile(values, percent):
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[max(0, math.ceil(len(ordered) * percent) - 1)], 1)


def negative_review_status(attempts, review):
    negatives = [item for item in attempts if item['kind'] == 'insufficient']
    supplied = review.get('reviews', []) if isinstance(review, dict) else []
    reviewed, approved = [], []
    for attempt in negatives:
        matches = [entry for entry in supplied if entry.get('attempt_id') == attempt['attempt_id']]
        valid = len(matches) == 1 and matches[0].get('actual_answer') == attempt['observation'].get('answer', '')
        valid = valid and isinstance(matches[0].get('fabrication'), bool)
        valid = valid and isinstance(matches[0].get('evidence_insufficient'), bool)
        valid = valid and isinstance(matches[0].get('reviewed_by'), str) and bool(matches[0]['reviewed_by'].strip())
        if valid:
            reviewed.append(attempt['attempt_id'])
            if matches[0]['fabrication'] is False and matches[0]['evidence_insufficient'] is True:
                approved.append(attempt['attempt_id'])
    return {'all_reviewed': bool(negatives) and len(reviewed) == len(negatives),
            'all_approved': bool(negatives) and len(approved) == len(negatives),
            'reviewed_attempt_ids': reviewed, 'approved_attempt_ids': approved,
            'required_attempt_ids': [item['attempt_id'] for item in negatives]}


def summary(manifest, attempts, rounds, selected_ids=None, phase='warm', negative_review=None, cold_evidence=False):
    positives = [item for item in attempts if item['kind'] != 'insufficient']
    negatives = [item for item in attempts if item['kind'] == 'insufficient']
    correct = sum(item['assessment']['passed'] for item in positives)
    strata = {}
    for family in ('text', 'vlm'):
        values = [item['observation']['answer_elapsed_ms'] for item in attempts
                  if item['source_family'] == family and 'answer_elapsed_ms' in item['observation']]
        strata[family] = {'attempts': len(values), 'p50_ms': percentile(values, .5),
                          'p95_ms': percentile(values, .95), 'max_ms': max(values) if values else None, 'warm_limit_ms': WARM_LIMITS_MS[family]}
    all_ids = {case['id'] for case in manifest['cases']}
    expected = Counter({case_id: rounds for case_id in all_ids})
    actual = Counter(item['case_id'] for item in attempts)
    required_rounds = 3 if phase == 'warm' else 1
    coverage = actual == expected and selected_ids is None and rounds == required_rounds
    must_ids = {case['id'] for case in manifest['cases'] if case.get('must_demo')}
    must_passed = all(actual[case_id] == rounds and all(item['assessment']['passed']
                      for item in attempts if item['case_id'] == case_id) for case_id in must_ids)
    accuracy = correct / len(positives) if positives else 0
    negatives_pass = bool(negatives) and all(item['assessment']['passed'] and item['assessment']['refusal_matched']
                                           for item in negatives)
    latency_pass = phase != 'warm' or all(values['max_ms'] is not None
                                        and values['max_ms'] <= values['warm_limit_ms'] for values in strata.values())
    automated = coverage and accuracy >= .95 and negatives_pass and must_passed and latency_pass
    reviewed = negative_review_status(attempts, negative_review)
    cold_verified = phase != 'reboot_followup' or bool(cold_evidence)
    accepted = automated and reviewed['all_approved'] and cold_verified
    return {'status': 'passed' if accepted else 'partial', 'acceptance_complete': accepted,
            'automated_criteria_passed': automated, 'manual_negative_review': reviewed,
            'required_rounds_for_acceptance':required_rounds, 'external_reboot_evidence_present':cold_verified,
            'coverage_complete': coverage, 'expected_attempts': len(all_ids) * rounds,
            'completed_attempts': len(attempts), 'positive_accuracy': round(accuracy, 4),
            'positive_passed': correct, 'positive_attempts': len(positives),
            'negative_all_refuse_without_forbidden_facts': negatives_pass,
            'must_demo_all_passed': must_passed, 'must_demo_ids': sorted(must_ids),
            'latency_passed': latency_pass, 'latency_by_source_family': strata,
            'negative_evaluation_note': 'Forbidden literals are conservative: negated mentions also fail for review. '
                 'Literal refusal matching cannot prove absence of every possible invented value; inspect all negative answers.'}


def validate_facts(value, label):
    if not isinstance(value, list):
        raise ValueError(label + ' must be a list')
    for fact in value:
        if (not isinstance(fact, dict) or not isinstance(fact.get('id'), str) or not fact['id'].strip()
                or not isinstance(fact.get('any_of'), list) or not fact['any_of']
                or not all(isinstance(phrase, str) and phrase.strip() for phrase in fact['any_of'])):
            raise ValueError(label + ' requires {id, any_of:[nonempty literal alternatives]}')


def load_manifest(path):
    manifest = json.loads(path.read_text(encoding='utf-8'))
    cases = manifest.get('cases', [])
    if manifest.get('schema_version') != 1 or not isinstance(cases, list) or len(cases) != 20:
        raise ValueError('Expected schema_version=1 with exactly 20 cases')
    if Counter(case.get('kind') for case in cases) != DISTRIBUTION:
        raise ValueError('The fixed suite requires 8 document, 6 image, 4 voice and 2 insufficient cases')
    if not any(case.get('must_demo') is True for case in cases):
        raise ValueError('At least one fixed case must be designated must_demo')
    if len({case.get('id') for case in cases}) != len(cases):
        raise ValueError('Case IDs must be unique')
    for case in cases:
        if not re.fullmatch(r'[A-Za-z0-9_-]+', case.get('id', '')):
            raise ValueError('Case IDs may contain only letters, digits, underscore and hyphen')
        if not isinstance(case.get('query'), str) or not case['query'].strip():
            raise ValueError(case['id'] + ': query is required')
        if case.get('source_family') not in WARM_LIMITS_MS:
            raise ValueError(case['id'] + ': source_family must be text or vlm')
        if (case.get('channel') == 'vision') != (case['source_family'] == 'vlm'):
            raise ValueError(case['id'] + ': only direct vision cases belong to the vlm latency stratum')
        if case.get('channel') == 'vision' and case['kind'] != 'image':
            raise ValueError(case['id'] + ': direct vision requires an image case')
        if case.get('channel', 'knowledge') not in ('knowledge', 'vision'):
            raise ValueError(case['id'] + ': invalid channel')
        roots = case.get('source_root_ids', manifest.get('source_root_ids', []))
        if not isinstance(roots, list) or not all(isinstance(root, str) and root for root in roots):
            raise ValueError(case['id'] + ': source_root_ids must be a string list')
        if case.get('filter', 'all') not in FILTERS or case.get('retrieval_mode', 'on') not in ('auto', 'on', 'off'):
            raise ValueError(case['id'] + ': invalid filter or retrieval_mode')
        for key in ('must_facts', 'forbidden_facts', 'transcript_must_facts'):
            validate_facts(case.get(key, []), case['id'] + '.' + key)
        if case['kind'] != 'insufficient' and not case.get('must_facts'):
            raise ValueError(case['id'] + ': positive cases need must_facts')
        if case['kind'] == 'insufficient':
            refusal = case.get('refusal', {})
            if not refusal.get('required') or not refusal.get('any_of'):
                raise ValueError(case['id'] + ': insufficient cases need an explicit refusal matcher')
        refusal = case.get('refusal', {})
        if refusal.get('required') and (not isinstance(refusal.get('any_of'), list)
                or not all(isinstance(value, str) and value.strip() for value in refusal['any_of'])):
            raise ValueError(case['id'] + ': refusal alternatives must be nonempty strings')
        citations = case.get('citations', {})
        if not isinstance(citations.get('allowed_paths', []), list) or not all(
                isinstance(value, str) and value.startswith('/') for value in citations.get('allowed_paths', [])):
            raise ValueError(case['id'] + ': allowed_paths must be absolute source paths')
        if citations.get('required') and not citations.get('allowed_paths'):
            raise ValueError(case['id'] + ': required citations need allowed_paths')
        if case['kind'] == 'voice' or (case['kind'] == 'image' and case.get('channel') == 'vision'):
            asset = case.get('asset')
            if not isinstance(asset, str) or Path(asset).is_absolute():
                raise ValueError(case['id'] + ': upload asset must be relative to the manifest')
            resolved = (path.parent / asset).resolve()
            if not resolved.is_relative_to(path.parent.resolve()) or not resolved.is_file():
                raise ValueError(case['id'] + ': upload asset is missing or escapes fixture directory')
        if case['kind'] == 'voice' and case.get('tts') is not True:
            raise ValueError(case['id'] + ': every voice case must play TTS for the generated answer')
    manifest['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
    return manifest


class QualityRunner(BrowserSmoke):
    def __init__(self, args, username, password, manifest):
        super().__init__(args, username, password)
        self.manifest = manifest
        self.attempts = []
        self.runtime_observations = set()
        self.controlled_request_ids = set()
        self.report['manifest_cases'] = [{key:case.get(key) for key in ('id','kind','source_family','must_demo')}
                                         for case in manifest['cases']]
        self.report.update(suite='operations_quality_v1', candidate=args.candidate_label, phase=args.phase,
                           manifest_sha256=manifest['sha256'], rounds=args.rounds,
                           selected_case_ids=sorted(args.only_cases) if args.only_cases else None,
                           answer_retries=0, source_family_limits_ms=WARM_LIMITS_MS,
                           controlled_synthetic_diagnostics_interception={
                               'enabled':True, 'path':SEARCH, 'method':'POST',
                               'changed_fields':['controlled_synthetic_diagnostics'],
                               'query_and_expected_facts_unchanged':True},
                           cold_claim=('External operator reboot; only first observed requests per runtime are labeled.'
                                       if args.phase == 'reboot_followup' else 'No cold-load claim.'))
        if args.cold_evidence:
            self.report['cold_evidence'] = {'path': str(args.cold_evidence),
                'sha256': hashlib.sha256(args.cold_evidence.read_bytes()).hexdigest()}

    def write_report(self):
        if not hasattr(self, 'manifest'):
            return
        self.report['attempts'] = self.attempts
        self.report['summary'] = summary(self.manifest, self.attempts, self.args.rounds,
                                         self.args.only_cases, self.args.phase, cold_evidence=bool(self.args.cold_evidence))
        self.report['finished_at'] = datetime.now(timezone.utc).isoformat()
        temporary = self.args.output / 'report.next.json'
        temporary.write_text(json.dumps(self.report, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(self.args.output / 'report.json')

    async def options(self, case):
        await self.choose_tool(0)
        panel = self.page.locator('.assistant-options')
        await panel.locator('select').first.select_option(case.get('retrieval_mode', 'on'))
        rows = panel.locator('.assistant-source')
        desired = case.get('source_root_ids', self.manifest.get('source_root_ids', []))
        known = {}
        for entry in self.report['api']:
            if entry['path'].endswith('/knowledge/settings') and entry['status'] == 200:
                known.update({item['root_id']: item for item in entry.get('data', {}).get('source_roots', [])})
        deadline = time.monotonic() + 15
        while desired and (not set(desired).issubset(known) or await rows.count() == 0):
            if time.monotonic() >= deadline:
                raise AssertionError('Required source settings are unavailable')
            await self.page.wait_for_timeout(100)
            for entry in self.report['api']:
                if entry['path'].endswith('/knowledge/settings') and entry['status'] == 200:
                    known.update({item['root_id']: item for item in entry.get('data', {}).get('source_roots', [])})
        selected = []
        for index in range(await rows.count()):
            row = rows.nth(index)
            label = normalize(await row.inner_text())
            root_id = next((key for key, value in known.items()
                            if normalize(value.get('label') or value.get('path', '')) == label), None)
            await row.locator('input').set_checked(root_id in desired)
            if root_id in desired:
                selected.append(root_id)
        if set(selected) != set(desired):
            raise AssertionError('Configured source IDs are not selectable: ' + repr(sorted(set(desired) - set(selected))))
        await panel.locator('select').nth(1).select_option(case.get('filter', 'all'))
        await self.close_options()
        return desired

    async def inject_diagnostics(self, route):
        request = route.request
        requested = urlsplit(request.url)
        target = urlsplit(self.args.url)
        if (requested.scheme, requested.netloc, requested.path) != (target.scheme, target.netloc, SEARCH) or request.method != 'POST':
            await route.continue_()
            return
        if not self.controlled_request_ids:
            await route.abort('blockedbyclient')
            return
        original = request.post_data_json
        updated = diagnostic_request(original)
        assert {key:value for key,value in updated.items() if key != 'controlled_synthetic_diagnostics'} == {
            key:value for key,value in original.items() if key != 'controlled_synthetic_diagnostics'}
        await route.continue_(post_data=json.dumps(updated, ensure_ascii=False))

    async def knowledge(self, case, observation, prompt=None):
        await self.assistant()
        selected = await self.options(case)
        question = prompt if prompt is not None else case['query']
        await self.prompt().fill(question)
        started = time.perf_counter()
        self.controlled_request_ids.add(case['id'])
        try:
            async with self.page.expect_response(lambda item: urlsplit(item.url).path == SEARCH
                                                  and item.request.method == 'POST', timeout=self.args.timeout * 1000) as pending:
                await self.composer().get_by_role('button', name='Send', exact=True).click()
            response = await pending.value
        finally:
            self.controlled_request_ids.discard(case['id'])
        observation['http_status'] = response.status
        body = await response.json()
        observation['response'] = quality_projection(SEARCH, body)
        observation['controlled_synthetic_diagnostics'] = diagnostic_projection(body)
        observation['diagnostics_required'] = diagnostics_required(case, body)
        if observation['controlled_synthetic_diagnostics'] is None:
            if observation['diagnostics_required']:
                observation['issues'].append('controlled_diagnostics_unavailable')
            else:
                observation['diagnostics_not_applicable'] = 'Expected insufficient-evidence early response without measured generation'
        observation['answer'] = (body.get('reply_pack') or {}).get('summary', '').strip()
        observation['citations'] = observation['response'].get('reply_pack', {}).get('citations', [])
        payload = response.request.post_data_json
        observation['submitted'] = {'query': payload.get('query'), 'conversation_id': payload.get('conversation_id'),
                                     'retrieval_mode': payload.get('retrieval_mode'), 'filter': payload.get('filter'),
                                     'source_root_ids': payload.get('source_root_ids')}
        if payload.get('query') != question or set(payload.get('source_root_ids', [])) != set(selected):
            observation['issues'].append('submitted_draft_or_sources_changed')
        if payload.get('filter') != case.get('filter', 'all') or payload.get('retrieval_mode') != case.get('retrieval_mode', 'on'):
            observation['issues'].append('submitted_filter_or_mode_changed')
        if not response.ok:
            observation['issues'].append('knowledge_http_' + str(response.status))
        model = body.get('model') or {}
        if case['kind'] != 'insufficient':
            if not isinstance(model, dict) or model.get('available') is not True or model.get('answer_generation_enabled') is not True:
                observation['issues'].append('real_answer_generation_unavailable')
            if body.get('degraded'):
                observation['issues'].append('degraded_response')
        timing = response.request.timing
        if timing.get('responseStart', -1) >= 0 and timing.get('requestStart', -1) >= 0:
            observation['answer_ttfb_ms'] = round(timing['responseStart'] - timing['requestStart'], 1)
        if normalize(observation['answer']) == normalize(question):
            observation['issues'].append('answer_echoes_full_query')
        if observation['answer']:
            await expect(self.page.locator('.assistant-turn').last.locator('.assistant-answer')).to_have_text(observation['answer'])
        observation['answer_elapsed_ms'] = round((time.perf_counter() - started) * 1000, 1)
        self.observe_runtime(observation, model.get('model_endpoint_id') if isinstance(model, dict) else 'unknown-text')
        return observation['answer']

    def observe_runtime(self, observation, runtime):
        key = runtime or 'unknown'
        observation.setdefault('runtime_observations', []).append({'runtime': key,
            'first_observed_request_in_phase': key not in self.runtime_observations,
            'cold_state_verified': False})
        self.runtime_observations.add(key)

    async def vision_case(self, case, observation):
        await self.multimodal()
        card = self.page.locator('.multimodal-tool').nth(0)
        asset = (self.args.manifest.parent / case['asset']).resolve()
        observation['asset_sha256'] = hashlib.sha256(asset.read_bytes()).hexdigest()
        await card.locator('input[type="file"]').set_input_files(asset)
        await card.locator('textarea').fill(case['query'])
        started = time.perf_counter()
        async with self.page.expect_response(lambda item: urlsplit(item.url).path == VISION,
                                              timeout=self.args.timeout * 1000) as pending:
            await card.get_by_role('button', name='Ask about image', exact=True).click()
        response = await pending.value
        observation['answer_elapsed_ms'] = round((time.perf_counter() - started) * 1000, 1)
        observation['http_status'] = response.status
        body = await response.json()
        timing = response.request.timing
        if timing.get('responseStart', -1) >= 0 and timing.get('requestStart', -1) >= 0:
            observation['answer_ttfb_ms'] = round(timing['responseStart'] - timing['requestStart'], 1)
        observation['response'] = project(VISION, body)
        choices = body.get('choices') or []
        observation['answer'] = ((choices[0].get('message') or {}).get('content') or '').strip() if choices else ''
        observation['citations'] = []
        payload = response.request.post_data_json
        observation['submitted'] = {'model': payload.get('model'), 'temperature': payload.get('temperature'),
                                     'max_tokens': payload.get('max_tokens'), 'query': case['query']}
        if payload.get('model') != 'automatic':
            observation['issues'].append('per_message_endpoint_override')
        if not response.ok:
            observation['issues'].append('vision_http_' + str(response.status))
        if observation['answer']:
            await expect(card.locator('.endpoint-output')).to_have_text(observation['answer'])
        observation['answer_elapsed_ms'] = round((time.perf_counter() - started) * 1000, 1)
        self.observe_runtime(observation, str(body.get('model') or 'unknown-vlm'))

    async def voice_case(self, case, observation, name):
        await self.multimodal()
        asset = (self.args.manifest.parent / case['asset']).resolve()
        observation['asset_sha256'] = hashlib.sha256(asset.read_bytes()).hexdigest()
        card = self.page.locator('.multimodal-tool').nth(1)
        await card.locator('input[type="file"]').set_input_files(asset)
        await card.locator('select').select_option(case.get('language', 'auto'))
        await self.prompt().fill('')
        before = sum(item['path'] == SEARCH for item in self.posts)
        started = time.perf_counter()
        async with self.page.expect_response(lambda item: urlsplit(item.url).path == TRANSCRIBE,
                                              timeout=self.args.timeout * 1000) as pending:
            await card.get_by_role('button', name='Transcribe audio', exact=True).click()
        response = await pending.value
        observation['asr_status'] = response.status
        body = await response.json()
        transcript = body.get('text', '').strip()
        observation['transcript'] = transcript
        if not response.ok or not transcript:
            observation['issues'].append('transcription_unavailable')
            return
        await expect(card.locator('.endpoint-output')).to_have_text(transcript)
        observation['asr_elapsed_ms'] = round((time.perf_counter() - started) * 1000, 1)
        if before != sum(item['path'] == SEARCH for item in self.posts):
            observation['issues'].append('transcription_auto_sent')
        await expect(self.prompt()).to_have_value('')
        await card.get_by_role('button', name='Add transcript to conversation draft', exact=True).click()
        await expect(self.prompt()).to_have_value(transcript)
        if before != sum(item['path'] == SEARCH for item in self.posts):
            observation['issues'].append('draft_transfer_auto_sent')
        observation['raw_transcript_preserved'] = True
        observation['draft_screenshot'] = await self.screenshot(name + '-raw-transcript')
        self.observe_runtime(observation, 'asr')
        answer = await self.knowledge(case, observation, transcript + '\n\n' + case['query'])
        if answer:
            await self.play_answer(answer, observation)

    async def play_answer(self, answer, observation):
        await self.multimodal()
        card = self.page.locator('.multimodal-tool').nth(2)
        if len(answer) > 2000:
            observation['issues'].append('generated_answer_exceeds_tts_limit')
            return
        await card.locator('textarea').fill(answer)
        await card.locator('select').select_option('')
        old = await card.locator('audio').get_attribute('src') if await card.locator('audio').count() else None
        started = time.perf_counter()
        async with self.page.expect_response(lambda item: urlsplit(item.url).path == SPEECH,
                                              timeout=self.args.timeout * 1000) as pending:
            await card.get_by_role('button', name='Generate speech', exact=True).click()
        response = await pending.value
        media = {'http_status': response.status, 'generation_ms': round((time.perf_counter() - started) * 1000, 1)}
        observation['tts'] = media
        if not response.ok:
            observation['issues'].append('tts_http_' + str(response.status))
            return
        audio_bytes = await response.body()
        media['generation_ms'] = round((time.perf_counter() - started) * 1000, 1)
        media['bytes'] = len(audio_bytes)
        if audio_bytes[:4] not in (b'RIFF', b'RF64'):
            observation['issues'].append('tts_response_is_not_wav')
        media['sha256'] = hashlib.sha256(audio_bytes).hexdigest()
        audio_name = observation['attempt_id'] + '-answer.wav'
        (self.args.output / audio_name).write_bytes(audio_bytes)
        media['audio_artifact'] = audio_name
        timing = response.request.timing
        if timing.get('responseStart', -1) >= 0 and timing.get('requestStart', -1) >= 0:
            media['ttfb_ms'] = round(timing['responseStart'] - timing['requestStart'], 1)
        payload = response.request.post_data_json
        if payload.get('input') != answer:
            observation['issues'].append('tts_did_not_read_actual_answer')
        await self.page.wait_for_function("""old => {
          const audio=document.querySelector('.multimodal-tool audio');
          return audio && audio.src!==old && Number.isFinite(audio.duration) && audio.duration>0 && audio.readyState>=2 && !audio.error;
        }""", arg=old, timeout=self.args.timeout * 1000)
        audio = card.locator('audio')
        await audio.evaluate('(audio)=>{audio.muted=true;return audio.play();}')
        await self.page.wait_for_function("""() => document.querySelector('.multimodal-tool audio')?.currentTime>0.05""", timeout=15000)
        media.update(await audio.evaluate('(audio)=>({duration:audio.duration,current_time:audio.currentTime,error:audio.error?.code??null})'))
        await audio.evaluate('(audio)=>audio.pause()')
        media['played'] = media['bytes'] > 44 and media['current_time'] > .05 and media['error'] is None
        self.observe_runtime(observation, 'tts')

    async def attempt(self, case, round_number):
        name = 'round-' + str(round_number) + '-' + case['id']
        observation = {'issues': [], 'attempt_id': name}
        started = time.perf_counter()
        record = {'attempt_id': name, 'case_id': case['id'], 'round': round_number,
                  'kind': case['kind'], 'channel': case.get('channel', 'knowledge'),
                  'source_family': case['source_family'], 'must_demo': bool(case.get('must_demo')),
                  'phase': self.args.phase, 'started_at': datetime.now(timezone.utc).isoformat(),
                  'observation': observation}
        print('RUN ' + name, flush=True)
        api_start = len(self.report['api'])
        post_start = len(self.posts)
        try:
            await self.show_page()
            await self.close_options()
            await self.choose_tool(2)
            if case['kind'] == 'voice':
                await self.voice_case(case, observation, name)
            elif case.get('channel') == 'vision':
                await self.vision_case(case, observation)
            else:
                await self.knowledge(case, observation)
        except Exception as error:
            observation['issues'].append('ui_or_transport_failure:' + type(error).__name__)
            observation['error'] = self.redact(error)
        finally:
            observation['total_elapsed_ms'] = round((time.perf_counter() - started) * 1000, 1)
            latency = observation.get('answer_elapsed_ms')
            observation['warm_latency_within_target'] = (latency <= WARM_LIMITS_MS[case['source_family']]
                                                        if latency is not None and self.args.phase == 'warm' else None)
            try:
                observation['screenshot'] = await self.screenshot(name)
            except Exception as error:
                observation['screenshot_error_kind'] = type(error).__name__
            if self.capture_tasks:
                try:
                    await asyncio.wait_for(asyncio.gather(*list(self.capture_tasks), return_exceptions=True), timeout=15)
                except asyncio.TimeoutError:
                    observation['issues'].append('api_evidence_capture_timeout')
            record['api'] = self.report['api'][api_start:]
            counts = Counter(item['path'] for item in self.posts[post_start:])
            observation['mutation_counts'] = dict(counts)
            expected_counts = ({VISION:1} if case.get('channel') == 'vision'
                               else {SEARCH:1, TRANSCRIBE:1, SPEECH:1} if case['kind'] == 'voice' else {SEARCH:1})
            if counts != Counter(expected_counts):
                observation['issues'].append('unexpected_or_duplicate_model_submission')
            record['assessment'] = evaluate(case, observation)
            self.attempts.append(record)
            (self.args.output / (name + '.json')).write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
            self.write_report()
            print(('PASS ' if record['assessment']['passed'] else 'FAIL ') + name, flush=True)

    async def run(self):
        async with async_playwright() as playwright:
            launch = {'headless': not self.args.headful, 'args':['--autoplay-policy=no-user-gesture-required']}
            if self.args.chrome:
                launch['executable_path'] = str(self.args.chrome)
            else:
                launch['channel'] = 'chrome'
            browser = await playwright.chromium.launch(**launch)
            context = await browser.new_context(ignore_https_errors=True, locale='en-US', viewport={'width':1440,'height':900})
            context.set_default_timeout(self.args.timeout * 1000)
            self.page = await context.new_page()
            self.page.on('response', self.observe)
            self.page.on('request', self.observe_request)
            await context.route('**' + SEARCH, self.inject_diagnostics)
            try:
                await self.login()
                self.report['authenticated'] = True
                for round_number in range(1, self.args.rounds + 1):
                    for case in self.manifest['cases']:
                        if not self.args.only_cases or case['id'] in self.args.only_cases:
                            await self.attempt(case, round_number)
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
    parser.add_argument('--manifest', type=Path, help='Fixed 20-case fixture manifest (required for browser runs)')
    parser.add_argument('--score-report', type=Path, help='Rescore a completed report offline; never opens a browser')
    parser.add_argument('--negative-review', type=Path, help='Operator review tied to exact negative attempt IDs and actual answers')
    parser.add_argument('--url', default='https://192.168.3.209/ui/')
    parser.add_argument('--phase', choices=('warm','reboot_followup'), default='warm')
    parser.add_argument('--rounds', type=int, help='Default warm=3, reboot_followup=1; all attempts retained')
    parser.add_argument('--candidate-label', default='baseline')
    parser.add_argument('--cold-evidence', type=Path, help='Operator-created reboot/runtime evidence; hashed without copying secrets')
    parser.add_argument('--only', dest='only_cases', help='Case IDs for diagnosis; selected runs never satisfy full acceptance')
    parser.add_argument('--output', type=Path, help='Parent directory; a unique run subdirectory is always created')
    chrome = os.environ.get('HARBOR_DEMO_CHROME')
    standard = Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe')
    parser.add_argument('--chrome', type=Path, default=chrome or (standard if standard.exists() else None))
    parser.add_argument('--headful', action='store_true')
    parser.add_argument('--timeout', type=int, default=180)
    args = parser.parse_args()
    if args.score_report:
        if not args.negative_review:
            parser.error('--score-report requires --negative-review')
        return args
    if not args.manifest or not args.output:
        parser.error('Browser runs require --manifest and --output')
    args.manifest = args.manifest.resolve()
    args.rounds = args.rounds if args.rounds is not None else 3 if args.phase == 'warm' else 1
    if args.rounds < 1 or args.timeout < 10:
        parser.error('--rounds must be >=1 and --timeout must be >=10')
    parts = urlsplit(args.url)
    if parts.scheme not in ('https','http') or parts.username or parts.password:
        parser.error('--url must be HTTP(S) without embedded credentials')
    args.only_cases = {value.strip() for value in args.only_cases.split(',') if value.strip()} if args.only_cases else None
    args.only = None  # Existing BrowserSmoke helpers do not select gates in this runner.
    args.samples = args.manifest.parent
    args.height = 900
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-' + uuid.uuid4().hex[:6]
    args.output = args.output.resolve() / run_id
    return args


def rescore_report(report_path, review_path):
    report = json.loads(report_path.read_text(encoding='utf-8'))
    review = json.loads(review_path.read_text(encoding='utf-8'))
    manifest = {'cases':report['manifest_cases']}
    selected = set(report.get('selected_case_ids') or []) or None
    updated = summary(manifest, report['attempts'], report['rounds'], selected, report['phase'], review,
                      cold_evidence=bool(report.get('cold_evidence')))
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    original = report_path.with_name('report-before-manual-review-' + stamp + '.json')
    original.write_bytes(report_path.read_bytes())
    report.setdefault('score_history', []).append({'at':datetime.now(timezone.utc).isoformat(), 'summary':report['summary']})
    report['summary'] = updated
    report['negative_review'] = {'path':str(review_path.resolve()), 'scored_at':datetime.now(timezone.utc).isoformat(),
                                'original_report':original.name,
                                'original_report_sha256':hashlib.sha256(original.read_bytes()).hexdigest(),
                                'sha256':hashlib.sha256(review_path.read_bytes()).hexdigest()}
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return updated


async def main():
    args = arguments()
    if args.score_report:
        try:
            scored = rescore_report(args.score_report, args.negative_review)
        except (ValueError, KeyError, OSError) as error:
            print('Invalid saved report/review: ' + str(error), file=sys.stderr)
            return 2
        print(json.dumps(scored, ensure_ascii=False, indent=2))
        return 0 if scored['acceptance_complete'] else 1
    try:
        manifest = load_manifest(args.manifest)
        if args.only_cases and args.only_cases - {case['id'] for case in manifest['cases']}:
            raise ValueError('Unknown --only case IDs')
        if args.cold_evidence and not args.cold_evidence.is_file():
            raise ValueError('--cold-evidence must name an existing operator evidence file')
    except (ValueError, OSError) as error:
        print('Invalid manifest: ' + str(error), file=sys.stderr)
        return 2
    username, password = os.environ.get('HARBOR_DEMO_USERNAME',''), os.environ.get('HARBOR_DEMO_PASSWORD','')
    if not username or not password:
        print('Set HARBOR_DEMO_USERNAME and HARBOR_DEMO_PASSWORD in the environment.', file=sys.stderr)
        return 2
    runner = QualityRunner(args, username, password, manifest)
    try:
        await runner.run()
    except Exception as error:
        runner.report['runner_error'] = runner.redact(error)
        runner.write_report()
        print('Runner failed: ' + type(error).__name__, file=sys.stderr)
    print('Report: ' + str(args.output / 'report.json'))
    return 0 if runner.report['summary']['acceptance_complete'] and not runner.report.get('runner_error') else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
