import { StateMachineState, TransitionEvent, RetainedContext } from './types.js';

export class StateMachine {
  private currentState: StateMachineState;

  private static readonly TRANSITION_MATRIX: Record<StateMachineState, StateMachineState[]> = {
    [StateMachineState.PLANNING]: [StateMachineState.CODING],
    [StateMachineState.CODING]: [StateMachineState.PLANNING, StateMachineState.DEBUGGING],
    [StateMachineState.DEBUGGING]: [StateMachineState.COMPLETE, StateMachineState.PLANNING],
    [StateMachineState.COMPLETE]: [StateMachineState.PLANNING]
  };

  constructor() {
    this.currentState = StateMachineState.PLANNING;
  }

  getCurrentState(): StateMachineState {
    return this.currentState;
  }

  canTransition(toState: StateMachineState): boolean {
    const allowedStates = StateMachine.TRANSITION_MATRIX[this.currentState];
    return allowedStates.includes(toState);
  }

  transition(targetState: StateMachineState, trigger: string, retained?: RetainedContext): TransitionEvent {
    if (!this.canTransition(targetState)) {
      throw new Error(
        `Invalid transition from ${this.currentState} to ${targetState}. ` +
        `Allowed transitions: ${StateMachine.TRANSITION_MATRIX[this.currentState].join(', ')}`
      );
    }

    const fromState = this.currentState;
    const event: TransitionEvent = retained
      ? { fromState, toState: targetState, trigger, timestamp: Date.now(), retained }
      : { fromState, toState: targetState, trigger, timestamp: Date.now() };

    this.currentState = targetState;

    return event;
  }

  parseTransitionCommand(command: string): { state: StateMachineState; trigger: string } | null {
    const match = command.match(/^\/transition\s+(\w+)$/i);
    if (!match) {
      return null;
    }

    const stateName = match[1].toLowerCase() as StateMachineState;
    
    if (!Object.values(StateMachineState).includes(stateName)) {
      return null;
    }

    return {
      state: stateName,
      trigger: `Command: /transition ${stateName}`
    };
  }
}
