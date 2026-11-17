"""Specctra conversion in KiCad's own Python process and ABI."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main():
    import pcbnew

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('export', 'import'))
    parser.add_argument('board')
    parser.add_argument('exchange')
    parser.add_argument('--output')
    args = parser.parse_args()
    board = pcbnew.LoadBoard(str(Path(args.board).resolve()))
    if board is None:
        raise RuntimeError('KiCad could not load the board')
    if args.operation == 'export':
        if not pcbnew.ExportSpecctraDSN(board, str(Path(args.exchange).resolve())):
            raise RuntimeError('KiCad DSN export failed')
    else:
        if not args.output:
            parser.error('--output is required for import')
        if not pcbnew.ImportSpecctraSES(board, str(Path(args.exchange).resolve())):
            raise RuntimeError('KiCad SES import failed')
        if not pcbnew.SaveBoard(str(Path(args.output).resolve()), board):
            raise RuntimeError('KiCad could not save the routed board')
    tracks = list(board.GetTracks())
    vias = sum(isinstance(track, pcbnew.PCB_VIA) for track in tracks)
    length = sum(pcbnew.ToMM(track.GetLength()) for track in tracks if not isinstance(track, pcbnew.PCB_VIA))
    print(json.dumps({'kicad': pcbnew.GetBuildVersion(), 'tracks': len(tracks) - vias,
                      'vias': vias, 'wirelength_mm': length}))


if __name__ == '__main__':
    main()
