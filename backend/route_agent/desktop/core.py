"""Testable desktop launch contracts, independent of Qt and engine imports."""
from __future__ import annotations
import json
import hashlib
import math
import os
from pathlib import Path
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]


def routing_cli():
    """Select a host-configured routing backend; request parameters cannot change it."""
    backend = os.environ.get('PCBROUTE_ROUTER', 'freerouting')
    if backend not in ('pcbworld', 'freerouting'):
        raise ValueError('Unsupported host routing backend: ' + backend)
    return 'route_agent.cli.freerouting' if backend == 'freerouting' else 'route_agent.cli.pipeline'

@dataclass
class RunSettings:
    board: str
    output: str
    provider: str = 'none'
    model: str = 'gpt-6.1-sol'
    effort: str = 'xhigh'
    rounds: int = 12
    runtime: str = ''

    def validate(self):
        board = Path(self.board).expanduser()
        if not board.is_file() or board.suffix.lower() != '.kicad_pcb':
            raise ValueError('请选择存在的 .kicad_pcb 板文件。')
        if not self.output.strip():
            raise ValueError('请选择输出目录。')
        if self.provider not in ('none', 'openai', 'anthropic'):
            raise ValueError('不支持的模型提供商。')
        if self.provider != 'none' and not self.model.strip():
            raise ValueError('请填写模型名称。')
        if not 0 <= self.rounds <= 100:
            raise ValueError('重规划轮数须为 0–100。')
        if self.runtime and not Path(self.runtime).is_file():
            raise ValueError('引擎 runtime JSON 不存在。')

    def command(self, run_dir: Path):
        self.validate()
        args = [sys.executable, '-u', '-m', routing_cli(), 'bench',
                str(Path(self.board).resolve()), '--out', str(run_dir), '--provider', self.provider,
                '--save', str(run_dir / 'routed.kicad_pcb'), '--max-global-rounds', str(self.rounds)]
        if self.provider != 'none':
            args += ['--model', self.model.strip()]
        return args

    def environment(self, key: str = ''):
        env = dict(os.environ)
        # Desktop fields must not be silently overridden by legacy .env files.
        env['ROUTEAGENT_ENV'] = os.devnull
        env['PYTHONUNBUFFERED'] = '1'
        env['PYTHONIOENCODING'] = 'utf-8'
        env['ROUTEAGENT_OPENAI_EFFORT'] = self.effort
        if self.runtime:
            p = Path(self.runtime).resolve()
            data = json.loads(p.read_text(encoding='utf-8-sig'))
            def resolve(value):
                q = Path(value)
                return str(q if q.is_absolute() else p.parent / q)
            env['PCBWORLD_ENGINE_PYTHON'] = resolve(data['python'])
            env['PCBWORLD_KICAD_RL_MODULE_DIR'] = resolve(data['module_dir'])
            env['PCBWORLD_ENGINE_DLL_DIRS'] = os.pathsep.join(resolve(d) for d in data.get('dll_dirs', []))
        if key.strip() and self.provider != 'none':
            env['OPENAI_API_KEY' if self.provider == 'openai' else 'ANTHROPIC_API_KEY'] = key.strip()
        return env

    def create_run(self):
        self.validate()
        run = Path(self.output).expanduser().resolve() / (datetime.now().strftime('%Y%m%d-%H%M%S-') + uuid4().hex[:8])
        run.mkdir(parents=True, exist_ok=False)
        return run


def redact(text: str, secrets=()):
    for secret in sorted((s for s in secrets if s), key=len, reverse=True):
        text = text.replace(secret, '[REDACTED]')
    text = re.sub(r'\bsk-[A-Za-z0-9_-]+', '[REDACTED]', text)
    text = re.sub(r'(?i)(authorization\s*[:=]\s*bearer\s+)\S+', r'\1[REDACTED]', text)
    return text


def result_summary(path: Path):
    """Fail closed on incomplete or contradictory evaluator evidence.

    This validates a local report contract, not an independent KiCad DRC run or
    an authenticity guarantee against a malicious report/board writer.
    """
    path = Path(path)
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError('Evaluation report exceeds 32 MiB')

    def reject_constant(value):
        raise ValueError('Non-finite number in evaluation report: ' + value)

    def finite_float(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            raise ValueError('Non-finite number in evaluation report')
        return parsed

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate field in evaluation report: ' + key)
            result[key] = value
        return result

    data = json.loads(path.read_text(encoding='utf-8'), parse_constant=reject_constant, parse_float=finite_float,
                      object_pairs_hook=unique_object)
    if not isinstance(data, dict):
        raise ValueError('Evaluation report must be an object')
    if data.get('engine') == 'freerouting':
        from route_agent.freerouting_result import summarize
        return summarize(data, path)
    reports = []
    for section in ('summary', 'execution'):
        container = data.get(section, {})
        if not isinstance(container, dict):
            raise ValueError('Invalid evaluation report section: ' + section)
        official = container.get('official')
        if official is not None:
            if not isinstance(official, dict):
                raise ValueError('Official evaluation must be an object')
            reports.append(official)
    official = reports[0] if reports else {}
    reasons = []
    if official.get('source') != 'eval.metrics.evaluate_one':
        reasons.append('Official evaluator source is missing or unsupported')
    required_counts = ('edges_total', 'edges_routed', 'edges_remaining',
                       'drv_errors_only', 'drv_unconnected', 'drv_rule_errors', 'total_drv')
    for key in required_counts:
        value = official.get(key)
        if type(value) is not int or value < 0:
            reasons.append('Missing or invalid nonnegative integer: ' + key)
    if not any(r.startswith('Missing or invalid') for r in reasons):
        if official['edges_routed'] + official['edges_remaining'] != official['edges_total']:
            reasons.append('Connectivity counts are inconsistent')
        if official['drv_unconnected'] + official['drv_rule_errors'] != official['drv_errors_only']:
            reasons.append('DRC error counts are inconsistent')
        if official['total_drv'] < official['drv_errors_only']:
            reasons.append('Total DRC count is smaller than error count')
        if official['edges_remaining'] or official['drv_errors_only']:
            reasons.append('Unconnected edges or DRC errors remain')
    if official.get('success') is not True or official.get('clean_pass') is not True:
        reasons.append('Evaluator did not explicitly report success and clean pass')
    # The bench report contains both a headline and the full evaluator result.
    # Never accept a clean headline hiding contradictory execution evidence.
    evidence_keys = ('source', 'board', 'board_sha256', 'project', 'project_sha256', 'success', 'clean_pass') + required_counts
    for other in reports[1:]:
        if any(other.get(key) != official.get(key) for key in evidence_keys):
            reasons.append('Summary and execution evaluation evidence disagree')
            break
    board = path.parent / 'routed.kicad_pcb'
    reported_board = official.get('board')
    if not isinstance(reported_board, str) or not reported_board:
        reasons.append('Evaluated board path is missing')
    elif Path(reported_board).resolve() != board.resolve():
        reasons.append('Evaluation refers to a different output board')
    if board.is_symlink():
        reasons.append('Output board must not be a symbolic link')
    try:
        # Geometry parsing is only a readability check, never a DRC substitute.
        from route_agent.desktop_bridge.board import inspect_board
        inspect_board(board)
        if official.get('board_sha256') != hashlib.sha256(board.read_bytes()).hexdigest():
            reasons.append('Saved board hash is missing or does not match evaluation')
    except (OSError, ValueError, IndexError, TypeError) as exc:
        reasons.append('Routed board is missing or invalid: ' + str(exc))
    project = official.get('project')
    if 'project' not in official or 'project_sha256' not in official:
        reasons.append('Project-rule evidence is missing')
    elif project is None:
        if official['project_sha256'] is not None or board.with_suffix('.kicad_pro').exists():
            reasons.append('Project rules differ from evaluation without a project')
    elif not isinstance(project, str) or not project:
        reasons.append('Invalid evaluated project path')
    else:
        try:
            if hashlib.sha256(Path(project).read_bytes()).hexdigest() != official['project_sha256']:
                reasons.append('Project rules hash does not match evaluation')
        except OSError:
            reasons.append('Evaluated project rules are no longer readable')
    accepted = not reasons
    return {'verified': accepted,
            'clean': accepted if official else None,
            'edges_routed': official.get('edges_routed'), 'edges_total': official.get('edges_total'),
            'edges_remaining': official.get('edges_remaining'),
            'drc': official.get('total_drv'), 'drc_errors': official.get('drv_errors_only'),
            'length': official.get('wirelength_mm'), 'vias': official.get('via_count'),
            'verification_reasons': reasons,
            'verification_scope': 'Local official-report consistency and saved-board readability; not independent DRC'}
