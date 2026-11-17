import tempfile
import unittest
from pathlib import Path

from route_agent.desktop_bridge.schematic import inspect_schematic


class SchematicViewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.main = self.root / 'main.kicad_sch'

    def test_loads_original_sources_and_hierarchy_once(self):
        self.main.write_text('(kicad_sch (symbol (lib_id "R")) (sheet (property "Sheetfile" "sub/child.kicad_sch")))')
        (self.root / 'sub').mkdir()
        (self.root / 'sub/child.kicad_sch').write_text('(kicad_sch (symbol (lib_id "C")))')
        result = inspect_schematic(self.main)
        self.assertEqual(result['symbols'], 2)
        self.assertEqual(result['sheets'], 2)
        self.assertEqual(result['sources'][1]['name'], 'sub/child.kicad_sch')
        self.assertEqual(result['source'], self.main.read_text())

    def test_refuses_child_paths_outside_project(self):
        self.main.write_text('(kicad_sch (sheet (property "Sheetfile" "../outside.kicad_sch")))')
        with self.assertRaisesRegex(ValueError, '工程目录以外'):
            inspect_schematic(self.main)

    def test_reports_missing_child(self):
        self.main.write_text('(kicad_sch (sheet (property "Sheetfile" "missing.kicad_sch")))')
        with self.assertRaisesRegex(ValueError, '找不到'):
            inspect_schematic(self.main)

    def test_cyclic_reference_does_not_repeat_files(self):
        self.main.write_text('(kicad_sch (sheet (property "Sheetfile" "main.kicad_sch")))')
        self.assertEqual(inspect_schematic(self.main)['sheets'], 1)

    def test_rejects_malformed_schematic(self):
        self.main.write_text('(kicad_sch')
        with self.assertRaises(ValueError):
            inspect_schematic(self.main)
