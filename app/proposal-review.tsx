"use client";

type Proposal = {
  intendedBehavior?: string;
  scope?: string[];
  exclusions?: string[];
  assumptions?: string[];
  acceptanceCriteria?: { text: string; verification: string }[];
  verification?: string[];
};

function ReviewList({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return <section className="proposal-section"><h3>{title} <span>{items.length}</span></h3><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></section>;
}

/** Display the saved revision verbatim; approval still uses its original identity. */
export function ProposalReview({ proposal, goal }: { proposal: Proposal; goal: string }) {
  // Keyboard users need a focus target to scroll this bounded reading region.
  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
  return <div className="proposal-reading-area" role="region" aria-label="Proposal details" tabIndex={0}>
    <section className="proposal-section proposal-outcome"><h3>Intended outcome</h3><p>{proposal.intendedBehavior || goal}</p></section>
    <ReviewList title="In scope" items={proposal.scope} />
    <ReviewList title="Out of scope" items={proposal.exclusions} />
    <ReviewList title="Assumptions" items={proposal.assumptions} />
    {Boolean(proposal.acceptanceCriteria?.length) && <section className="proposal-section"><h3>Acceptance criteria <span>{proposal.acceptanceCriteria!.length}</span></h3><ol>{proposal.acceptanceCriteria!.map((criterion, index) => <li key={index}><div>{criterion.text}</div>{criterion.verification && <div className="proposal-evidence"><strong>How to verify</strong><div>{criterion.verification}</div></div>}</li>)}</ol></section>}
    <ReviewList title="Verification plan" items={proposal.verification} />
  </div>;
}
