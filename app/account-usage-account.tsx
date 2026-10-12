"use client";
import { useRef, useState } from "react";
import { coreReadings, displayLabel, freshReading, percentTone, planLabel, redeemableSummary, relativeUpdated, resetText, shortDate, statusLabel, type ResetInventory, type UsageAccount, type UsageProvider, type UsageWindow } from './account-usage-model';

export function AccountStatusNotes({ account, snapshotFresh, now }: { account: UsageAccount; snapshotFresh: boolean; now: number }) {
  return <>
    {snapshotFresh && account.status === 'unavailable' && account.message && <p className="account-unavailable-reason" title={account.message}>{account.message}</p>}
    {snapshotFresh && account.status === 'unavailable' && account.retryAt && Number.isFinite(Date.parse(account.retryAt)) && <p className="account-retry"><time dateTime={account.retryAt} title={new Date(account.retryAt).toLocaleString()}>{Date.parse(account.retryAt) <= now ? 'Ready to retry usage' : resetText(account.retryAt, now).replace('Resets in ', 'Retry in ')}</time></p>}
  </>;
}

export type AccountDetailProps = { providerLabel: string; account: UsageAccount; now: number; capacityKnown: boolean; extras: UsageWindow[]; onDeleted: () => Promise<void>; onReconnect?: () => void };
// Reading time, messages, extra limits and confirmed deletion. The card shows
// it under Details; the table shows it in the expanded row.
export function AccountDetailContent({ providerLabel, account, now, capacityKnown, extras, onDeleted, onReconnect }: AccountDetailProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const removing = useRef(false);
  const remove = async () => {
    if (removing.current) return;
    removing.current = true;
    setDeleting(true); setDeleteError("");
    try {
      const response = await fetch(`/api/account-usage/${encodeURIComponent(account.id)}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not delete connection");
      await onDeleted();
      setConfirming(false);
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : "Could not delete connection");
    } finally { removing.current = false; setDeleting(false); }
  };
  return <div className="account-detail-content">
    <p className="account-reading">{account.updatedAt ? relativeUpdated(account.updatedAt, now) : 'Reading time unavailable'}</p>
    {!capacityKnown && <p className="account-message">Capacity unknown: the reading is unavailable, failed or older than 15 minutes.</p>}
    {account.message && <p className={`account-message ${account.status}`}>{account.message}</p>}
    {onReconnect && !confirming && account.status === "reconnect" && <button className="account-reconnect" onClick={onReconnect}>Reconnect account</button>}
    {extras.length > 0 && <div className="extra-windows"><p>Additional limits</p>{extras.map((window) => <ExtraWindow window={window} now={now} key={window.id} />)}</div>}
    {confirming ? <div className="connection-confirmation" role="group" aria-label="Delete connection confirmation">
      <p>Delete the {providerLabel} connection for <strong>{account.email || account.label}</strong>?</p>
      <p>This removes its saved login from CCS on this Mac. You’ll need to sign in again to use it. Your provider account and subscription remain active.</p>
      {account.isDefault && <p>CCS will choose another default account if one remains.</p>}
      {deleteError && <p role="alert">{deleteError}</p>}
      <div><button disabled={deleting} onClick={() => { setConfirming(false); setDeleteError(""); }}>Cancel</button><button className="connection-delete" disabled={deleting} onClick={() => void remove()}>{deleting ? "Deleting…" : "Confirm delete"}</button></div>
    </div> : <button className="connection-delete" onClick={() => setConfirming(true)}>Delete connection</button>}
  </div>;
}

export function AccountCard({ providerId, account, now, onReconnect, onDeleted, providerLabel, snapshotFresh, nextWindowId }: { providerId: UsageProvider["id"]; nextWindowId?: string; onDeleted: () => Promise<void>; providerLabel: string; account: UsageAccount; now: number; snapshotFresh: boolean; onReconnect: () => void }) {
  const { capacityKnown, displayStatus, weekly, fable, session, extras } = coreReadings(account, providerId, now, snapshotFresh);
  return <article id={`usage-account-${account.id}`} tabIndex={-1} className={`usage-account ${displayStatus}${nextWindowId ? ' next-reset-account' : ''}`}><header><div><strong>{account.email || account.label}</strong><span className="account-plan">{planLabel(account.plan)}</span><span>{[account.isDefault ? "Default" : null, account.paused ? "Paused" : null].filter(Boolean).join(" · ")}</span></div><span className={`usage-status ${displayStatus}`}>{!capacityKnown && account.status !== 'reconnect' ? 'Unknown' : statusLabel(account.status, account.windows.length)}</span>{nextWindowId && <span className="next-reset-tag">Next reset</span>}
    <AccountStatusNotes account={account} snapshotFresh={snapshotFresh} now={now} />
    {account.status === "reconnect" && <button className="account-reconnect" onClick={onReconnect}>Reconnect account</button>}</header>
    <div className={`core-window-grid${providerId === 'codex' ? ' weekly-only' : ' with-fable'}`}>
      <CoreWindow label="Weekly" window={weekly} now={now} />
      {providerId === 'claude' && <><CoreWindow label="Fable weekly" window={fable} now={now} /><CoreWindow label="5 hours" window={session} now={now} /></>}
    </div>
    <details className="usage-account-details"><summary>Details{extras.length > 0 && <span className="sr-only"> · {extras.length} additional limits</span>}</summary>
      <AccountDetailContent providerLabel={providerLabel} account={account} now={now} capacityKnown={capacityKnown} extras={extras} onDeleted={onDeleted} />
    </details>
    <RedeemableResets inventory={account.redeemableResets} fresh={snapshotFresh && account.status !== 'reconnect' && freshReading(account.updatedAt, now)} providerId={providerId} now={now} />
  </article>;
}

export function RedeemableResets({ inventory, fresh, providerId, now, compact = false }: { inventory?: ResetInventory | null; fresh: boolean; providerId: UsageProvider['id']; now: number; compact?: boolean }) {
  const { count, label, expiry, partial, blocked } = redeemableSummary(inventory, fresh, now);
  const expiryText = count !== null && count > 0 ? <>{expiry ? <><time dateTime={expiry} title={new Date(expiry).toLocaleString()}>{compact ? '' : `${partial ? 'Next reported expiry' : 'Next expiry'}: `}{shortDate(expiry)} · {resetText(expiry, now).replace('Resets in ', 'in ')}</time>{partial && !compact && ' · Some expiry details not reported'}</> : 'Expiry not reported'}{blocked && !compact && ' · Some resets cannot be used yet'}</> : null;
  if (compact) return <span className={`redeemable-compact${count && count > 0 ? ' has-resets' : ''}`}><strong>{label}</strong>{expiryText && <small>{expiryText}{partial && ' · partial'}{blocked && ' · not all usable'}</small>}</span>;
  return <div className={`redeemable-resets${count && count > 0 ? ' has-resets' : ''}`}>
    <div><strong>Redeemable resets</strong><span>{label}</span></div>
    {expiryText && <p>{expiryText}</p>}
    <a href={providerId === 'claude' ? 'https://claude.ai/settings/usage' : 'https://chatgpt.com/codex/settings/usage'} target="_blank" rel="noreferrer">Check {providerId === 'claude' ? 'Claude' : 'ChatGPT'} resets ↗</a>
  </div>;
}

export function CoreWindow({ label, window, now }: { label: string; window?: UsageWindow; now: number }) {
  const tone = window ? percentTone(window.remainingPercent) : "missing";
  return <div className={`core-window ${tone}${window?.cadence === '5h' || label === '5 hours' ? ' secondary-session' : ''}`}><div><span>{label}</span>{window ? <strong>{window.remainingPercent}% <em>remaining</em></strong> : <strong>—</strong>}</div>{window ? <><small className="quota-used">{100 - window.remainingPercent}% used</small><div className="quota-track"><i style={{ width: `${window.remainingPercent}%` }} /></div><ResetTime value={window.resetAt} now={now} /></> : <small>Not reported</small>}</div>;
}

export function ExtraWindow({ window, now }: { window: UsageWindow; now: number }) {
  return <div className={`extra-window ${percentTone(window.remainingPercent)}`}><div><strong>{displayLabel(window.label)}</strong><span>{window.cadence} · {100 - window.remainingPercent}% used</span></div><b>{window.remainingPercent}% remaining</b><ResetTime value={window.resetAt} now={now} /></div>;
}

export function ResetTime({ value, now }: { value: string | null; now: number }) {
  const reset = value ? new Date(value) : null;
  if (!reset || !Number.isFinite(reset.getTime())) return <small>Reset unknown</small>;
  return <small><time dateTime={reset.toISOString()} title={reset.toLocaleString()}>{resetText(value, now)}</time></small>;
}
