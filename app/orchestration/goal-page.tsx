"use client";
import { useState } from 'react';
import type { Contract } from '../../server/orchestration/types';
import type { Action, Goal } from './goal-board';
import { DecisionBar, type NextStep } from './decision-bar';
import { GoalConversation } from './goal-conversation';
import { GoalTechnicalDetails } from './goal-detail';

/** One layout for every goal: the decision bar, the thread or request, the
 * result, one composer and one technical disclosure holding all evidence. */
export function GoalPage({ goal, disabled, terminal, act, control, pendingNext, onNextConsumed }: {
  goal: Goal & { contracts: { revision: number; contract: Contract }[] }; disabled: boolean; terminal: boolean;
  act(goal: Goal, action: Action): Promise<boolean>; control(goal: Goal, action: 'terminal' | 'reconcile', attemptId?: string): Promise<void>;
  pendingNext: NextStep | null; onNextConsumed(): void;
}) {
  // A next step chosen on this page is kept locally; one chosen on the list arrives as pendingNext.
  const [local, setLocal] = useState<NextStep | null>(null);
  const consume = () => { setLocal(null); onNextConsumed(); };
  return <>
    <DecisionBar goal={goal} disabled={disabled} act={act} openNext={setLocal} />
    <GoalConversation goal={goal} disabled={disabled} act={act} next={pendingNext ?? local} onNextConsumed={consume} />
    <details className="orch-card goal-technical-details" aria-label="Technical details"><summary>Technical details</summary><GoalTechnicalDetails goal={goal} disabled={disabled} terminal={terminal} act={act} control={control} /></details>
  </>;
}
