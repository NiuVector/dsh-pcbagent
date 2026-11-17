"""Local Freerouting DSN/SES backend with real KiCad conversion and DRC."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from route_agent.freerouting_result import drc_counts, sha256, summarize

ROOT = Path(__file__).resolve().parents[2]


def tools() -> dict[str, str]:
    names = {'freerouting': 'PCBROUTE_FREEROUTING_EXE', 'kicad_python': 'PCBROUTE_KICAD_PYTHON', 'kicad_cli': 'KICAD_CLI'}
    result = {}
    for name, variable in names.items():
        value = os.environ.get(variable, '')
        if not value or not Path(value).is_file():
            raise ValueError('Configure a trusted executable path in ' + variable)
        result[name] = str(Path(value).resolve())
    return result


def run(command: list[str], cwd: Path, timeout: int, log: Path) -> subprocess.CompletedProcess:
    """Run a fixed argv command without a shell; keep its diagnostic output."""
    started = time.monotonic()
    result = subprocess.run(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, timeout=timeout, check=False,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    output = result.stdout.decode('utf-8', 'replace')
    log.write_text(output, encoding='utf-8')
    print(output[-16000:], flush=True)
    print(json.dumps({'step_seconds': round(time.monotonic() - started, 2), 'exit_code': result.returncode}), flush=True)
    return result


def sidecars(source: Path, target: Path):
    for suffix in ('.kicad_pro', '.kicad_dru'):
        path = source.with_suffix(suffix)
        if path.is_file():
            shutil.copy2(path, target.with_suffix(suffix))


def bench(args) -> int:
    if args.provider != 'none':
        raise ValueError('Freerouting is a local deterministic backend. Model replanning requires the separate PCBWorld engine.')
    configured = tools()
    board = Path(args.board).resolve()
    if board.suffix.lower() != '.kicad_pcb' or not board.is_file():
        raise ValueError('Select an existing .kicad_pcb board')
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if args.save and Path(args.save).resolve() != out / 'routed.kicad_pcb':
        raise ValueError('This backend saves only to the selected run directory')
    if board == out / 'routed.kicad_pcb' or (out / 'bench_report.json').exists() or (out / 'routed.kicad_pcb').exists():
        raise ValueError('Use a new run directory; existing results are not overwritten')
    staging = out / 'specctra'
    staging.mkdir(exist_ok=False)
    staged_board = staging / 'input.kicad_pcb'
    original_hash = sha256(board)
    shutil.copy2(board, staged_board)
    sidecars(board, staged_board)
    routed = out / 'routed.kicad_pcb'
    sidecars(board, routed)
    worker = ROOT / 'route_agent' / 'kicad_specctra.py'
    timeout = int(os.environ.get('PCBROUTE_ROUTE_TIMEOUT', '600'))
    if not 10 <= timeout <= 86400:
        raise ValueError('Routing timeout must be between 10 and 86400 seconds')
    print('Engine: Freerouting 2.5.0. Validation: actual KiCad CLI DRC. PCBWorld scoring is not used.', flush=True)
    exported = run([configured['kicad_python'], str(worker), 'export', str(staged_board), 'input.dsn'],
                   staging, 120, out / 'kicad-export.log')
    if exported.returncode or not (staging / 'input.dsn').is_file():
        raise RuntimeError('KiCad DSN export failed; see kicad-export.log')
    routed_result = run([configured['freerouting'], '-de', 'input.dsn', '-do', 'routed.ses', '-mp', '20', '-mt', '4',
                         '-da', '--api_server.enabled=false', '--gui.enabled=false',
                         '--user_data_path=' + str(staging / 'freerouting-data')],
                        staging, timeout, out / 'freerouting.log')
    if routed_result.returncode or not (staging / 'routed.ses').is_file():
        raise RuntimeError('Freerouting did not produce a session file; see freerouting.log')
    imported = run([configured['kicad_python'], str(worker), 'import', str(staged_board), 'routed.ses', '--output', str(routed)],
                   staging, 120, out / 'kicad-import.log')
    if imported.returncode or not routed.is_file():
        raise RuntimeError('KiCad SES import failed; see kicad-import.log')
    metrics = json.loads(imported.stdout.decode('utf-8').strip().splitlines()[-1])
    drc = out / 'kicad-drc.json'
    checked = run([configured['kicad_cli'], 'pcb', 'drc', str(routed), '--format', 'json', '--all-track-errors',
                   '--severity-all', '--exit-code-violations', '--refill-zones', '--save-board', '--output', str(drc)],
                  out, 120, out / 'kicad-drc.log')
    if checked.returncode not in (0, 5) or not drc.is_file():
        raise RuntimeError('KiCad DRC failed to produce a complete report')
    if sha256(board) != original_hash:
        raise RuntimeError('Source board changed during the run; result is not accepted')
    counts = drc_counts(json.loads(drc.read_text('utf-8-sig')))
    evidence = {'source': 'kicad-cli pcb drc', 'exit_code': checked.returncode,
                'board_sha256': sha256(routed), 'drc_sha256': sha256(drc), 'counts': counts}
    for suffix, key in (('.kicad_pro', 'project_sha256'), ('.kicad_dru', 'rules_sha256')):
        path = routed.with_suffix(suffix)
        evidence[key] = sha256(path) if path.is_file() else None
    report = {'engine': 'freerouting', 'engine_version': '2.5.0', 'source_board': str(board),
              'source_sha256': original_hash, 'metrics': metrics, 'validation': evidence}
    report_path = out / 'bench_report.json'
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    summary = summarize(report, report_path)
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('status')
    route = sub.add_parser('bench')
    route.add_argument('board')
    route.add_argument('--out', required=True)
    route.add_argument('--save')
    route.add_argument('--provider', default='none')
    route.add_argument('--max-global-rounds', type=int, default=0)
    route.add_argument('--model')
    args = parser.parse_args()
    try:
        if args.command == 'status':
            print(json.dumps({'engine': 'Freerouting 2.5.0', 'executables': tools(), 'model_calls': False,
                              'validation': 'KiCad CLI DRC; separate PCBWorld engine unavailable'}, indent=2))
            return 0
        return bench(args)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print('Routing failed: ' + str(exc), file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
