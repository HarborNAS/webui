import copy
import unittest

from browser_smoke import PREFIX, project, qualified_model_endpoints


def endpoint(port=11442, model='Qwen3.8-27B-Q8_0.gguf'):
    return {
        'model_endpoint_id': 'current-llm', 'model_kind': 'llm', 'endpoint_kind': 'local',
        'model_name': model, 'status': 'active',
        'metadata': {
            'base_url': f'http://127.0.0.1:{port}/v1', 'runtime_backend_kind': 'llama.cpp',
            'runtime_device': 'Vulkan0: AMD Radeon Pro W7900', 'persistent': True,
            'last_test': {'ok': True, 'details': {'http_status': 200}},
        },
    }


class CurrentModelTruthTests(unittest.TestCase):
    def test_accepts_the_current_runtime_without_a_fixed_port(self):
        for port in (11435, 11442):
            with self.subTest(port=port):
                current = endpoint(port)
                self.assertEqual(qualified_model_endpoints([current]), [current])

    def test_capture_projection_retains_fields_required_for_model_truth(self):
        current = endpoint()
        current['metadata']['api_key'] = 'must-not-record'
        captured = project(PREFIX + '/models/endpoints', {'endpoints': [current]})
        selected = qualified_model_endpoints(captured['endpoints'], 'Qwen3.8-27B')
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]['endpoint_kind'], 'local')
        self.assertNotIn('api_key', selected[0]['metadata'])

    def test_expected_model_cannot_succeed_using_an_old_active_model(self):
        old = endpoint(11435, 'qwen2.5-0.5b.gguf')
        current = endpoint()
        self.assertEqual(qualified_model_endpoints([old, current], 'qwen3.8-27b'), [current])
        self.assertEqual(qualified_model_endpoints([old], 'qwen3.8-27b'), [])

    def test_requires_real_active_persistent_w7900_and_successful_health(self):
        for field, value in [
            ('status', 'disabled'), ('model_kind', 'vlm'), ('endpoint_kind', 'cloud'),
            ('persistent', False), ('runtime_backend_kind', 'candle'),
            ('runtime_device', 'CPU'), ('last_test', None),
            ('last_test', {'ok': False, 'details': {'http_status': 200}}),
            ('last_test', {'ok': True, 'details': {'http_status': 503}}),
        ]:
            with self.subTest(field=field, value=value):
                current = copy.deepcopy(endpoint())
                target = current if field in ('status', 'model_kind', 'endpoint_kind') else current['metadata']
                target[field] = value
                self.assertEqual(qualified_model_endpoints([current]), [])


if __name__ == '__main__':
    unittest.main()
