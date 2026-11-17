"""Read-only, limited board geometry. No DRC or netlist validation."""
import math
import re
from pathlib import Path

_TOKEN = re.compile(r'\s+|;[^\n]*|[()]|"(?:\\.|[^"\\])*"|[^\s()"]+')


def parse_document(text: str, expected_root: str) -> list:
    """Parse a KiCad S-expression without evaluating input or requiring pcbnew."""
    stack: list[list] = []
    root = None
    end = 0
    for match in _TOKEN.finditer(text):
        if match.start() != end:
            raise ValueError("Invalid character or unterminated string in KiCad file")
        end = match.end()
        token = match.group()
        if token.isspace() or token.startswith(";"):
            continue
        if token == "(":
            node: list = []
            if stack:
                stack[-1].append(node)
            elif root is not None:
                raise ValueError("Multiple root expressions in KiCad file")
            else:
                root = node
            stack.append(node)
            if len(stack) > 256:
                raise ValueError("KiCad nesting exceeds preview limit")
        elif token == ")":
            if not stack:
                raise ValueError("Unexpected closing parenthesis in KiCad file")
            stack.pop()
        else:
            if not stack:
                raise ValueError("Expected a KiCad board expression")
            if token.startswith('"'):
                token = re.sub(r'\\(["\\])', r'\1', token[1:-1])
            stack[-1].append(token)
    if end != len(text) or stack or not root or root[0] != expected_root:
        raise ValueError("Not a complete KiCad document")
    return root


def parse_board(text: str) -> list:
    return parse_document(text, 'kicad_pcb')


def children(node, name):
    return [v for v in node[1:] if isinstance(v, list) and v and v[0] == name]


def field(node, name, default=()):
    values = children(node, name)
    return values[0][1:] if values else default


def number(value):
    result = float(value)
    if not math.isfinite(result) or abs(result) > 1_000_000:
        raise ValueError("Invalid coordinate in KiCad board")
    return result


def inspect_board(path, include_source=False):
    p = Path(path).expanduser().resolve()
    if p.suffix.lower() != '.kicad_pcb' or not p.is_file():
        raise ValueError('请选择存在的 .kicad_pcb 板文件。')
    if p.stat().st_size > 32 * 1024 * 1024:
        raise ValueError('板文件超过 32 MiB 预览限制。')
    source = p.read_text(encoding='utf-8-sig')
    root = parse_board(source)
    shapes = []
    def xy(vals):
        return [number(vals[0]), number(vals[1])]
    for kind in ('segment', 'gr_line', 'arc', 'gr_arc'):
        for node in children(root, kind):
            shape = {'type': 'arc' if 'arc' in kind else 'line', 'start': xy(field(node, 'start')), 'end': xy(field(node, 'end')),
                     'layer': field(node, 'layer', ['Edge.Cuts'])[0], 'width': number(field(node, 'width', [0.15])[0])}
            if shape['type'] == 'arc':
                shape['mid'] = xy(field(node, 'mid'))
            shapes.append(shape)
    for node in children(root, 'via'):
        shapes.append({'type': 'via', 'at': xy(field(node, 'at')), 'size': number(field(node, 'size', [0.6])[0]), 'layer': '*.Cu'})
    pads = 0
    for fp in children(root, 'footprint'):
        at = field(fp, 'at', [0, 0])
        fx, fy = xy(at)
        angle = number(at[2]) if len(at) > 2 else 0
        a = math.radians(angle)
        for pad in children(fp, 'pad'):
            pads += 1
            if len(pad) < 4 or pad[3] not in ('rect', 'circle', 'oval', 'roundrect'):
                continue
            local = field(pad, 'at', [0, 0])
            x, y = xy(local)
            shapes.append({'type': 'pad', 'shape': pad[3], 'at': [fx+x*math.cos(a)+y*math.sin(a), fy-x*math.sin(a)+y*math.cos(a)],
                           'size': xy(field(pad, 'size', [1, 1])), 'angle': angle+(number(local[2]) if len(local)>2 else 0),
                           'layer': field(pad, 'layers', ['*.Cu'])[0]})
    if len(shapes) > 100000:
        raise ValueError('板文件超过 100000 个图元预览限制。')
    result = {'path': str(p), 'name': p.name, 'footprints': len(children(root, 'footprint')), 'pads': pads,
            'tracks': len(children(root, 'segment'))+len(children(root, 'arc')), 'vias': len(children(root, 'via')),
            'nets': len(children(root, 'net')), 'shapes': shapes,
            'limitations': '只读简化预览；不显示铜皮、文字、自定义焊盘；尚未执行 DRC。'}
    if include_source:
        result['source'] = source
        import json
        if len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > 30 * 1024 * 1024:
            raise ValueError('板文件渲染数据超过 30 MiB，请在 KiCad 中打开。')
    return result
