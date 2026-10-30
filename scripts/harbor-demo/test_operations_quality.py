"""Focused quality-harness checks; no browser, endpoint or model is contacted."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock

import operations_quality as quality


def manifest_fixture(directory):
    cases = []
    for kind, count in quality.DISTRIBUTION.items():
        for number in range(count):
            case = {'id':kind + '-' + str(number), 'kind':kind, 'query':'Answer the operational question.',
                    'source_family':'text', 'must_demo':number == 0,
                    'must_facts':[{'id':'known', 'any_of':['known operational fact']}]}
            if kind == 'image' and number < 3:
                case.update(channel='vision', source_family='vlm', asset='sample.png')
            if kind == 'voice':
                case.update(asset='sample.wav', tts=True, language='en',
                            transcript_must_facts=[{'id':'backup', 'any_of':['backup']}])
            if kind == 'insufficient':
                case.update(must_facts=[], refusal={'required':True, 'any_of':['not provided']})
            cases.append(case)
    (directory / 'sample.png').write_bytes(b'fixture image')
    (directory / 'sample.wav').write_bytes(b'fixture audio')
    return {'schema_version':1, 'source_root_ids':['ops-demo-quality-209'], 'cases':cases}


def attempts_fixture(manifest, rounds=3):
    attempts = []
    for round_number in range(1, rounds + 1):
        for case in manifest['cases']:
            observation = {'answer':'not provided' if case['kind'] == 'insufficient' else 'known operational fact',
                           'answer_elapsed_ms':1000, 'issues':[]}
            attempts.append({'attempt_id':'round-' + str(round_number) + '-' + case['id'],
                             'case_id':case['id'], 'kind':case['kind'], 'source_family':case['source_family'],
                             'observation':observation,
                             'assessment':{'passed':True, 'refusal_matched':case['kind'] == 'insufficient'}})
    return attempts


def review_fixture(attempts):
    return {'schema_version':1, 'reviews':[{'attempt_id':item['attempt_id'],
            'actual_answer':item['observation']['answer'], 'fabrication':False,
            'evidence_insufficient':True, 'reviewed_by':'human operator', 'notes':'Actual answer reviewed.'}
            for item in attempts if item['kind'] == 'insufficient']}


class ScoringTests(unittest.TestCase):
    def test_all_must_facts_are_required_with_unicode_and_word_boundaries(self):
        case = {'must_facts':[{'id':'red', 'any_of':['red rectangle','红色矩形']},
                              {'id':'blue', 'any_of':['blue circle','蓝色圆形']}]}
        self.assertTrue(quality.evaluate(case, {'answer':'红色矩形，蓝色圆形。'})['passed'])
        self.assertTrue(quality.contains_fact('The status is ＡＣＴＩＶＥ.', 'active'))
        self.assertFalse(quality.contains_fact('The status is inactive.', 'active'))
        self.assertFalse(quality.evaluate(case, {'answer':'red rectangle'})['passed'])
        self.assertFalse(quality.evaluate(case, {'answer':'red circle and blue rectangle'})['passed'])

    def test_forbidden_claim_and_wrong_source_fail_despite_correct_facts(self):
        case = {'must_facts':[{'id':'service', 'any_of':['nginx']}],
                'forbidden_facts':[{'id':'fake-password', 'any_of':['secret123']}],
                'citations':{'required':True, 'allowed_paths':['/allowed/guide.md']}}
        evaluated = quality.evaluate(case, {'answer':'nginx uses secret123',
                                           'citations':[{'path':'/other/guide.md'}]})
        self.assertIn('forbidden_fact:fake-password', evaluated['issues'])
        self.assertIn('citation_outside_allowed_sources', evaluated['issues'])
        self.assertFalse(evaluated['passed'])

    def test_refusal_phrase_does_not_excuse_a_forbidden_claim(self):
        case = {'refusal':{'required':True, 'any_of':['not provided']},
                'forbidden_facts':[{'id':'invented', 'any_of':['SERIAL-FAKE']}]}
        evaluated = quality.evaluate(case, {'answer':'Not provided, but SERIAL-FAKE is the serial.'})
        self.assertTrue(evaluated['refusal_matched'])
        self.assertFalse(evaluated['passed'])

    def test_voice_requires_transcript_facts_and_actual_generated_answer_playback(self):
        case = {'must_facts':[{'id':'answer', 'any_of':['eight']}],
                'transcript_must_facts':[{'id':'backup', 'any_of':['backup']}], 'tts':True}
        assessed = quality.evaluate(case, {'answer':'At eight.', 'transcript':'The service restarted.'})
        self.assertIn('transcript_missing_fact:backup', assessed['issues'])
        self.assertIn('answer_audio_not_played', assessed['issues'])
        self.assertTrue(quality.evaluate(case, {'answer':'At eight.', 'transcript':'Check backup at eight.',
                                               'tts':{'played':True}})['passed'])

    def test_full_suite_requires_exact_manual_negative_review(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest = manifest_fixture(Path(temporary))
            attempts = attempts_fixture(manifest)
            automatic = quality.summary(manifest, attempts, 3)
            self.assertTrue(automatic['automated_criteria_passed'])
            self.assertFalse(automatic['acceptance_complete'])
            review = review_fixture(attempts)
            self.assertTrue(quality.summary(manifest, attempts, 3, negative_review=review)['acceptance_complete'])
            review['reviews'][0]['actual_answer'] = 'A different candidate response'
            self.assertFalse(quality.summary(manifest, attempts, 3, negative_review=review)['acceptance_complete'])

    def test_all_negative_answers_can_be_reviewed_without_being_approved(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest = manifest_fixture(Path(temporary))
            attempts = attempts_fixture(manifest)
            review = review_fixture(attempts)
            review['reviews'][0]['fabrication'] = True
            review['reviews'][1]['evidence_insufficient'] = False
            result = quality.summary(manifest, attempts, 3, negative_review=review)
            status = result['manual_negative_review']
            self.assertTrue(status['all_reviewed'])
            self.assertFalse(status['all_approved'])
            self.assertEqual(len(status['reviewed_attempt_ids']), 6)
            self.assertEqual(len(status['approved_attempt_ids']), 4)
            self.assertTrue(result['automated_criteria_passed'])
            self.assertFalse(result['acceptance_complete'])
            review['reviews'][0]['fabrication'] = 'false'
            self.assertFalse(quality.negative_review_status(attempts, review)['all_reviewed'])

    def test_every_failed_attempt_counts_and_must_demo_cannot_hide_in_95_percent(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest = manifest_fixture(Path(temporary))
            attempts = attempts_fixture(manifest)
            nonmandatory = next(item for item in attempts if item['case_id'] == 'document-1')
            nonmandatory['assessment']['passed'] = False
            result = quality.summary(manifest, attempts, 3, negative_review=review_fixture(attempts))
            self.assertGreaterEqual(result['positive_accuracy'], .95)
            self.assertTrue(result['acceptance_complete'])
            attempts[0]['assessment']['passed'] = False
            result = quality.summary(manifest, attempts, 3, negative_review=review_fixture(attempts))
            self.assertFalse(result['must_demo_all_passed'])
            self.assertFalse(result['acceptance_complete'])

    def test_missing_round_or_subset_cannot_be_full_acceptance(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest = manifest_fixture(Path(temporary))
            attempts = attempts_fixture(manifest)
            self.assertFalse(quality.summary(manifest, attempts[:-1], 3)['coverage_complete'])
            self.assertFalse(quality.summary(manifest, attempts, 3, selected_ids={'document-0'})['coverage_complete'])
            self.assertFalse(quality.summary(manifest, attempts_fixture(manifest, 1), 1)['coverage_complete'])

    def test_warm_latency_is_stratified_and_reboot_phase_does_not_claim_20_cold_loads(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest = manifest_fixture(Path(temporary))
            attempts = attempts_fixture(manifest)
            next(item for item in attempts if item['source_family'] == 'text')['observation']['answer_elapsed_ms'] = 12001
            measured = quality.summary(manifest, attempts, 3)
            self.assertEqual(measured['latency_by_source_family']['text']['p95_ms'], 1000)
            self.assertFalse(measured['latency_passed'])
            cold = attempts_fixture(manifest, 1)
            for item in cold:
                item['observation']['answer_elapsed_ms'] = 40000
            review = review_fixture(cold)
            self.assertFalse(quality.summary(manifest, cold, 1, phase='reboot_followup',
                                             negative_review=review)['acceptance_complete'])
            self.assertTrue(quality.summary(manifest, cold, 1, phase='reboot_followup',
                                            negative_review=review, cold_evidence=True)['acceptance_complete'])


class ManifestAndEvidenceTests(unittest.TestCase):
    def test_fixed_manifest_rejects_unsafe_asset_and_unscored_positive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = manifest_fixture(root)
            file = root / 'cases.json'
            file.write_text(json.dumps(fixture), encoding='utf-8')
            self.assertEqual(len(quality.load_manifest(file)['cases']), 20)
            fixture['cases'][8]['asset'] = '../outside.png'
            file.write_text(json.dumps(fixture), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'asset'):
                quality.load_manifest(file)
            fixture = manifest_fixture(root)
            fixture['cases'][0]['must_facts'] = []
            file.write_text(json.dumps(fixture), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'positive cases'):
                quality.load_manifest(file)

    def test_no_match_negative_without_generation_does_not_require_generation_diagnostics(self):
        negative = {'kind':'insufficient'}
        positive = {'kind':'document'}
        self.assertFalse(quality.diagnostics_required(negative, {'model':None, 'total_matches':0}))
        self.assertFalse(quality.diagnostics_required(negative, {'model':{'answer_generation_enabled':True}}))
        self.assertTrue(quality.diagnostics_required(negative, {
            'model':{'answer_generation_enabled':True, 'latency_ms':120}}))
        self.assertTrue(quality.diagnostics_required(positive, {'model':None}))
        self.assertTrue(quality.diagnostics_required(positive, {
            'model':{'answer_generation_enabled':True, 'latency_ms':120}}))

    def test_diagnostic_projection_excludes_headers_and_caps_raw_content(self):
        projected = quality.diagnostic_projection({'controlled_synthetic_diagnostics':{
            'query':'synthetic query', 'headers':{'Authorization':'must never be saved'},
            'raw_model_text':'x' * 5000, 'post_citation_body':'answer', 'decision':'accepted',
            'source_excerpts':[{'text':'y' * 2000, 'modality':'document', 'headers':{'secret':'hidden'}}],
        }})
        self.assertNotIn('headers', json.dumps(projected))
        self.assertEqual(len(projected['raw_model_text']), 4096)
        self.assertEqual(len(projected['source_excerpts'][0]['text']), 1024)

    def test_offline_rescore_preserves_original_and_does_not_rewrite_attempts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = manifest_fixture(root)
            attempts = attempts_fixture(manifest)
            report = {'manifest_cases':manifest['cases'], 'attempts':attempts, 'rounds':3,
                      'phase':'warm', 'summary':quality.summary(manifest, attempts, 3)}
            file = root / 'report.json'
            file.write_text(json.dumps(report), encoding='utf-8')
            original = file.read_bytes()
            review_file = root / 'negative-review.json'
            review_file.write_text(json.dumps(review_fixture(attempts)), encoding='utf-8')
            result = quality.rescore_report(file, review_file)
            updated = json.loads(file.read_text())
            self.assertTrue(result['acceptance_complete'])
            self.assertEqual(updated['attempts'], attempts)
            self.assertEqual((root / updated['negative_review']['original_report']).read_bytes(), original)
            self.assertEqual(len(updated['score_history']), 1)


class ControlledRequestTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_synthetic_diagnostic_boolean_changes_and_no_answer_retry_occurs(self):
        runner = object.__new__(quality.QualityRunner)
        runner.controlled_request_ids = {'doc-01'}
        runner.args = type('Args', (), {'url':'https://nas/ui/'})()
        payload = {'query':'What is the service?', 'filter':'text', 'source_root_ids':['ops'],
                   'conversation_id':'isolated', 'retrieval_mode':'on'}
        original = copy.deepcopy(payload)
        request = type('Request', (), {'url':'https://nas' + quality.SEARCH, 'method':'POST',
                                      'post_data_json':payload})()
        route = AsyncMock()
        route.request = request
        await runner.inject_diagnostics(route)
        supplied = json.loads(route.continue_.call_args.kwargs['post_data'])
        self.assertEqual(payload, original)
        self.assertEqual({key:value for key,value in supplied.items() if key != 'controlled_synthetic_diagnostics'}, original)
        self.assertTrue(supplied['controlled_synthetic_diagnostics'])
        route.continue_.assert_awaited_once()
        route.abort.assert_not_awaited()
        runner.controlled_request_ids.clear()
        await runner.inject_diagnostics(route)
        route.abort.assert_awaited_once_with('blockedbyclient')


if __name__ == '__main__':
    unittest.main()
