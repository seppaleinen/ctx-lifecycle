import { Plugin } from '@opencode/plugin';
import { Message } from '@opencode/ai/effect';
import { StateMachineState, PoolID, STATE_TO_POOL, mergeConfig, RETAINED_CONTEXT_PREFIX } from './types.js';
import { ContextRouter } from './router.js';
import { SummaryGenerator } from './summary-generator.js';
import { StateMachine } from './state-machine.js';

let stateMachine: StateMachine | null = null;

export default Plugin.define({
  id: 'context-pager',
  setup: async (ctx) => {
    const router = new ContextRouter();
    const config = mergeConfig(undefined);
    const summaryGenerator = new SummaryGenerator(router, config);
    stateMachine = new StateMachine();

    /**
     * Unified transition helper: 1-sentence header summary → structured
     * retained context → (optionally) evict the source pool → transition.
     * Used by both the /transition command and the test-command hook so the
     * two paths can never drift.
     */
    const applyTransition = (toState: StateMachineState, trigger: string): void => {
      const fromState = stateMachine!.getCurrentState();
      const summary = summaryGenerator.generateSummary(toState, trigger);
      summaryGenerator.addSummaryToPool(toState, summary);

      if (config.retention.enabled) {
        const fromPool = STATE_TO_POOL[fromState] as PoolID;
        const toPool = STATE_TO_POOL[toState] as PoolID;
        const retained = summaryGenerator.extractRetainedContext(fromPool, fromState);
        summaryGenerator.validateRetainedContext(retained);
        if (summaryGenerator.writeRetainedContextToPool(toState, retained)) {
          // Same-pool dedup guard: if the source pool is the SAME as the target
          // pool (e.g. COMPLETE→PLANNING both map to the planning pool) and it
          // already ends with the retained block, drop it so a round-trip
          // doesn't accumulate duplicates.
          const pool = router.getPool(toPool)!;
          const last = pool.messages[pool.messages.length - 1];
          if (fromPool === toPool && last && last.content.startsWith(RETAINED_CONTEXT_PREFIX)) {
            pool.messages.pop();
          }
        }
        if (config.retention.evictSourcePool && fromPool !== toPool) {
          router.clearPool(fromPool);
        }
        stateMachine!.transition(toState, trigger, retained.items.length > 0 ? retained : undefined);
        console.debug(`[context-pager] Transition: ${fromState} -> ${toState} (${trigger})` +
          (retained.items.length > 0 ? ` [retained ${retained.items.length} items]` : ''));
      } else {
        stateMachine!.transition(toState, trigger);
        console.debug(`[context-pager] Transition: ${fromState} -> ${toState} (${trigger})`);
      }
    };

    await ctx.session.hook('context', (event) => {
      const targetState = stateMachine?.getCurrentState();
      if (targetState) {
        const activeMessages = router.getActivePools(targetState);
        // Convert internal ContextMessage objects to OpenCode Message instances
        event.messages = activeMessages.map((msg) => {
          switch (msg.role) {
            case 'system':
              return Message.system(msg.content);
            case 'user':
              return Message.user(msg.content);
            case 'assistant':
              return Message.assistant(msg.content);
            default:
              return Message.system(msg.content);
          }
        });
      }
    });

    await ctx.tool.hook('execute.before', (event) => {
      if (event.tool !== 'bash') {
        return;
      }

      // Bash tool input schema: { command: string, ... }
      const bashInput = event.input as { command?: string } | undefined;
      const command = typeof bashInput?.command === 'string' ? bashInput.command : '';

      if (command) {
        const isTestCommand = /(pytest|vitest|jest|pnpm\s+test|npm\s+test|go\s+test|cargo\s+test)/.test(command);
        if (isTestCommand && stateMachine?.getCurrentState() === StateMachineState.CODING) {
          try {
            const trigger = `Test command detected: ${command}`;
            applyTransition(StateMachineState.DEBUGGING, trigger);
          } catch (e) {
            console.error('Auto-transition failed:', e);
          }
        }
      }
    });

    await ctx.command.transform((editor) => {
      editor.add({
        name: 'transition',
        description: 'Transition context-pager state machine',
        execute: async ({ prompt }) => {
          if (!stateMachine) {
            return;
          }

          const commandText = prompt.text || '';
          const parsed = stateMachine.parseTransitionCommand(commandText);

          if (!parsed) {
            return;
          }

          try {
            const transitionEvent = stateMachine.transition(parsed.state, parsed.trigger);
            console.debug(`[context-pager] Transition: ${transitionEvent.fromState} -> ${transitionEvent.toState}`);
            const summary = summaryGenerator.generateSummary(parsed.state, parsed.trigger);
            summaryGenerator.addSummaryToPool(parsed.state, summary);
          } catch (error) {
            console.error('Transition failed:', error);
          }
        }
      });
    });
  }
});