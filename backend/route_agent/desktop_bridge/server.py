"""Local stdio RPC. Only fixed routing commands are accepted, never shell text."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
from uuid import uuid4

from route_agent.desktop.core import ROOT, RunSettings, redact, result_summary, routing_cli

from .board import inspect_board
from .schematic import inspect_schematic

MAX_LINE = 1024 * 1024


class Bridge:
    def __init__(self, emit):
        self.emit = emit
        self.lock = threading.RLock()
        self.process = None
        self.thread = None
        self.cancelled = False
        self.run_id = None
        self.secrets = []

    def _send(self, data):
        # Redact all strings including exception and structured response fields.
        def clean(value):
            if isinstance(value, str):
                return redact(value, self.secrets)
            if isinstance(value, dict):
                return {k: clean(v) for k, v in value.items()}
            if isinstance(value, list):
                return [clean(v) for v in value]
            return value
        self.emit(clean(data))

    def dispatch(self, request):
        req_id = request.get('id')
        try:
            if not isinstance(req_id, (str, int)) or isinstance(req_id, bool):
                raise TypeError('Request id must be a string or integer')
            params = request.get('params', {})
            if not isinstance(params, dict):
                raise TypeError('params must be an object')
            method = request.get('method')
            if method == 'inspect_board':
                result = inspect_board(params['board'], include_source=True)
            elif method == 'inspect_schematic':
                result = inspect_schematic(params['schematic'])
            elif method in ('run', 'status'):
                result = self.start(method, params)
            elif method == 'stop':
                result = self.stop()
            else:
                raise ValueError('Unknown method')
            self._send({'id': req_id, 'ok': True, 'result': result})
        except Exception as exc:  # noqa: BLE001 - RPC/process boundary must return a failure event
            self._send({'id': req_id, 'ok': False, 'error': str(exc)})

    def start(self, kind, params):
        with self.lock:
            if self.thread and self.thread.is_alive():
                raise RuntimeError('已有任务正在运行。')
            settings = RunSettings(**{k: v for k, v in params.items() if k in RunSettings.__dataclass_fields__}) if kind == 'run' else RunSettings('', '', runtime=params.get('runtime', ''))
            if kind == 'run' and settings.provider != 'none' and params.get('model_consent') is not True:
                raise ValueError('模型模式需要明确同意发送板规划数据并承担 API 费用。轮数不是费用上限。')
            key = params.get('api_key', '')
            if not isinstance(key, str):
                raise TypeError('Invalid API key value')
            # Redact provided keys even when subsequent validation fails.
            self.secrets = [key] + [v for k, v in os.environ.items() if any(t in k.upper() for t in ('KEY', 'TOKEN', 'SECRET'))]
            env = settings.environment(key)
            self.secrets += [v for k, v in env.items() if any(t in k.upper() for t in ('KEY', 'TOKEN', 'SECRET'))]
            run_dir = settings.create_run() if kind == 'run' else None
            command = settings.command(run_dir) if kind == 'run' else [sys.executable, '-u', '-m', routing_cli(), 'status']
            options = {'start_new_session': True} if os.name != 'nt' else {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP}
            self.process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, **options)
            self.cancelled = False
            self.run_id = uuid4().hex
            run_id = self.run_id
            self._send({'event': 'run', 'run_id': run_id, 'kind': kind, 'state': 'running', 'output_dir': str(run_dir) if run_dir else None})
            self.thread = threading.Thread(target=self._monitor, args=(self.process, run_id, kind, run_dir), daemon=True)
            self.thread.start()
            return {'run_id': run_id, 'output_dir': str(run_dir) if run_dir else None}

    def _monitor(self, process, run_id, kind, run_dir):
        log = None
        try:
            if run_dir:
                log = (run_dir / 'desktop.log').open('w', encoding='utf-8')
            while True:
                raw = process.stdout.readline(MAX_LINE + 1)
                if not raw:
                    break
                if len(raw) > MAX_LINE:
                    while raw and not raw.endswith(b'\n'):
                        raw = process.stdout.readline(MAX_LINE + 1)
                    line = '[超长日志行已丢弃]'
                else:
                    line = redact(raw.decode('utf-8', 'replace').rstrip('\r\n'), self.secrets)
                if log:
                    log.write(line + '\n')
                    log.flush()
                self._send({'event': 'log', 'run_id': run_id, 'line': line})
            code = process.wait()
            cancelled = self.cancelled
            state = 'cancelled' if cancelled else ('failed' if code else 'unverified')
            summary = None
            board = None
            if not cancelled and code == 0 and kind == 'run':
                report = run_dir / 'bench_report.json'
                if report.exists():
                    summary = result_summary(report)
                    state = 'verified' if summary['verified'] and summary['clean'] else 'unverified'
                if (run_dir / 'routed.kicad_pcb').is_file():
                    board = str(run_dir / 'routed.kicad_pcb')
            if kind == 'status' and not cancelled:
                state = 'checked' if code == 0 else 'failed'
            self._send({'event': 'result', 'run_id': run_id, 'kind': kind, 'exit_code': code, 'cancelled': cancelled,
                        'state': state, 'output_dir': str(run_dir) if run_dir else None, 'summary': summary, 'board': board})
        except Exception as exc:  # noqa: BLE001 - RPC/process boundary must return a failure event
            self._send({'event': 'result', 'run_id': run_id, 'kind': kind, 'state': 'failed', 'error': str(exc), 'summary': None})
            if process.poll() is None:
                self.stop()
        finally:
            if log:
                log.close()
            process.stdout.close()

    def stop(self):
        with self.lock:
            p = self.process
            if p is None or p.poll() is not None:
                return {'stopping': False}
            self.cancelled = True
            self._send({'event': 'run', 'run_id': self.run_id, 'state': 'stopping'})
            # Windows taskkill /T kills descendant engine processes as well. No shell.
            if os.name == 'nt':
                subprocess.run(['taskkill', '/PID', str(p.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            else:
                try:
                    os.killpg(p.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                def force():
                    try:
                        p.wait(timeout=2.5)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(p.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                threading.Thread(target=force, daemon=True).start()
            return {'stopping': True}


def main():
    write_lock = threading.Lock()
    def emit(data):
        with write_lock:
            sys.stdout.write(json.dumps(data, ensure_ascii=False, allow_nan=False) + '\n')
            sys.stdout.flush()
    bridge = Bridge(emit)
    try:
        while True:
            raw = sys.stdin.buffer.readline(MAX_LINE + 1)
            if not raw:
                break
            try:
                if len(raw) > MAX_LINE:
                    while raw and not raw.endswith(b'\n'):
                        raw = sys.stdin.buffer.readline(MAX_LINE + 1)
                    raise ValueError('Request exceeds 1 MiB')
                request = json.loads(raw)
                if not isinstance(request, dict):
                    raise TypeError('Request must be an object')
                bridge.dispatch(request)
            except Exception as exc:  # noqa: BLE001 - RPC/process boundary must return a failure event
                # Do not echo invalid input, which might contain credentials.
                emit({'id': None, 'ok': False, 'error': 'Invalid request: ' + type(exc).__name__})
    finally:
        bridge.stop()
        if bridge.thread:
            bridge.thread.join(timeout=5)


if __name__ == '__main__':
    main()
