"""Acceptance and rejection rules for the optional KiCad/Freerouting adapter."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from route_agent.desktop.core import result_summary, routing_cli
from route_agent.freerouting_result import drc_counts, sha256


class FreeroutingEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.board = self.root / 'routed.kicad_pcb'
        self.board.write_text('(kicad_pcb (version 20260306))', encoding='utf-8')
        self.drc = self.root / 'kicad-drc.json'
        self.report = self.root / 'bench_report.json'
        self.drc_data = {'$schema': 'https://schemas.kicad.org/drc.v1.json',
                         'source': self.board.name, 'included_severities': ['error', 'warning'],
                         'violations': [], 'unconnected_items': [], 'schematic_parity': []}

    def save(self):
        self.drc.write_text(json.dumps(self.drc_data), encoding='utf-8')
        data = {'engine': 'freerouting', 'metrics': {'vias': 0, 'wirelength_mm': 1.0},
                'validation': {'source': 'kicad-cli pcb drc', 'exit_code': 0,
                               'board_sha256': sha256(self.board), 'drc_sha256': sha256(self.drc),
                               'project_sha256': None, 'rules_sha256': None,
                               'counts': drc_counts(self.drc_data)}}
        self.report.write_text(json.dumps(data), encoding='utf-8')

    def test_clean_kicad_report_has_its_own_validation_scope(self):
        self.save()
        summary = result_summary(self.report)
        self.assertTrue(summary['verified'])
        self.assertIsNone(summary['edges_total'])
        self.assertIn('not PCBWorld', summary['verification_scope'])

    def test_modified_board_is_rejected(self):
        self.save()
        self.board.write_text('(kicad_pcb (version 20260306) (generator changed))', encoding='utf-8')
        self.assertFalse(result_summary(self.report)['verified'])

    def test_modified_drc_is_rejected_even_when_still_clean(self):
        self.save()
        self.drc_data['date'] = 'modified'
        self.drc.write_text(json.dumps(self.drc_data), encoding='utf-8')
        self.assertFalse(result_summary(self.report)['verified'])

    def test_new_custom_rules_invalidate_saved_acceptance(self):
        self.save()
        self.board.with_suffix('.kicad_dru').write_text('(version 1)', encoding='utf-8')
        self.assertFalse(result_summary(self.report)['verified'])

    def test_remaining_unconnected_items_are_rejected(self):
        self.drc_data['unconnected_items'] = [{'severity': 'error'}]
        self.save()
        self.assertFalse(result_summary(self.report)['verified'])

    def test_warning_is_visible_without_becoming_a_drc_error(self):
        self.drc_data['violations'] = [{'severity': 'warning'}]
        self.save()
        summary = result_summary(self.report)
        self.assertTrue(summary['verified'])
        self.assertEqual(summary['drc'], 1)
        self.assertEqual(summary['drc_errors'], 0)

    def test_report_for_another_board_is_rejected(self):
        self.drc_data['source'] = 'another.kicad_pcb'
        self.save()
        self.assertFalse(result_summary(self.report)['verified'])

    def test_filtered_error_checks_are_not_accepted(self):
        self.drc_data['included_severities'] = ['warning']
        with self.assertRaises(ValueError):
            drc_counts(self.drc_data)

    def test_host_selects_adapter_and_rejects_unknown_backend(self):
        with patch.dict('os.environ', {'PCBROUTE_ROUTER': 'freerouting'}):
            self.assertEqual(routing_cli(), 'route_agent.cli.freerouting')
        with patch.dict('os.environ', {'PCBROUTE_ROUTER': 'unknown'}), self.assertRaises(ValueError):
            routing_cli()


if __name__ == '__main__':
    unittest.main()
