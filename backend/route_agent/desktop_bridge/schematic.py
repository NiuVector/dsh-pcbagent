"""Read a KiCad schematic and its contained hierarchy for the local viewer."""
import json
from pathlib import Path

from .board import children, parse_document


def inspect_schematic(path):
    main = Path(path).expanduser().resolve()
    if main.suffix.lower() != '.kicad_sch' or not main.is_file():
        raise ValueError('请选择存在的 .kicad_sch 原理图')
    root_dir = main.parent
    pending = [main]
    seen = set()
    sources = []
    symbols = 0
    total = 0
    while pending:
        current = pending.pop(0).resolve()
        if current in seen:
            continue
        if not current.is_relative_to(root_dir):
            raise ValueError('原理图引用了工程目录以外的子图')
        if current.suffix.lower() != '.kicad_sch' or not current.is_file():
            raise ValueError('找不到原理图引用的子图：' + current.name)
        if len(seen) >= 64 or current.stat().st_size > 16 * 1024 * 1024:
            raise ValueError('原理图超出 64 个图纸或单文件 16 MiB 的查看限制')
        source = current.read_text('utf-8-sig')
        total += len(source.encode('utf-8'))
        if total > 24 * 1024 * 1024:
            raise ValueError('原理图工程超出 24 MiB 的查看限制')
        root = parse_document(source, 'kicad_sch')
        seen.add(current)
        sources.append({'name': current.relative_to(root_dir).as_posix(), 'source': source})
        symbols += len(children(root, 'symbol'))
        for sheet in children(root, 'sheet'):
            for prop in children(sheet, 'property'):
                if len(prop) >= 3 and prop[1].lower().replace(' ', '') == 'sheetfile':
                    pending.append(current.parent / prop[2])
    result = {'kind': 'schematic', 'name': main.name, 'path': str(main), 'source': sources[0]['source'],
              'sources': sources, 'symbols': symbols, 'sheets': len(sources)}
    if len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > 30 * 1024 * 1024:
        raise ValueError('原理图渲染数据超过 30 MiB')
    return result
