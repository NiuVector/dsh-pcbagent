"""Check saved Freerouting output against the recorded KiCad CLI DRC evidence."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def drc_counts(data: dict) -> dict:
    """Count all KiCad findings, accepting only a complete JSON DRC report."""
    groups = ('violations', 'unconnected_items', 'schematic_parity')
    if not isinstance(data, dict) or any(not isinstance(data.get(key), list) for key in groups):
        raise ValueError('KiCad DRC report is incomplete')
    if data.get('$schema') != 'https://schemas.kicad.org/drc.v1.json' or 'error' not in data.get('included_severities', []):
        raise ValueError('KiCad DRC must include error-level checks')
    items = [item for key in groups for item in data[key]]
    if any(not isinstance(item, dict) or item.get('severity') not in ('error', 'warning', 'ignore', 'exclusion') for item in items):
        raise ValueError('Unknown or missing KiCad DRC severity')
    return {'total': len(items), 'errors': sum(item['severity'] == 'error' for item in items),
            'warnings': sum(item['severity'] == 'warning' for item in items),
            'unconnected': len(data['unconnected_items'])}


def summarize(data: dict, report: Path) -> dict:
    """Bind the DRC report, output board, project, and custom rules to their saved hashes.

    This is local evidence consistency, not PCBWorld scoring or proof against a
    malicious writer. DRC checks do not include schematic parity unless requested.
    """
    reasons = []
    evidence = data.get('validation', {})
    board = report.parent / 'routed.kicad_pcb'
    drc = report.parent / 'kicad-drc.json'
    counts = {}
    if not isinstance(evidence, dict) or evidence.get('source') != 'kicad-cli pcb drc':
        reasons.append('Missing KiCad CLI validation evidence')
        evidence = {}
    for path, key in ((board, 'board_sha256'), (drc, 'drc_sha256')):
        try:
            if path.is_symlink() or sha256(path) != evidence.get(key):
                reasons.append('Saved artifact hash mismatch: ' + path.name)
        except OSError:
            reasons.append('Saved artifact is missing: ' + path.name)
    for suffix, key in (('.kicad_pro', 'project_sha256'), ('.kicad_dru', 'rules_sha256')):
        path = board.with_suffix(suffix)
        current = sha256(path) if path.is_file() and not path.is_symlink() else None
        if key not in evidence or path.is_symlink() or current != evidence.get(key):
            reasons.append('Project or custom-rule evidence mismatch: ' + path.name)
    try:
        from route_agent.desktop_bridge.board import inspect_board
        inspect_board(board)
        drc_data = json.loads(drc.read_text('utf-8-sig'))
        counts = drc_counts(drc_data)
        if drc_data.get('source') != board.name:
            reasons.append('KiCad DRC refers to a different board')
        if counts != evidence.get('counts'):
            reasons.append('DRC counts do not match the saved report')
        if counts['errors'] or counts['unconnected']:
            reasons.append('KiCad reports remaining DRC errors or unconnected items')
    except (OSError, ValueError, TypeError, IndexError) as exc:
        reasons.append('Invalid board or DRC report: ' + str(exc))
    if type(evidence.get('exit_code')) is not int or evidence['exit_code'] not in (0, 5):
        reasons.append('KiCad CLI did not complete a DRC check')
    metrics = data.get('metrics', {})
    accepted = not reasons
    return {'verified': accepted, 'clean': accepted, 'engine': 'Freerouting 2.5.0',
            'edges_routed': None, 'edges_total': None, 'edges_remaining': counts.get('unconnected'),
            'drc': counts.get('total'), 'drc_errors': counts.get('errors'),
            'length': metrics.get('wirelength_mm'), 'vias': metrics.get('vias'),
            'verification_reasons': reasons,
            'verification_scope': 'KiCad CLI DRC on Freerouting output; not PCBWorld benchmark scoring; schematic parity not checked'}
