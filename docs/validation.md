# Validation

## Independent package — 2026-11-17

- Standalone build using the pinned DSH client build preset and decorator lowering: passed.
- Browser Remote mount/disposal, failed-activation cleanup and renderer/brand checks: 3 passed (`npm test`).
- Included Python bridge, schematic hierarchy and Freerouting evidence checks: 23 passed (`python -m unittest discover -s tests -v`, from `backend/`).
- Publication-view check rejects local machine paths, credential patterns, cached Python bytecode, source maps, native binaries and missing runtime exports: passed (`npm run check`).
- `npm pack --ignore-scripts` produces a prebuilt installable tarball. A fresh DSH web profile installed it using the official `dsh plugin` command without an install-time build script.

The release is pinned to DSH `0.2.2-rc.1`. The test host is the supplied DSH source archive. Its earlier in-box PCB Remote registration is removed from the test's API assembly fixture so that the external package must mount its own Remote. That fixture is test setup and is not part of the plugin payload. Installing this independent plugin alongside the old embedded PCB integration is unsupported; remove the old integration first.

## Earlier complete-application evidence — 2026-11-14

The same dual-view renderer and routing adapter were previously verified inside the supplied full DSH integration on Windows: build:artifacts 8 passed, build:check 2 passed, focused UI/controller/renderer/style tests 39 passed. Actual browser checks covered paired project opening, single views, search, routing/settings/results dialogs, narrow layout and light appearance.

KiCad's ECC83 example loaded 26 schematic symbols, one sheet, 15 PCB footprints and 33 pads. A hierarchical example loaded two sheets and 73 symbols. Local routing of a small three-net board completed with 0 DRC errors, 0 unconnected items, 12 visible warnings, 82.79 mm wire length and 2 vias. The source board was unchanged.

The earlier full GUI suite had 13114 passed, 2 skipped and one pre-existing Windows EPERM symlink-permission failure in the deliverables package. That exhaustive suite was not repeated for the packaging change. This release does not claim successful routing of arbitrary boards, non-Windows end-to-end acceptance, schematic parity validation, PCBWorld scoring, or manufacturing approval.
