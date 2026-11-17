import { createRequire } from "node:module";
import z from "@deepseek-ai/schemastery";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { readFileSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
//#region src/host/owner.ts
/** Realpath-based capability boundary, including output paths not yet created. */
async function checkedPath(value, roots, mode) {
	if (typeof value !== "string" || !value || !isAbsolute(value) || value.includes("\0")) throw new Error("Use an absolute PCB path");
	const target = resolve(value);
	let existing = target;
	while (true) try {
		existing = await realpath(existing);
		break;
	} catch (error) {
		if (error.code !== "ENOENT" || mode === "file") throw new Error("PCB path does not exist or cannot be resolved");
		const parent = dirname(existing);
		if (parent === existing) throw new Error("Invalid output path");
		existing = parent;
	}
	let originalAncestor = target;
	if (mode === "output") while (true) try {
		await stat(originalAncestor);
		break;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		originalAncestor = dirname(originalAncestor);
	}
	const canonical = mode === "file" ? existing : resolve(existing, relative(originalAncestor, target));
	if (!(await Promise.all(roots.map((root) => realpath(root)))).some((root) => {
		const rel = relative(root, canonical);
		return rel === "" || !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
	})) throw new Error("PCB path is outside the configured allowedRoots");
	if (mode === "file" && !(await stat(canonical)).isFile()) throw new Error("PCB input must be a file");
	return canonical;
}
/** One transport per agent. Never route cancellation across session ownership. */
var PcbOwner = class {
	bridge;
	current = {
		runId: null,
		state: "idle",
		logs: [],
		result: null
	};
	busy = false;
	starting = false;
	dead = false;
	finishing;
	finish;
	cancellationRequested = false;
	constructor(bridge) {
		this.bridge = bridge;
		bridge.on("event", (event) => this.accept(event));
	}
	snapshot() {
		return structuredClone(this.current);
	}
	accept(event) {
		if (this.dead) return;
		if (event.event === "connection") {
			this.dead = true;
			if (!this.busy) return;
			this.busy = false;
			this.current.state = "failed";
			this.current.result = { error: "PCB bridge connection lost; operation outcome may be unknown" };
			this.finish?.(this.current.result);
			this.finish = void 0;
			return;
		}
		if (!this.busy || typeof event.run_id !== "string") return;
		if (event.event === "run" && event.state === "running" && this.busy && this.current.runId === null) {
			this.current.runId = event.run_id;
			this.current.state = "running";
			if (this.cancellationRequested) this.stop().catch(() => {});
		}
		if (event.run_id !== this.current.runId) return;
		if (event.event === "log" && typeof event.line === "string") {
			this.current.logs.push(event.line.slice(0, 4096));
			if (this.current.logs.length > 500) this.current.logs.shift();
		} else if (event.event === "run" && event.state === "stopping") this.current.state = "stopping";
		else if (event.event === "result") {
			this.busy = false;
			this.current.state = typeof event.state === "string" ? event.state : "failed";
			this.current.result = JSON.parse(JSON.stringify(event));
			this.finish?.(this.current.result);
			this.finish = void 0;
		}
	}
	async inspect(params) {
		if (this.dead) throw new Error("PCB bridge unavailable");
		return await this.bridge.request("inspect_board", params);
	}
	async inspectSchematic(params) {
		if (this.dead) throw new Error("PCB bridge unavailable");
		return await this.bridge.request("inspect_schematic", params);
	}
	async start(method, params, signal) {
		signal?.throwIfAborted();
		if (this.dead) throw new Error("PCB bridge unavailable");
		if (this.busy || this.starting) throw new Error("A PCB operation is already running in this session");
		this.busy = true;
		this.starting = true;
		this.cancellationRequested = false;
		this.current = {
			runId: null,
			state: "starting",
			logs: [],
			result: null
		};
		this.finishing = new Promise((resolve) => {
			this.finish = resolve;
		});
		const cancel = () => {
			this.cancellationRequested = true;
			this.stop().catch(() => {});
		};
		signal?.addEventListener("abort", cancel, { once: true });
		this.finishing.finally(() => signal?.removeEventListener("abort", cancel));
		try {
			const result = await this.bridge.request(method, params);
			if (!result || typeof result.run_id !== "string") throw new Error("Invalid PCB start acknowledgement");
			if (this.dead) throw new Error("PCB bridge unavailable");
			if (this.current.runId === null) {
				this.current.runId = result.run_id;
				this.current.state = "running";
			}
			if (this.current.runId !== result.run_id) throw new Error("PCB run identity mismatch");
			if (signal?.aborted) cancel();
			return result;
		} catch (error) {
			if (!this.busy) {} else if (error instanceof Error && error.code === "PCB_REJECTED" && this.current.runId === null) {
				this.busy = false;
				this.current.state = "failed";
				this.current.result = {
					state: "failed",
					error: error.message
				};
				this.finish?.(this.current.result);
				this.finish = void 0;
			} else this.current.state = "unknown";
			throw error;
		} finally {
			this.starting = false;
		}
	}
	/** Run a tool operation without switching to a subsequent operation's completion.
	* @param method Operation to launch.
	* @param params Validated backend arguments.
	* @param signal Optional cancellation signal; absent means no caller cancellation.
	* @param diagnostics Include this operation's last 100 log lines when true.
	* @returns Backend result, or the result and operation-local diagnostics.
	*/
	async runToCompletion(method, params, signal, diagnostics = false) {
		const started = this.start(method, params, signal);
		const completion = this.finishing;
		const operation = this.current;
		await started;
		if (!completion) throw new Error("PCB operation has no completion");
		const result = await completion;
		return diagnostics ? {
			result,
			diagnostics: operation.logs.slice(-100)
		} : result;
	}
	async wait() {
		if (!this.finishing) throw new Error("No PCB operation was started");
		return this.finishing;
	}
	async stop() {
		this.cancellationRequested = true;
		if (!this.busy) return { stopping: false };
		return await this.bridge.request("stop");
	}
	async close() {
		this.dead = true;
		try {
			await this.bridge.close();
		} finally {
			this.dead = true;
			if (this.busy) {
				this.busy = false;
				this.current.state = "cancelled";
				this.current.result = {
					cancelled: true,
					state: "cancelled",
					error: "PCB owner disposed; no output accepted"
				};
				this.finish?.(this.current.result);
				this.finish = void 0;
			}
		}
	}
};
//#endregion
//#region src/host/catalog.ts
/** List bounded KiCad files under deployment-owned roots without following symlinks. */
async function designCatalog(roots) {
	const files = [];
	let visited = 0;
	const canonical = await Promise.all(roots.map((root) => realpath(root)));
	const inside = (path) => canonical.some((root) => {
		const rel = relative(root, path);
		return rel === "" || !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
	});
	const visit = async (directory, depth, root) => {
		if (depth > 4 || visited >= 2e3 || files.length >= 400) return;
		const actual = await realpath(directory);
		if (!inside(actual)) return;
		const entries = await readdir(actual, { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (++visited > 2e3 || files.length >= 400) return;
			if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
			const path = resolve(actual, entry.name);
			if (entry.isDirectory()) await visit(path, depth + 1, root);
			else if (entry.isFile()) {
				const extension = extname(entry.name).toLowerCase();
				const kind = extension === ".kicad_pro" ? "project" : extension === ".kicad_sch" ? "schematic" : extension === ".kicad_pcb" ? "board" : void 0;
				if (kind === void 0) continue;
				const checked = await checkedPath(path, canonical, "file");
				files.push({
					path: checked,
					name: basename(checked),
					directory: dirname(checked),
					relativePath: relative(root, checked),
					kind
				});
			}
		}
	};
	for (const root of canonical) await visit(root, 0, root);
	return {
		files,
		defaultOutput: canonical[0] ? resolve(canonical[0], "runs") : ""
	};
}
//#endregion
//#region src/host/index.ts
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
const require = createRequire(import.meta.url);
/** Remote owner resolves the caller's Agent through the official Gateway. */
let PcbController = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _inspect_decorators;
	let _schematic_decorators;
	let _files_decorators;
	let _status_decorators;
	let _run_decorators;
	let _stop_decorators;
	let _snapshot_decorators;
	return class PcbController extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_inspect_decorators = [Remote];
			_schematic_decorators = [Remote];
			_files_decorators = [Remote];
			_status_decorators = [Remote];
			_run_decorators = [Remote];
			_stop_decorators = [Remote];
			_snapshot_decorators = [Remote];
			__esDecorate(this, null, _inspect_decorators, {
				kind: "method",
				name: "inspect",
				static: false,
				private: false,
				access: {
					has: (obj) => "inspect" in obj,
					get: (obj) => obj.inspect
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _schematic_decorators, {
				kind: "method",
				name: "schematic",
				static: false,
				private: false,
				access: {
					has: (obj) => "schematic" in obj,
					get: (obj) => obj.schematic
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _files_decorators, {
				kind: "method",
				name: "files",
				static: false,
				private: false,
				access: {
					has: (obj) => "files" in obj,
					get: (obj) => obj.files
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _status_decorators, {
				kind: "method",
				name: "status",
				static: false,
				private: false,
				access: {
					has: (obj) => "status" in obj,
					get: (obj) => obj.status
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _run_decorators, {
				kind: "method",
				name: "run",
				static: false,
				private: false,
				access: {
					has: (obj) => "run" in obj,
					get: (obj) => obj.run
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _stop_decorators, {
				kind: "method",
				name: "stop",
				static: false,
				private: false,
				access: {
					has: (obj) => "stop" in obj,
					get: (obj) => obj.stop
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _snapshot_decorators, {
				kind: "method",
				name: "snapshot",
				static: false,
				private: false,
				access: {
					has: (obj) => "snapshot" in obj,
					get: (obj) => obj.snapshot
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = [
			"typert",
			"remoteAccess",
			"tools",
			"approval"
		];
		static Config = z.object({
			pcbRoot: z.string().required(),
			pythonExecutable: z.string(),
			runtimePath: z.string(),
			allowedRoots: z.array(z.string()).default([])
		});
		owners = (__runInitializers(this, _instanceExtraInitializers), /* @__PURE__ */ new Map());
		settings;
		engineEnv = {};
		constructor(ctx, config) {
			super(ctx, "pcbController", { namespace: "pcb" });
			this.settings = PcbController.Config(config);
			if (this.settings.runtimePath) {
				const file = resolve(this.settings.runtimePath);
				const runtime = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
				if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) throw new Error("Invalid configured PCB runtime");
				const data = runtime;
				const pathValue = (value) => {
					if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("Invalid configured PCB runtime path");
					return isAbsolute(value) ? value : resolve(dirname(file), value);
				};
				this.engineEnv.PCBWORLD_ENGINE_PYTHON = pathValue(data.python);
				this.engineEnv.PCBWORLD_KICAD_RL_MODULE_DIR = pathValue(data.module_dir);
				if (data.dll_dirs !== void 0 && (!Array.isArray(data.dll_dirs) || !data.dll_dirs.every((v) => typeof v === "string"))) throw new Error("Invalid configured DLL directories");
				this.engineEnv.PCBWORLD_ENGINE_DLL_DIRS = (data.dll_dirs ?? []).map(pathValue).join(process.platform === "win32" ? ";" : ":");
			}
			ctx.effect(() => async () => {
				await Promise.all([...this.owners.values()].map((owner) => owner.close()));
				this.owners.clear();
			});
			this.registerTools(ctx);
		}
		owner(agent) {
			let owner = this.owners.get(agent.id);
			if (owner) return owner;
			if (this.owners.size >= 8) throw new Error("PCB session limit reached; close unused sessions");
			const { BridgeTransport } = require("./transport.cjs");
			owner = new PcbOwner(new BridgeTransport(resolve(this.settings.pcbRoot), {
				env: this.engineEnv,
				...this.settings.pythonExecutable ? { pythonExecutable: this.settings.pythonExecutable } : {}
			}));
			this.owners.set(agent.id, owner);
			const owned = owner;
			agent.ctx.effect(() => async () => {
				await owned.close();
				if (this.owners.get(agent.id) === owned) this.owners.delete(agent.id);
			});
			return owner;
		}
		async runtime(request) {
			if (request.runtime) throw new Error("Runtime is host-configured; tool/UI runtime paths are not accepted");
			return {};
		}
		async routeArgs(request) {
			const provider = request.provider ?? "none";
			if (![
				"none",
				"openai",
				"anthropic"
			].includes(provider)) throw new Error("Unsupported PCB model provider");
			const rounds = request.rounds ?? 0;
			if (!Number.isInteger(rounds) || rounds < 0 || rounds > 100) throw new Error("PCB rounds must be an integer from 0 to 100");
			if (!request.board.toLowerCase().endsWith(".kicad_pcb")) throw new Error("Select a .kicad_pcb board");
			return {
				...await this.runtime(request),
				board: await checkedPath(request.board, this.settings.allowedRoots, "file"),
				output: await checkedPath(request.output, this.settings.allowedRoots, "output"),
				provider,
				model: request.model ?? "",
				rounds
			};
		}
		/** Real geometry, not a mock board. */
		async inspect(agent, request) {
			const board = await checkedPath(request.board, this.settings.allowedRoots, "file");
			return this.owner(agent).inspect({ board });
		}
		/** Local schematic hierarchy; paths remain within the configured roots. */
		async schematic(agent, request) {
			if (!request.schematic.toLowerCase().endsWith(".kicad_sch")) throw new Error("Select a .kicad_sch schematic");
			const schematic = await checkedPath(request.schematic, this.settings.allowedRoots, "file");
			return this.owner(agent).inspectSchematic({ schematic });
		}
		/** KiCad file picker metadata for this deployment's allowed directories. */
		async files(agent) {
			return designCatalog(this.settings.allowedRoots);
		}
		/** Starts read-only runtime diagnostics; poll snapshot for completion. */
		async status(agent, request) {
			return this.owner(agent).start("status", await this.runtime(request));
		}
		/** Direct user UI action is deliberately model-free. A caller boolean is never consent. */
		async run(agent, request) {
			if (request.provider !== void 0 && request.provider !== "none") throw new Error("Model PCB routing must use the agent tool approval flow");
			return this.owner(agent).start("run", await this.routeArgs({
				...request,
				provider: "none"
			}));
		}
		stop(agent) {
			return this.owner(agent).stop();
		}
		snapshot(agent) {
			return this.owners.get(agent.id)?.snapshot() ?? {
				runId: null,
				state: "idle",
				logs: [],
				result: null
			};
		}
		registerTools(ctx) {
			const output = {
				schema: { type: "json" },
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value)
				}]
			};
			const board = {
				type: "string",
				required: true,
				description: "Absolute .kicad_pcb path inside configured allowedRoots."
			};
			ctx.tools.register(defineTool({
				name: "pcb_inspect",
				description: "Read actual PCB geometry and counts. Does not route or verify DRC.",
				parameters: { board },
				output,
				execute: async (args, exec) => {
					exec.signal.throwIfAborted();
					if (!exec.agent) throw new Error("PCB tools require an owning agent");
					const result = await this.inspect(exec.agent, args);
					if (result && typeof result === "object" && !Array.isArray(result)) {
						const { shapes, source: _source, ...summary } = result;
						return {
							...summary,
							previewShapeCount: Array.isArray(shapes) ? shapes.length : 0
						};
					}
					return result;
				}
			}));
			ctx.tools.register(defineTool({
				name: "pcb_status",
				description: "Check PCB routing runtime. Exit zero means diagnostics ran, not routing readiness.",
				parameters: {},
				output,
				execute: async (args, exec) => {
					if (!exec.agent) throw new Error("PCB tools require an owning agent");
					return this.owner(exec.agent).runToCompletion("status", await this.runtime(args), exec.signal, true);
				}
			}));
			ctx.tools.register(defineTool({
				name: "pcb_route",
				description: "Route a PCB into a new output run directory. Requires a one-action human approval. External model modes send board planning data and may incur API charges; rounds are NOT a spending cap. Credentials are host environment only.",
				parameters: {
					board,
					output: {
						type: "string",
						required: true,
						description: "Output directory inside configured allowedRoots."
					},
					provider: {
						type: "string",
						enum: [
							"none",
							"openai",
							"anthropic"
						]
					},
					model: { type: "string" },
					rounds: { type: "integer" }
				},
				output,
				execute: async (args, exec) => {
					if (!exec.agent) throw new Error("PCB tools require an owning agent");
					const params = await this.routeArgs(args);
					exec.signal.throwIfAborted();
					const outcome = await ctx.approval.request({
						agent: exec.agent,
						toolName: "pcb_route",
						callId: exec.callId,
						signal: exec.signal,
						reason: `Route board ${params.board} to ${params.output}. Provider: ${params.provider}. Model: ${params.model || "(provider default)"}. Rounds: ${params.rounds}. ${params.provider === "none" ? "No external model request." : "Board planning data will be sent to this provider and API fees may apply; rounds are not a spending limit."}`
					});
					if (outcome !== "allowed-once") throw new Error(`PCB routing approval ${outcome}`);
					exec.signal.throwIfAborted();
					return this.owner(exec.agent).runToCompletion("run", {
						...params,
						model_consent: true
					}, exec.signal);
				}
			}));
			ctx.tools.register(defineTool({
				name: "pcb_stop",
				description: "Stop only the current PCB process owned by this agent session.",
				parameters: {},
				output,
				execute: async (_args, exec) => {
					if (!exec.agent) throw new Error("PCB tools require an owning agent");
					return this.owner(exec.agent).stop();
				}
			}));
		}
	};
})();
//#endregion
//#region src/index.ts
const inject = PcbController.inject;
const Config = z.object({
	pcbRoot: z.string().default(fileURLToPath(new URL("../backend/", import.meta.url))),
	pythonExecutable: z.string(),
	runtimePath: z.string(),
	allowedRoots: z.array(z.string()).default([])
});
function apply(ctx, config) {
	ctx.plugin(PcbController, config);
}
//#endregion
export { Config, apply, inject };
