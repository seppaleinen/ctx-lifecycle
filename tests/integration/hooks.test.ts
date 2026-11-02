import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Message } from '@opencode/ai/effect';
import plugin from '../../src/index.js';
import { StateMachineState } from '../../src/types.js';

/**
 * Integration tests for the context-pager plugin's registered hooks.
 *
 * Strategy: the REAL `setup(ctx)` from src/index.ts runs against an
 * instrumented context object (plain object literals that capture the
 * registered hook callbacks and command definitions). No module is mocked
 * — the real plugin code, real StateMachine, real ContextRouter and real
 * OpenCode `Message` factory instances from @opencode/ai/effect are used.
 *
 * Test isolation: `setup()` owns its StateMachine via closure, so every
 * call creates a FRESH machine (and fresh router/pools) that starts in
 * PLANNING. Tests are independent: each one sets up its own plugin instance
 * and drives the machine to the state it needs via the registered
 * `/transition` command — the real command's execute() function.
 */

type ContextEvent = { messages: Message[] };
type ToolEvent = { tool: string; input?: { command?: string } | undefined };
type CommandDefinition = {
  name: string;
  description: string;
  execute: (args: { sessionID: string; prompt: { text: string } }) => Promise<void>;
};
type HookCallback = (event: never) => void | Promise<void>;

function textOf(message: Message): string {
  return message.content
    .map((part) => ('text' in part ? part.text : ''))
    .join('');
}

interface Harness {
  hooks: Map<string, HookCallback>;
  commands: CommandDefinition[];
  /** The registered `context` session hook. */
  contextHook: (event: ContextEvent) => void;
  /** The registered `execute.before` tool hook. */
  toolHook: (event: ToolEvent) => void;
  /** The registered `transition` command's execute(). */
  transition: (text: string) => Promise<void>;
}

/**
 * Run the real `plugin.setup(ctx)` once against a fresh instrumented
 * context and return the captured hooks/commands. Each harness is fully
 * isolated: its own StateMachine, its own ContextRouter, its own pools.
 */
async function createHarness(): Promise<Harness> {
  const hooks = new Map<string, HookCallback>();
  const commands: CommandDefinition[] = [];
  const hookFor = (name: string, cb: HookCallback) => {
    hooks.set(name, cb);
    return Promise.resolve();
  };
  const ctx = {
    session: { hook: hookFor },
    tool: { hook: hookFor },
    command: {
      transform: (cb: (editor: { add: (def: CommandDefinition) => void }) => void) => {
        cb({ add: (def: CommandDefinition) => commands.push(def) });
        return Promise.resolve();
      },
    },
  };
  await plugin.setup(ctx as never);

  const transitionCommand = commands.find((c) => c.name === 'transition');
  if (!transitionCommand) {
    throw new Error('transition command was not registered');
  }
  return {
    hooks,
    commands,
    contextHook: hooks.get('context') as unknown as (event: ContextEvent) => void,
    toolHook: hooks.get('execute.before') as unknown as (event: ToolEvent) => void,
    transition: (text: string) => transitionCommand.execute({ sessionID: 'ses_test', prompt: { text } }),
  };
}

/**
 * Create a fresh harness and drive its state machine through the given
 * states (each via the registered `/transition` command). Returns the
 * harness once the machine is in `states.at(-1)` (or PLANNING if none
 * given).
 */
async function setupAt(...states: StateMachineState[]): Promise<Harness> {
  const harness = await createHarness();
  for (const state of states) {
    await harness.transition(`/transition ${state}`);
  }
  return harness;
}

describe('context-pager plugin hooks (real setup, instrumented context)', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleDebugSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    consoleDebugSpy = spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });

  describe('registration', () => {
    it('registers the context, execute.before hooks and the transition + new-issue commands', async () => {
      const h = await createHarness();
      expect(h.hooks.has('context')).toBe(true);
      expect(h.hooks.has('execute.before')).toBe(true);
      expect(h.commands).toHaveLength(2);
      const commandDef = h.commands.find((c) => c.name === 'transition')!;
      expect(commandDef.name).toBe('transition');
      expect(typeof commandDef.execute).toBe('function');
      const newIssueDef = h.commands.find((c) => c.name === 'new-issue');
      expect(newIssueDef).toBeDefined();
      expect(typeof newIssueDef!.execute).toBe('function');
    });
  });

  describe('context hook', () => {
    it('with empty pools, replaces event.messages with the (empty) active set', async () => {
      // State: PLANNING (initial). GLOBAL and PLANNING pools are both empty.
      const h = await createHarness();
      const event: ContextEvent = { messages: ['sentinel' as never] };
      h.contextHook(event);
      // The hook replaced the pre-existing list with the active pool's messages
      expect(event.messages).toEqual([]);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('exposes the TESTING pool once the machine is in DEBUGGING', async () => {
      // PLANNING -> CODING -> DEBUGGING; the TESTING pool now holds the
      // 1-sentence summary from the last transition.
      const h = await setupAt(StateMachineState.CODING, StateMachineState.DEBUGGING);
      const event: ContextEvent = { messages: [] };
      h.contextHook(event);
      expect(event.messages).toHaveLength(1);
      const summaryMsg = event.messages[0];
      expect(summaryMsg).toBeInstanceOf(Message);
      expect(summaryMsg.role).toBe('system');
      const text = textOf(summaryMsg);
      expect(text.startsWith('Swapped to Testing Pool.')).toBe(true);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('exposes the PLANNING pool once the machine is in COMPLETE', async () => {
      // PLANNING -> CODING -> DEBUGGING -> COMPLETE.
      // COMPLETE maps to the PLANNING pool per STATE_TO_POOL — which contains
      // the transition summary (debugging's summary went to the TESTING pool
      // and got evicted with the source pool).
      const h = await setupAt(StateMachineState.CODING, StateMachineState.DEBUGGING, StateMachineState.COMPLETE);
      expect(String(consoleDebugSpy.mock.calls.at(-1)![0])).toContain('debugging -> complete');

      const event: ContextEvent = { messages: [] };
      h.contextHook(event);
      // PLANNING pool has the summary from the transition
      expect(event.messages).toHaveLength(1);
      const summaryMsg = event.messages[0];
      expect(summaryMsg).toBeInstanceOf(Message);
      expect(summaryMsg.role).toBe('system');
      const text = textOf(summaryMsg);
      expect(text.startsWith('Swapped to Planning Pool.')).toBe(true);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('execute.before', () => {
    it('ignores non-bash tools (no transition, no log, no error)', async () => {
      const h = await createHarness();
      await h.toolHook({ tool: 'read', input: {} });
      const event: ContextEvent = { messages: ['sentinel' as never] };
      h.contextHook(event);
      // PLANNING pool still empty → handler replaced the sentinel list
      expect(event.messages).toEqual([]);
      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('test command in CODING auto-transitions to DEBUGGING (debug log + summary)', async () => {
      const h = await setupAt(StateMachineState.CODING);
      expect(consoleDebugSpy).toHaveBeenCalledTimes(1);
      expect(String(consoleDebugSpy.mock.calls[0][0])).toContain('planning -> coding');

      // pytest in CODING triggers the auto-transition
      await h.toolHook({ tool: 'bash', input: { command: 'pytest tests/' } });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(String(consoleDebugSpy.mock.calls[1][0])).toContain('coding -> debugging');
      expect(String(consoleDebugSpy.mock.calls[1][0])).toContain('Test command detected: pytest tests/');

      // State is now DEBUGGING: active pool = TESTING, holding the 1-sentence summary
      const event: ContextEvent = { messages: [] };
      h.contextHook(event);
      expect(event.messages).toHaveLength(1);
      const summaryMsg = event.messages[0];
      expect(summaryMsg).toBeInstanceOf(Message);
      expect(summaryMsg.role).toBe('system');
      const text = textOf(summaryMsg);
      expect(text.startsWith('Swapped to Testing Pool.')).toBe(true);
      expect(text.includes('pytest tests/')).toBe(true);
    });

    it('test command in non-CODING state does NOT auto-transition', async () => {
      // State: DEBUGGING — the state guard (=== CODING) must block the auto-transition
      const h = await setupAt(StateMachineState.CODING, StateMachineState.DEBUGGING);
      const debugCallsBefore = consoleDebugSpy.mock.calls.length;
      await h.toolHook({ tool: 'bash', input: { command: 'pytest tests/' } });
      expect(consoleDebugSpy).toHaveBeenCalledTimes(debugCallsBefore);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('non-test bash command does NOT auto-transition', async () => {
      // State: CODING, so only the test-command pattern can fire — a plain
      // shell command must leave the machine untouched.
      const h = await setupAt(StateMachineState.CODING);
      const debugCallsBefore = consoleDebugSpy.mock.calls.length;
      await h.toolHook({ tool: 'bash', input: { command: 'ls -la' } });
      expect(consoleDebugSpy).toHaveBeenCalledTimes(debugCallsBefore);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('test command without command string does NOT auto-transition', async () => {
      const h = await setupAt(StateMachineState.CODING);
      const debugCallsBefore = consoleDebugSpy.mock.calls.length;
      await h.toolHook({ tool: 'bash', input: {} });
      await h.toolHook({ tool: 'bash' });
      expect(consoleDebugSpy).toHaveBeenCalledTimes(debugCallsBefore);
    });
  });

  describe('transitions', () => {
    it('driving the same machine twice is independent (fresh setup = fresh PLANNING machine)', async () => {
      const first = await createHarness();
      await first.transition('/transition coding');
      expect(String(consoleDebugSpy.mock.calls.at(-1)![0])).toContain('planning -> coding');

      // A second setup() must start from a CLEAN machine: the same command
      // must be valid again, proving no module-level state leaked across.
      const second = await createHarness();
      await second.transition('/transition coding');
      expect(String(consoleDebugSpy.mock.calls.at(-1)![0])).toContain('planning -> coding');
    });

    it('unknown state parses to null and does nothing', async () => {
      const h = await createHarness();
      const debugCallsBefore = consoleDebugSpy.mock.calls.length;
      await h.transition('/transition bogus');
      await h.transition('not a transition');
      expect(consoleDebugSpy).toHaveBeenCalledTimes(debugCallsBefore);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('invalid transition throws inside execute and is logged, state unchanged', async () => {
      // PLANNING -> CODING is legal; CODING -> CODING is not (no self-transitions).
      const h = await setupAt(StateMachineState.CODING);
      await h.transition('/transition coding');
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(String(consoleErrorSpy.mock.calls[0][0])).toContain('Transition failed:');
      expect(String(consoleErrorSpy.mock.calls[0][1])).toContain('Invalid transition from coding to coding');

      // The failed transition was rejected: machine is still in CODING, so a
      // test command still triggers the auto-transition.
      await h.toolHook({ tool: 'bash', input: { command: 'pytest tests/' } });
      expect(String(consoleDebugSpy.mock.calls.at(-1)![0])).toContain('coding -> debugging');
    });
  });
});
