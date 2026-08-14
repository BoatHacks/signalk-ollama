/**
 * signalk-ollama — Ollama as a Signal K managed container plugin.
 *
 * Runs ollama/ollama via the signalk-container plugin, waits for its HTTP
 * API to answer, then pulls any configured models. Exists to give other
 * plugins and services on the boat (signalk-voice-llm, signalk-ai-bridge,
 * or anything else that speaks the Ollama API) a local LLM server to call.
 */

import type { Plugin, ServerAPI } from "@signalk/server-api";
import type { RouterLike } from "signalk-container-helper";
import { CONFIG_SCHEMA, PLUGIN_NAME, UI_SCHEMA } from "./config.js";
import { OllamaService, PLUGIN_ID, type ServiceApp } from "./service.js";

export default function createPlugin(app: ServerAPI): Plugin {
  // One OllamaService per server process: Express routers cannot be
  // deregistered, so routes must keep pointing at a live object across
  // plugin stop/start cycles.
  let service: OllamaService | null = null;
  let lastRawConfig: unknown;

  const getService = (): OllamaService => {
    service ??= new OllamaService(app as unknown as ServiceApp);
    return service;
  };

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description:
      "Ollama in a managed container — a local LLM server for other " +
      "plugins (signalk-voice-llm, signalk-ai-bridge) or anything else " +
      "on the boat that speaks the Ollama API.",

    schema: () => CONFIG_SCHEMA as unknown as object,
    uiSchema: () => UI_SCHEMA as unknown as object,

    start(config: object) {
      lastRawConfig = config;
      getService().start(config);
    },

    stop(): Promise<void> {
      return service?.stop() ?? Promise.resolve();
    },

    registerWithRouter(router) {
      getService().registerRoutes(
        router as unknown as RouterLike,
        () => lastRawConfig,
      );
    },
  };

  return plugin;
}
