// PCBRouteAgent stdio carrier, adapted from dsh-desktop/electron/transport.cjs.
// Changes: constructor-only Python executable/environment overrides.
'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const METHODS = new Set(['status', 'inspect_board', 'inspect_schematic', 'run', 'stop']);
const EVENTS = new Set(['log', 'run', 'result']);
const MAX_LINE = 1024 * 1024;
// Read-only board previews can contain up to 100,000 geometry records. Keep
// incoming responses bounded independently from the smaller command envelope.
const MAX_RESPONSE_LINE = 32 * 1024 * 1024;

function pythonFor(root, env = process.env, platform = process.platform) {
  if (env.PCBROUTE_PYTHON) return env.PCBROUTE_PYTHON;
  const local = platform === 'win32'
    ? path.join(root, '.venv-windows', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
  return existsSync(local) ? local : platform === 'win32' ? 'python' : 'python3';
}

/** Fixed-method stdio transport. Requests and stderr are never logged. */
class BridgeTransport extends EventEmitter {
  constructor(root, options = {}) {
    super();
    this.pending = new Map();
    this.counter = 0;
    this.buffer = '';
    this.closed = false;
    this.closing = false;
    this.timeout = options.timeout ?? 30000;
    const env = { ...process.env, ...options.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
    this.child = (options.spawn ?? spawn)((options.pythonExecutable || pythonFor(root, env)), ['-u', '-m', 'route_agent.desktop_bridge'], {
      cwd: root, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.consume(chunk));
    // Drain stderr without forwarding uncontrolled tracebacks or credential values.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.fail('后端连接已断开，请重新启动应用。'));
    this.child.on('error', () => this.fail('无法启动 Python 后端，请检查 PCBROUTE_PYTHON 和依赖。'));
    this.child.on('close', () => this.fail('Python 后端已退出，请重新启动应用。'));
  }

  consume(chunk) {
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_RESPONSE_LINE) return this.protocolFailure();
      let message;
      try { message = JSON.parse(line); } catch { return this.protocolFailure(); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return this.protocolFailure();
      if (typeof message.id === 'string') {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok === true) pending.resolve(message.result);
        else if (message.ok === false) {
          const error = new Error(typeof message.error === 'string' ? message.error : '后端请求失败。');
          // This tag is assigned by the carrier, never copied from response data.
          error.code = 'PCB_REJECTED';
          pending.reject(error);
        } else {
          pending.reject(new Error('后端响应格式错误；操作结果未知。'));
          return this.protocolFailure();
        }
      } else if (EVENTS.has(message.event)) {
        this.emit('event', message);
      } else return this.protocolFailure();
    }
    if (Buffer.byteLength(this.buffer) > MAX_RESPONSE_LINE) this.protocolFailure();
  }

  protocolFailure() {
    this.fail('后端协议错误，请重新启动应用。');
    this.child.stdin.end();
  }

  request(method, params = {}) {
    if (!METHODS.has(method)) return Promise.reject(new Error('不支持的操作。'));
    if (!params || typeof params !== 'object' || Array.isArray(params)) return Promise.reject(new Error('参数必须是对象。'));
    if (this.closed || this.closing) return Promise.reject(new Error('后端连接不可用。'));
    if (this.pending.size >= 64) return Promise.reject(new Error('待处理请求过多。'));
    const id = String(++this.counter);
    let line;
    try { line = JSON.stringify({ id, method, params }) + '\n'; } catch { return Promise.reject(new Error('参数无法序列化。')); }
    if (Buffer.byteLength(line) > MAX_LINE) return Promise.reject(new Error('请求过大。'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('后端响应超时。操作结果未知，请检查任务状态，不要重复启动。'));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(line, error => {
        if (error) this.fail('后端连接已断开，请重新启动应用。');
      });
    });
  }

  fail(message) {
    if (this.closed) return;
    this.closed = true;
    this.buffer = '';
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
    if (!this.closing) this.emit('event', { event: 'connection', state: 'failed', error: message });
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    if (this.child.exitCode !== null && this.child.exitCode !== undefined) return;
    // EOF is handled by the Python bridge's finally block, which stops workers.
    await new Promise(resolve => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        if (process.platform === 'win32' && Number.isSafeInteger(this.child.pid)) {
          // A hung bridge must not leave its routing engine behind on Windows.
          const killer = spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], {
            shell: false, windowsHide: true, stdio: 'ignore',
          });
          killer.once('error', () => { this.child.kill(); finish(); });
          killer.once('close', finish);
        } else { this.child.kill(); finish(); }
      }, 7000);
      this.child.once('close', finish);
      this.child.stdin.end();
    });
    this.fail('应用已关闭。');
  }
}

module.exports = { BridgeTransport, pythonFor, METHODS, MAX_LINE, MAX_RESPONSE_LINE };
