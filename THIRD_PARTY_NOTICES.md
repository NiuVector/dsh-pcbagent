# Third-party notices

- **DeepSeek Harness** — MIT, <https://github.com/deepseek-ai/deepseek-harness>, source commit `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`. The plugin adapts the supplied PCB integration and uses DSH's client build/runtime contracts. Root `LICENSE` retains the MIT notice.
- **PCBRouteAgent** — BSD-3-Clause, <https://github.com/chip-ai-agent/PCBRouteAgent>. Local bridge, inspection and Freerouting adaptation from the supplied `PCBRouteAgent_DSH_Reliability_Source_20261111` archive. See `licenses/PCBRouteAgent-BSD-3-Clause.txt`. The paper's PCBWorld executor and model-planning pipeline are not included.
- **KiCanvas** — MIT, <https://github.com/theacodes/kicanvas>, commit `b031159eb74aaa7eef2b026fd85d35bc05ff2095`. Included in generated renderer source; local modifications are provided in `third_party/`. See `licenses/LICENSE.md`.
- **KiCad newstroke font** — retained license and exception in `licenses/NEWSTROKE-LICENSE.txt`; embedded by KiCanvas.
- **Google Material Symbols** — Apache-2.0, <https://github.com/google/material-design-icons>. The static outlined subset is embedded in generated source. See `licenses/MATERIAL-SYMBOLS-LICENSE.txt`.
- **Zod** — MIT, installed runtime dependency. Its npm distribution carries its license.

**External programs:** KiCad and Freerouting are invoked as separately installed programs. Their binaries are not part of this repository or npm tarball. Freerouting is GPLv3; use its official distribution and license. KiCad's own licensing remains with its official installation.

No endorsement by any upstream project is implied.
