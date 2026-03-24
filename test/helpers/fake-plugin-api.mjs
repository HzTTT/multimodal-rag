export function createFakePluginApi(overrides = {}) {
  const commands = [];
  const services = [];
  const tools = [];

  return {
    id: "multimodal-rag",
    name: "Multimodal RAG",
    source: "/virtual/index.ts",
    config: {},
    pluginConfig: {},
    runtime: {},
    registrationMode: "full",
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    resolvePath(input) {
      return input;
    },
    registerTool(tool) {
      tools.push(tool);
    },
    registerCli(registrar) {
      commands.push(registrar);
    },
    registerService(service) {
      services.push(service);
    },
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerProvider() {},
    registerSpeechProvider() {},
    registerMediaUnderstandingProvider() {},
    registerImageGenerationProvider() {},
    registerWebSearchProvider() {},
    registerInteractiveHandler() {},
    registerCommand() {},
    registerContextEngine() {},
    registerMemoryPromptSection() {},
    on() {},
    onConversationBindingResolved() {},
    ...overrides,
    _captured: {
      commands,
      services,
      tools,
    },
  };
}
