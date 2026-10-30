import { Plugin } from '@opencode/plugin';
import { Message } from '@opencode/ai/effect';
import { StateMachineState } from './types.js';
import { ContextRouter } from './router.js';
import { SummaryGenerator } from './summary-generator.js';
import { StateMachine } from './state-machine.js';

let stateMachine: StateMachine | null = null;

export default Plugin.define({
  id: 'context-pager',
  setup: async (ctx) => {
    const router = new ContextRouter();
    const summaryGenerator = new SummaryGenerator(router);
    stateMachine = new StateMachine();

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
            const transitionEvent = stateMachine.transition(StateMachineState.DEBUGGING, trigger);
            console.debug(`[context-pager] Auto-transition: ${transitionEvent.fromState} -> ${transitionEvent.toState} (${trigger})`);
            const summary = summaryGenerator.generateSummary(StateMachineState.DEBUGGING, trigger);
            summaryGenerator.addSummaryToPool(StateMachineState.DEBUGGING, summary);
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