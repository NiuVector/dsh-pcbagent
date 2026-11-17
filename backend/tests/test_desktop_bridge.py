import json
import hashlib
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from route_agent.desktop_bridge.board import inspect_board
from route_agent.desktop_bridge.server import Bridge


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.board = self.root/'test board.kicad_pcb'
        self.board.write_text('(kicad_pcb (net 1 "GND") (footprint "R" (at 10 20 90) (pad "1" smd rect (at 2 0) (size 1 2) (layers "F.Cu"))) (segment (start 10 20) (end 11 21) (width 0.2) (layer "F.Cu")))')
        self.messages = []
        self.bridge = Bridge(self.messages.append)
        self.params = {'board': str(self.board), 'output': str(self.root/'output')}

    def tearDown(self):
        self.bridge.stop()
        if self.bridge.thread:
            self.bridge.thread.join(5)
        self.temp.cleanup()

    def wait(self):
        self.bridge.thread.join(10)
        self.assertFalse(self.bridge.thread.is_alive())
        return [m for m in self.messages if m.get('event') == 'result'][-1]

    def test_board_real_geometry(self):
        result = inspect_board(self.board)
        self.assertEqual(result['pads'], 1)
        self.assertEqual(result['tracks'], 1)
        self.assertEqual(result['shapes'][1]['at'], [10.0, 18.0])

    def test_invalid_board(self):
        self.board.write_text('(kicad_pcb')
        with self.assertRaises(ValueError):
            inspect_board(self.board)

    def test_original_source_is_available_to_the_ui_carrier_only_on_request(self):
        self.assertNotIn('source', inspect_board(self.board))
        self.bridge.dispatch({'id': 'preview', 'method': 'inspect_board', 'params': {'board': str(self.board)}})
        self.assertTrue(self.messages[-1]['ok'])
        self.assertEqual(self.messages[-1]['result']['source'], self.board.read_text())

    def test_consent_required(self):
        self.bridge.dispatch({'id': 'a', 'method': 'run', 'params': dict(self.params, provider='openai')})
        self.assertFalse(self.messages[-1]['ok'])
        self.assertIsNone(self.bridge.process)

    def test_unknown_and_invalid(self):
        self.bridge.dispatch({'id': 2, 'method': 'shell', 'params': {'command': 'echo unsafe'}})
        self.assertFalse(self.messages[-1]['ok'])
        self.bridge.dispatch({'id': 3, 'method': 'run', 'params': []})
        self.assertFalse(self.messages[-1]['ok'])

    def test_redaction_and_missing_report_not_pass(self):
        code = 'import os; print(os.environ["OPENAI_API_KEY"]); print("done")'
        with patch('route_agent.desktop_bridge.server.RunSettings.command', return_value=[sys.executable, '-c', code]):
            self.bridge.dispatch({'id': 'r', 'method': 'run', 'params': dict(self.params, provider='openai', api_key='secret-for-test', model_consent=True)})
        result = self.wait()
        self.assertEqual(result['state'], 'unverified')
        self.assertNotIn('secret-for-test', json.dumps(self.messages))
        log = Path(result['output_dir'])/'desktop.log'
        self.assertIn('[REDACTED]', log.read_text())
        self.assertNotIn('secret-for-test', log.read_text())

    def test_verified_requires_official_clean(self):
        def command(settings, run_dir):
            board = run_dir / 'routed.kicad_pcb'
            board.write_text('(kicad_pcb)')
            report = {'summary': {'official': {
                'project': None, 'project_sha256': None,
            'source': 'eval.metrics.evaluate_one', 'board': str(board),
                'board_sha256': hashlib.sha256(board.read_bytes()).hexdigest(),
                'success': True, 'clean_pass': True, 'edges_routed': 3, 'edges_total': 3,
                'edges_remaining': 0, 'drv_errors_only': 0, 'drv_unconnected': 0,
                'drv_rule_errors': 0, 'total_drv': 0}}}
            return [sys.executable, '-c', 'from pathlib import Path; Path('+repr(str(run_dir/'bench_report.json'))+').write_text('+repr(json.dumps(report))+')']
        with patch('route_agent.desktop_bridge.server.RunSettings.command', command):
            self.bridge.dispatch({'id': 'r', 'method': 'run', 'params': self.params})
        result = self.wait()
        self.assertEqual(result['state'], 'verified')
        self.assertEqual(result['summary']['edges_routed'], 3)

    def test_duplicate_run_and_cancel(self):
        with patch('route_agent.desktop_bridge.server.RunSettings.command', return_value=[sys.executable, '-c', 'import time; print("started",flush=True); time.sleep(60)']):
            self.bridge.dispatch({'id': 1, 'method': 'run', 'params': self.params})
            self.bridge.dispatch({'id': 2, 'method': 'run', 'params': self.params})
        self.assertFalse(next(x for x in self.messages if x.get('id') == 2)['ok'])
        time.sleep(0.05)
        self.bridge.dispatch({'id': 3, 'method': 'stop'})
        result = self.wait()
        self.assertEqual(result['state'], 'cancelled')
        self.assertIsNone(result['summary'])

    def test_spawn_failure(self):
        with patch('route_agent.desktop_bridge.server.subprocess.Popen', side_effect=OSError('missing interpreter')):
            self.bridge.dispatch({'id': 1, 'method': 'run', 'params': self.params})
        self.assertFalse(self.messages[-1]['ok'])


if __name__ == '__main__':
    unittest.main()
