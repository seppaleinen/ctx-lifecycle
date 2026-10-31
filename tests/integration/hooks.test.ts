import { describe, it, expect, beforeAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { Message } from '@opencode/ai/effect';
import plugin from '../../src/index.js';

/**
 * Integration tests for the context-pager plugin's registered hooks.
 *
 * Strategy: the REAL `setup(ctx)` from src/index.ts runs against an
 * instrumented context object (plain object literals that capture the
 * registered hook callbacks and command definitions). No module is mocked
 * — the real plugin code, real StateMachine, real ContextRouter and real
 * OpenCode `Message` factory instances from @opencode/ai/effect are used.
 *
 * The plugin keeps a module-level StateMachine, so these tests are ORDERED:
 * each test advances the machine from the state the previous test left,
 * always driving it through a registered hook (the /transition command's
 * real execute() function).
 */

type ContextEvent = { messages: Message[] };
type ToolEvent = { tool: string; input?: { command?: string } | undefined };
type CommandDefinition = {
  name: string;
  description: string;
  execute: (args: { sessionID: string; prompt: { text: string } }) => Promise<void>;
};

function textOf(message: Message): string {
  return message.content
    .map((part) => ('text' in part ? part.text : ''))
    .join('');
}

describe('context-pager plugin hooks (real setup, instrumented context)', () => {
  type Registered = {
    hooks: Map<string, (event: never) => void | Promise<void>>;
    commands: CommandDefinition[];
  };

  const makeContext = (): Registered & {
    session: { hook: (name: string, cb: (event: never) => void | Promise<void>) => Promise<void> };
    tool: { hook: (name: string, cb: (event: never) => void | Promise<void>) => Promise<void> };
    command: { transform: (cb: (editor: { add: (def: CommandDefinition) => void }) => void) => Promise<void> };
  } => {
    const registered: Registered = { hooks: new Map(), commands: [] };
    const hookFor = (store: Map<string, (event: never) => void | Promise<void>>) =>
      (name: string, cb: (event: never) => void | Promise<void>) => {
        store.set(name, cb);
        return Promise.resolve();
      };
    return {
      ...registered,
      session: { hook: hookFor(registered.hooks) },
      tool: { hook: hookFor(registered.hooks) },
      command: {
        transform: (cb: (editor: { add: (def: CommandDefinition) => void }) => void) => {
          cb({ add: (def: CommandDefinition) => registered.commands.push(def) });
          return Promise.resolve();
        },
      },
    };
  };

  let ctx: ReturnType<typeof makeContext>;
  let contextHook: (event: ContextEvent) => void;
  let toolHook: (event: ToolEvent) => void;
  let commandDef: CommandDefinition;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleDebugSpy: ReturnType<typeof spyOn>;

  // setup() is called once (mirroring OpenCode); the same module-level
  // StateMachine is shared by every hook, which is how the plugin works.
  beforeAll(async () => {
    ctx = makeContext();
    await plugin.setup(ctx as never);
    contextHook = ctx.hooks.get('context') as unknown as (event: ContextEvent) => void;
    toolHook = ctx.hooks.get('execute.before') as unknown as (event: ToolEvent) => void;
    commandDef = ctx.commands.find((c) => c.name === 'transition')!;
  });

  beforeEach(() => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    consoleDebugSpy = spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });

  const transition = (text: string) => commandDef.execute({ sessionID: 'ses_test', prompt: { text } });

  it('registers the context, execute.before hooks and the transition + new-issue commands', () => {
    expect(ctx.hooks.has('context')).toBe(true);
    expect(ctx.hooks.has('execute.before')).toBe(true);
    expect(ctx.commands).toHaveLength(2);
    expect(commandDef.name).toBe('transition');
    expect(typeof commandDef.execute).toBe('function');
    const newIssueDef = ctx.commands.find((c) => c.name === 'new-issue');
    expect(newIssueDef).toBeDefined();
    expect(typeof newIssueDef!.execute).toBe('function');
  });

  it('context hook: with empty pools, replaces event.messages with the (empty) active set', () => {
    // State: PLANNING (initial). GLOBAL and PLANNING pools are both empty.
    const event: ContextEvent = { messages: ['sentinel' as never] };
    contextHook(event);
    // The hook replaced the pre-existing list with the active pool's messages
    expect(event.messages).toEqual([]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('execute.before: ignores non-bash tools (no transition, no log, no error)', async () => {
    // State: PLANNING
    await toolHook({ tool: 'read', input: {} });
    const event: ContextEvent = { messages: ['sentinel' as never] };
    contextHook(event);
    // PLANNING pool still empty → handler replaced the sentinel list
    expect(event.messages).toEqual([]);
    expect(consoleDebugSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('execute.before: test command in CODING auto-transitions to DEBUGGING (debug log + summary)', async () => {
    // PLANNING -> CODING via the registered /transition command
    await transition('/transition coding');
    expect(consoleDebugSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleDebugSpy.mock.calls[0][0])).toContain('planning -> coding');

    // pytest in CODING triggers the auto-transition
    await toolHook({ tool: 'bash', input: { command: 'pytest tests/' } });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(String(consoleDebugSpy.mock.calls[1][0])).toContain('coding -> debugging');
    expect(String(consoleDebugSpy.mock.calls[1][0])).toContain('Test command detected: pytest tests/');

    // State is now DEBUGGING: active pool = TESTING, holding the 1-sentence summary
    const event: ContextEvent = { messages: [] };
    contextHook(event);
    expect(event.messages).toHaveLength(1);
    const summaryMsg = event.messages[0];
    expect(summaryMsg).toBeInstanceOf(Message);
    expect(summaryMsg.role).toBe('system');
    const text = textOf(summaryMsg);
    expect(text.startsWith('Swapped to Testing Pool.')).toBe(true);
    expect(text.includes('pytest tests/')).toBe(true);
  });

  it('execute.before: test command in non-CODING state does NOT auto-transition', async () => {
    // State: DEBUGGING — the state guard (=== CODING) must block the auto-transition
    const debugCallsBefore = consoleDebugSpy.mock.calls.length;
    await toolHook({ tool: 'bash', input: { command: 'pytest tests/' } });
    expect(consoleDebugSpy).toHaveBeenCalledTimes(debugCallsBefore);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('execute.before: non-test bash command does NOT auto-transition', async () => {
    // State: DEBUGGING (auto-transition only fires from CODING anyway)
    const debugCallsBefore = consoleDebugSpy.mock.calls.length;
    await toolHook({ tool: 'bash', input: { command: 'ls -la' } });
    expect(consoleDebugSpy).toHaveBeenCalledTimes(debugCallsBefore);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('execute.before: test command without command string does NOT auto-transition', async () => {
    const debugCallsBefore = consoleDebugSpy.mock.calls.length;
    await toolHook({ tool: 'bash', input: {} });
    await toolHook({ tool: 'bash' });
    expect(consoleDebugSpy).toHaveBeenCalledTimes(debugCallsBefore);
  });

  it('/transition command: DEBUGGING -> complete moves the context hook to the Planning pool', async () => {
    await transition('/transition complete');
    expect(String(consoleDebugSpy.mock.calls.at(-1)![0])).toContain('debugging -> complete');

    // COMPLETE maps to the PLANNING pool per STATE_TO_POOL — which contains the transition summary
    const event: ContextEvent = { messages: [] };
    contextHook(event);
    // PLANNING pool has the summary from the transition
    expect(event.messages).toHaveLength(1);
    const summaryMsg = event.messages[0];
    expect(summaryMsg).toBeInstanceOf(Message);
    expect(summaryMsg.role).toBe('system');
    const text = textOf(summaryMsg);
    expect(text.startsWith('Swapped to Planning Pool.')).toBe(true);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('/transition command: unknown state parses to null and does nothing', async () => {
    const debugCallsBefore = consoleDebugSpy.mock.calls.length;
    await transition('/transition bogus');
    await transition('not a transition');
    expect(consoleDebugSpy).toHaveBeenCalledTimes(debugCallsBefore);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});