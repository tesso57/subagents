import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type EventHandler = (event: never, context: ExtensionContext) => unknown;
type Responses = {
  confirm?: boolean[];
  input?: (string | undefined)[];
  select?: (string | undefined)[];
};

/** A deliberately partial Pi double. Unsupported APIs fail instead of silently succeeding. */
export function createMockPi(responses: Responses = {}) {
  const commands = new Map<string, Command>();
  const tools = new Map<string, Tool>();
  const events = new Map<string, EventHandler[]>();
  const notifications: { message: string; type: string }[] = [];
  const queues = {
    confirm: [...(responses.confirm ?? [])],
    input: [...(responses.input ?? [])],
    select: [...(responses.select ?? [])],
  };
  function take<K extends keyof typeof queues>(kind: K): (typeof queues)[K][number] {
    const queue = queues[kind];
    if (queue.length === 0) throw new Error(`No mock response for ${kind}`);
    return queue.shift() as (typeof queues)[K][number];
  }
  const context = {
    hasUI: true,
    mode: "tui",
    ui: {
      notify(message: string, type = "info") { notifications.push({ message, type }); },
      async confirm() { return take("confirm"); },
      async input() { return take("input"); },
      async select() { return take("select"); },
    },
  } as unknown as ExtensionCommandContext;
  const pi = {
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    registerTool(tool: Tool) { tools.set(tool.name, tool); },
    on(name: string, handler: EventHandler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
      return () => {
        const index = handlers.indexOf(handler);
        if (index !== -1) handlers.splice(index, 1);
      };
    },
  } as unknown as ExtensionAPI;
  return {
    pi, context, commands, tools, notifications,
    async runCommand(name: string, args = "") {
      const command = commands.get(name);
      if (!command) throw new Error(`Unknown command: ${name}`);
      await command.handler(args, context);
    },
    async emit(name: string, event: unknown, eventContext: ExtensionContext = context) {
      const results: unknown[] = [];
      for (const handler of [...(events.get(name) ?? [])]) {
        results.push(await handler(event as never, eventContext));
      }
      return results;
    },
  };
}
