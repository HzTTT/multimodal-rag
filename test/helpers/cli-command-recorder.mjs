import { createFakePluginApi } from "./fake-plugin-api.mjs";

class FakeCommand {
  constructor(name) {
    this.name = name;
    this.children = [];
  }

  description() {
    return this;
  }

  argument() {
    return this;
  }

  option() {
    return this;
  }

  action() {
    return this;
  }

  command(name) {
    const child = new FakeCommand(name);
    this.children.push(child);
    return child;
  }
}

export async function loadRegisteredCommandNames() {
  const entry = (await import("../../dist/index.js")).default;
  const api = createFakePluginApi();

  entry.register(api);

  const registrar = api._captured.commands[0];
  if (typeof registrar !== "function") {
    throw new Error("plugin did not register a CLI registrar");
  }

  let root;
  const program = {
    command(name) {
      root = new FakeCommand(name);
      return root;
    },
  };

  registrar({ program });

  if (!root || root.name !== "multimodal-rag") {
    throw new Error("plugin did not register the multimodal-rag root command");
  }

  return root.children.map((child) => child.name);
}
