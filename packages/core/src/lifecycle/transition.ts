import { DomainError } from "../primitives/errors.js";

/** A side-effect-free state-machine kernel. Persistence owns recorded command ids. */
export type TransitionTable<S extends string> = Readonly<{
  readonly [K in S]?: readonly S[];
}>;

export type TransitionResult<S extends string> =
  | Readonly<{ kind: "changed"; previous: S; current: S }>
  | Readonly<{ kind: "already_applied"; current: S }>;

export class InvalidTransitionError<
  S extends string = string,
> extends DomainError {
  override readonly name = "InvalidTransitionError";

  constructor(
    readonly lifecycle: string,
    readonly current: S,
    readonly target: S,
  ) {
    super(
      "INVALID_TRANSITION",
      `Cannot transition ${lifecycle} from ${current} to ${target}.`,
    );
  }
}

export class TransitionGuardError<
  S extends string = string,
> extends DomainError {
  override readonly name = "TransitionGuardError";

  constructor(
    readonly lifecycle: string,
    readonly current: S,
    readonly target: S,
    readonly reason: string,
  ) {
    super(
      "TRANSITION_GUARD_FAILED",
      `Cannot transition ${lifecycle} from ${current} to ${target}: ${reason}.`,
    );
  }
}

export type TransitionContext = Readonly<Record<string, unknown>>;

export interface TransitionCommand<S extends string> {
  readonly current: S;
  readonly target: S;
  /** A durable command identity, normally an idempotency key. */
  readonly idempotencyKey: string;
  /** The key of the command that produced the current state, if known. */
  readonly currentStateCommandKey?: string;
  readonly context?: TransitionContext;
}

export interface TransitionPolicy<S extends string> {
  readonly name: string;
  readonly initial: readonly S[];
  readonly terminal: readonly S[];
  /** States whose terminality additionally depends on adapter-provided context. */
  readonly contextualTerminal?: (
    state: S,
    context: TransitionContext | undefined,
  ) => boolean;
  readonly transitions: TransitionTable<S>;
  readonly guard?: (command: TransitionCommand<S>) => void;
}

export function isTerminal<S extends string>(
  policy: TransitionPolicy<S>,
  state: S,
  context?: TransitionContext,
): boolean {
  return (
    policy.terminal.includes(state) ||
    policy.contextualTerminal?.(state, context) === true
  );
}

/**
 * State equality is not idempotence: only replaying the same command is safe.
 * An adapter persists `currentStateCommandKey` with the aggregate transition.
 */
export function transition<S extends string>(
  policy: TransitionPolicy<S>,
  command: TransitionCommand<S>,
): TransitionResult<S> {
  if (command.idempotencyKey.trim().length === 0) {
    throw new TypeError("A transition requires a non-empty idempotency key.");
  }

  if (command.current === command.target) {
    if (command.currentStateCommandKey === command.idempotencyKey) {
      return { kind: "already_applied", current: command.current };
    }
    throw new InvalidTransitionError(
      policy.name,
      command.current,
      command.target,
    );
  }

  const targets = policy.transitions[command.current] ?? [];
  if (!targets.includes(command.target)) {
    throw new InvalidTransitionError(
      policy.name,
      command.current,
      command.target,
    );
  }

  policy.guard?.(command);

  return {
    kind: "changed",
    previous: command.current,
    current: command.target,
  };
}
