/**
 * pi-turnkit — turn-scoped modes for pi.
 *
 * Prefix a prompt with a mark and that turn runs with a different model /
 * thinking level / behavior. The mark is stripped before the model sees it;
 * everything is restored when the turn ends.
 *
 *   ❯ +plan the refactor of the parser   (think hard)
 *   ❯ _summarize the last commit         (cheap model)
 *
 * Built-in modes:
 *   +  think  — high thinking level (default max), optional model
 *   _  cheap  — another (cheap) model, e.g. glm-5.3-flash
 *
 * Configuration (persisted in $PI_HOME/extensions-config/turnkit.json,
 * first match wins):
 *   1. /turnkit config <mark> <provider/model[/level]>
 *   2. CLI flags / env vars per mode (see /turnkit)
 *   3. Built-in defaults
 *
 * Commands:
 *   /turnkit                     show config for every mode
 *   /turnkit config + zai/glm-5.3/xhigh
 *   /turnkit config _ ollama/gemma4:latest
 *   /turnkit reset               clear persisted config
 *   /turnkit reset +             clear one mode
 *
 * Inspired by midudev/better-claude (plugins/think-hard, use-haiku).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Model, ModelRegistry, ThinkingLevel } from "@earendil-works/pi-coding-agent";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface ModeConfig {
	model?: string; // "provider/model-id" or "model-id"
	level?: ThinkingLevel;
}

type PersistedConfig = Partial<Record<string, ModeConfig>>;

interface Mode {
	/** Prompt prefix, e.g. "+" */
	mark: string;
	name: string;
	description: string;
	defaults: ModeConfig;
	flagName: string; // CLI flag for the model (e.g. --cheap-model)
	envVar: string; // env var for the model
	levelFlagName?: string; // optional CLI flag for thinking level
	levelEnvVar?: string; // optional env var for thinking level
	/** Marked input sent mid-turn: warn that it keeps the current config */
	warnMidTurn?: boolean;
}

const MODES: Mode[] = [
	{
		mark: "+",
		name: "think",
		description: "high thinking level (default max), optional model",
		defaults: { level: "max" },
		flagName: "think-model",
		envVar: "PI_THINK_MODEL",
		levelFlagName: "think-level",
		levelEnvVar: "PI_THINK_LEVEL",
	},
	{
		mark: "_",
		name: "cheap",
		description: "another (cheap) model, default glm-5.3-flash",
		defaults: { model: "glm-5.3-flash" },
		flagName: "cheap-model",
		envVar: "PI_USE_CHEAP_MODEL",
		warnMidTurn: true,
	},
	{
		mark: "=",
		name: "vision",
		description: "a vision-capable model, default zai/glm-5.3-flash",
		defaults: { model: "zai/glm-5.3-flash" },
		flagName: "vision-model",
		envVar: "PI_VISION_MODEL",
		warnMidTurn: true,
	},
];

// `__init__.py fails` and a lone mark are not marked input.
function isMarked(text: string, mark: string): boolean {
	return text.startsWith(mark) && !text.startsWith(mark + mark);
}

function configPath(): string {
	const home = process.env.PI_HOME ?? path.join(os.homedir(), ".pi", "agent");
	return path.join(home, "extensions-config", "turnkit.json");
}

function loadConfig(): PersistedConfig {
	try {
		return JSON.parse(fs.readFileSync(configPath(), "utf8")) as PersistedConfig;
	} catch {
		return {};
	}
}

function saveConfig(config: PersistedConfig): void {
	try {
		fs.mkdirSync(path.dirname(configPath()), { recursive: true });
		fs.writeFileSync(configPath(), JSON.stringify(config, null, "\t") + "\n");
	} catch {
		// read-only home: config stays per-session
	}
}

function resolveModel(registry: ModelRegistry, spec: string): Model<any> | undefined {
	if (spec.includes("/")) {
		const idx = spec.indexOf("/");
		return registry.find(spec.slice(0, idx), spec.slice(idx + 1));
	}
	// Plain id: prefer models whose provider has auth configured.
	const candidates = registry.getAll().filter((m) => m.id === spec);
	return (
		candidates.find((m) => registry.hasConfiguredAuth(m)) ?? candidates[0]
	);
}

/** Effective config for a mode: persisted → flags/env → built-in defaults. */
function effectiveConfig(pi: ExtensionAPI, mode: Mode): ModeConfig {
	const persisted = loadConfig()[mode.mark] ?? {};
	const result: ModeConfig = { ...mode.defaults, ...persisted };

	const flag = pi.getFlag(mode.flagName);
	if (typeof flag === "string" && flag.trim() && !persisted.model) result.model = flag.trim();
	const env = process.env[mode.envVar];
	if (env && env.trim() && !persisted.model && result.model === mode.defaults.model) {
		result.model = env.trim();
	}

	if (mode.levelFlagName) {
		const levelFlag = pi.getFlag(mode.levelFlagName);
		if (typeof levelFlag === "string" && LEVELS.includes(levelFlag.trim() as ThinkingLevel) && !persisted.level) {
			result.level = levelFlag.trim() as ThinkingLevel;
		}
		if (mode.levelEnvVar) {
			const levelEnv = process.env[mode.levelEnvVar];
			if (levelEnv && LEVELS.includes(levelEnv.trim() as ThinkingLevel) && !persisted.level && result.level === mode.defaults.level) {
				result.level = levelEnv.trim() as ThinkingLevel;
			}
		}
	}
	return result;
}

export default function turnkitExtension(pi: ExtensionAPI) {
	// Cache the registry for autocomplete (getArgumentCompletions has no ctx).
	let registry: ModelRegistry | undefined;
	pi.on("session_start", (_event, ctx) => {
		registry = ctx.modelRegistry;
	});

	// Active mode for the current turn, with saved state to restore.
	let activeTurn: { mode: Mode; previousLevel?: ThinkingLevel; previousModel?: Model<any> } | undefined;

	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive" && event.source !== "extension") return;

		for (const mode of MODES) {
			if (!isMarked(event.text, mode.mark)) continue;

			const text = event.text.slice(mode.mark.length).trimStart();
			if (!text) return; // lone mark: don't hijack the input

			if (event.streamingBehavior !== undefined) {
				// Mid-turn: folded into the running turn, keeps current config.
				if (mode.warnMidTurn) {
					ctx.ui.notify("Sent mid-turn: keeps the current model", "warning");
				}
				return { action: "transform" as const, text };
			}

			const config = effectiveConfig(pi, mode);
			if (config.model) {
				const model = resolveModel(ctx.modelRegistry, config.model);
				if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
					ctx.ui.notify(
						`turnkit: model "${config.model}" for ${mode.mark} not available — running with current config`,
						"warning",
					);
				}
			}

			activeTurn = { mode };
			return { action: "transform" as const, text };
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!activeTurn) return;
		const config = effectiveConfig(pi, activeTurn.mode);

		if (config.model) {
			const model = resolveModel(ctx.modelRegistry, config.model);
			if (model && ctx.modelRegistry.hasConfiguredAuth(model)) {
				activeTurn.previousModel = ctx.model;
				const ok = await pi.setModel(model);
				if (!ok) activeTurn.previousModel = undefined;
			}
		}

		if (config.level) {
			activeTurn.previousLevel = pi.getThinkingLevel();
			// Clamped to model capabilities by pi itself.
			pi.setThinkingLevel(config.level);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!activeTurn) return;
		const { mode, previousLevel, previousModel } = activeTurn;
		const config = effectiveConfig(pi, mode);
		activeTurn = undefined;

		if (previousLevel !== undefined) {
			pi.setThinkingLevel(previousLevel);
		}
		if (previousModel !== undefined) {
			await pi.setModel(previousModel);
		}
		if (ctx.hasUI) {
			const bits: string[] = [];
			if (previousModel !== undefined && config.model) bits.push(config.model);
			if (previousLevel !== undefined && config.level) bits.push(`thinking ${config.level}`);
			if (bits.length > 0) ctx.ui.notify(`⚡ [${mode.mark}] ${bits.join(" · ")}`, "info");
		}
	});

	// --- registration ---

	for (const mode of MODES) {
		pi.registerFlag(mode.flagName, {
			description: `Model for "${mode.mark}" ${mode.name} prompts (${mode.description})`,
			type: "string",
		});
		if (mode.levelFlagName) {
			pi.registerFlag(mode.levelFlagName!, {
				description: `Thinking level for "${mode.mark}" ${mode.name} prompts (${LEVELS.join("|")})`,
				type: "string",
			});
		}
	}

	pi.registerCommand("turnkit", {
		description: "Turn-scoped modes: /turnkit [config <mark> <provider/model> [level] | reset [mark]]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);

			if (parts.length === 0) {
				for (const mode of MODES) {
					const config = effectiveConfig(pi, mode);
					const persisted = loadConfig()[mode.mark];
					const src = persisted ? "persisted" : "defaults/flags";
					ctx.ui.notify(
						`${mode.mark} ${mode.name}: ${config.model ?? "session model"}${config.level ? ` · thinking ${config.level}` : ""} (${src})`,
						"info",
					);
				}
				return;
			}

			if (parts[0] === "reset") {
				const config = loadConfig();
				if (parts[1]) {
					const mode = MODES.find((m) => m.mark === parts[1] || m.name === parts[1]);
					if (!mode) {
						ctx.ui.notify(`Unknown mode "${parts[1]}"`, "error");
						return;
					}
					delete config[mode.mark];
					saveConfig(config);
					ctx.ui.notify(`turnkit: ${mode.mark} config cleared`, "info");
				} else {
					saveConfig({});
					ctx.ui.notify("turnkit: all persisted config cleared", "info");
				}
				return;
			}

			if (parts[0] === "config" && parts.length >= 3) {
				const mode = MODES.find((m) => m.mark === parts[1] || m.name === parts[1]);
				if (!mode) {
					ctx.ui.notify(`Unknown mode "${parts[1]}" (marks: ${MODES.map((m) => m.mark).join(", ")})`, "error");
					return;
				}
			// Syntax: config <mark> <provider/model> [level] | config <mark> <level> | config <mark> /<level>
			const spec = parts[2] as string;
			let level: ThinkingLevel | undefined;
			let modelSpec: string | undefined;
			if (spec.startsWith("/") || LEVELS.includes(spec as ThinkingLevel)) {
				// "/level" or bare "level": keep the current model, change the level only.
				level = (spec.startsWith("/") ? spec.slice(1) : spec) as ThinkingLevel;
				if (!LEVELS.includes(level)) {
					ctx.ui.notify(`Invalid level "${level}". Use: ${LEVELS.join("|")}`, "error");
					return;
				}
			} else {
				modelSpec = spec;
				const model = resolveModel(ctx.modelRegistry, modelSpec);
				if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
					ctx.ui.notify(`Model "${modelSpec}" not available`, "error");
					return;
				}
				// Optional 4th arg: the thinking level.
				if (parts[3]) {
					if (!LEVELS.includes(parts[3] as ThinkingLevel)) {
						ctx.ui.notify(`Invalid level "${parts[3]}". Use: ${LEVELS.join("|")}`, "error");
						return;
					}
					level = parts[3] as ThinkingLevel;
				}
			}
			const config = loadConfig();
			const entry: ModeConfig = { ...(config[mode.mark] ?? {}) };
			if (modelSpec) entry.model = modelSpec;
			if (level) entry.level = level;
			config[mode.mark] = entry;
			saveConfig(config);
			const effective = effectiveConfig(pi, mode);
			ctx.ui.notify(
				`turnkit ${mode.mark}: ${effective.model ?? "session model"}${effective.level ? ` · thinking ${effective.level}` : ""}`,
				"info",
			);
			return;
		}

		ctx.ui.notify(
			"Usage: /turnkit [config <mark> <provider/model> [level] | config <mark> <level> | reset [mark]]",
			"error",
		);
		},
		getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
			const tokens = argumentPrefix.split(/\s+/);
			// Which token is being completed: partial last token when the prefix
			// doesn't end in a space, otherwise a fresh empty token.
			const endsInSpace = /\s$/.test(argumentPrefix);
			const position = endsInSpace ? tokens.length : tokens.length - 1;
			const partial = endsInSpace ? "" : (tokens[tokens.length - 1] ?? "");
			const matches = (value: string) => value.startsWith(partial);

			// /turnkit <|config|reset...>
			if (position === 0) {
				const items: AutocompleteItem[] = [
				{ value: "config ", label: "config", description: "set <mark> <provider/model[/level]>" },
				{ value: "reset ", label: "reset", description: "clear persisted config [mark]" },
			].filter((item) => item.value.startsWith(partial));
			return items.length > 0 ? items : null;
			}

			const subcommand = tokens[0];
			// /turnkit config <+|_>
			if (subcommand === "config" && position === 1) {
				const items = MODES.map((mode) => ({
					value: `${mode.mark} `,
					label: `${mode.mark} (${mode.name})`,
					description: mode.description,
				})).filter((item) => matches(item.value));
				return items.length > 0 ? items : null;
			}

			// /turnkit config + <provider/model[/level]>
			if (subcommand === "config" && position === 2 && registry) {
				const items: AutocompleteItem[] = registry
					.getAvailable()
					.filter((m) => m.type === undefined || m.type === "chat")
					.map((m) => ({
						value: `${m.provider}/${m.id}`,
					label: m.id,
						description: m.provider,
					}))
					.filter((item) => item.value.includes(partial));
				return items.length > 0 ? items : null;
			}

			// /turnkit config + provider/model <level>  (explicit 4th arg)
			if (subcommand === "config" && position === 3) {
				const items = LEVELS.map((level) => ({
					value: level,
					label: level,
				})).filter((item) => matches(item.value));
				return items.length > 0 ? items : null;
			}

			// /turnkit reset <+|_>
			if (subcommand === "reset" && position === 1) {
				const items = MODES.map((mode) => ({
					value: mode.mark,
					label: `${mode.mark} (${mode.name})`,
					description: `clear ${mode.name}`,
				})).filter((item) => matches(item.value));
				return items.length > 0 ? items : null;
			}

			return null;
		},
	});
}
