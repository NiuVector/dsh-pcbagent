# Development

The checked-in `lib/` is the installable plugin. Git installs need no prepare script or install-time build permission. Python inspection uses only the standard library. The plugin requires the DSH web or desktop client and pins DSH `0.2.2-rc.1`; later pre-stable releases need a compatibility check.

To rebuild, prepare the official DeepSeek Harness source at commit `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`, run its documented dependency installation, and run:

```sh
npm install --ignore-scripts
node scripts/build.mjs --dsh-source /path/to/deepseek-harness
npm test
npm run check
npm pack
```

The builder uses DSH's client bundler and standard decorator lowering. It does not copy or modify the DSH application. The generated Remote descriptors under `src/generated/` are derived from the supplied PCB host package and re-owned by this standalone package. When changing a Remote signature, regenerate both artifacts using DSH's Typert generator; do not alter only the browser side.

`src/host` and `src/client` contain the plugin implementation. `backend/` contains the BSD-licensed local bridge, KiCad reader and Freerouting adapter. It deliberately excludes PCBWorld, paid model planners, Qt, KiCad binaries, Freerouting binaries and machine data.

KiCanvas is pinned to `b031159eb74aaa7eef2b026fd85d35bc05ff2095`. `third_party/kicanvas.patch` and `third_party/kicanvas-extra/` contain the local renderer adaptation. The generated renderer and embedded Material Symbols font are checked in under `src/client/engine`. The complete applicable licenses are in `licenses/`.

The original in-application acceptance evidence is in `docs/validation.md`. Package acceptance additionally exercises a fresh profile, the independently mounted Remote, and the packed publication view. Model calls are not needed for these checks.
