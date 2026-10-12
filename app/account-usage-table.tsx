"use client";
import { Fragment, useState } from "react";
import { ProviderLogo } from "./provider-logo";
import { AccountDetailContent, AccountStatusNotes, RedeemableResets } from "./account-usage-account";
import { coreReadings, freshReading, percentTone, planLabel, resetText, shortDate, statusLabel, type AccountRow, type UpcomingReset, type UsageAccount, type UsageProvider, type UsageWindow } from "./account-usage-model";

type Props = { rows: AccountRow[]; usableOnly: boolean; now: number; snapshotFresh: boolean; nextReset: UpcomingReset | null; onDeleted: (id: string) => Promise<void>; onReconnect: (provider: UsageProvider, account: UsageAccount) => void };
const COLUMNS = 8;

export function AccountTable({ rows, usableOnly, now, snapshotFresh, nextReset, onDeleted, onReconnect }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return <div className="usage-table-wrap"><table className="usage-table" aria-label="All accounts">
    <thead><tr><th scope="col">Account</th><th scope="col">Weekly</th><th scope="col">Fable weekly</th><th scope="col">5 hours</th><th scope="col">Resets in</th><th scope="col">Redeemable resets</th><th scope="col">Queue state</th><th scope="col"><span className="sr-only">Details</span></th></tr></thead>
    <tbody>
      {rows.map(({ provider, account, reset, state }) => {
        const fresh = snapshotFresh && provider.available;
        const readings = coreReadings(account, provider.id, now, fresh);
        const name = account.email || account.label;
        const open = expanded.has(account.id);
        const isNext = nextReset?.provider.id === provider.id && nextReset.account.id === account.id;
        return <Fragment key={account.id}>
          <tr id={`usage-account-${account.id}`} tabIndex={-1} className={`usage-row ${readings.displayStatus}${isNext ? ' next-reset-account' : ''}`}>
            <th scope="row"><div className="usage-row-account">
              <span className="usage-row-name"><ProviderLogo provider={provider.id} /><strong title={name}>{name}</strong></span>
              <span className="usage-row-meta"><small className="account-plan">{planLabel(account.plan).replace('Plan: ', '')}</small>{account.isDefault && <small>Default</small>}{account.paused && <small>Paused</small>}<span className={`usage-status ${readings.displayStatus}`}>{!readings.capacityKnown && account.status !== 'reconnect' ? 'Unknown' : statusLabel(account.status, account.windows.length)}</span>{isNext && <span className="next-reset-tag">Next reset</span>}</span>
              <AccountStatusNotes account={account} snapshotFresh={fresh} now={now} />
            </div></th>
            <GaugeCell window={readings.weekly} now={now} />
            {provider.id === 'claude' ? <GaugeCell window={readings.fable} now={now} /> : <td className="usage-na">—</td>}
            {provider.id === 'claude' ? <GaugeCell window={readings.session} now={now} /> : <td className="usage-na">—</td>}
            <td className="usage-reset">{reset ? <><strong>{countdown(reset.window.resetAt, now)}</strong><small><time dateTime={reset.window.resetAt!}>{shortDate(reset.window.resetAt!)}</time></small></> : <small>No reset reported</small>}</td>
            <td className="usage-redeemable"><RedeemableResets compact inventory={account.redeemableResets} fresh={fresh && account.status !== 'reconnect' && freshReading(account.updatedAt, now)} providerId={provider.id} now={now} /></td>
            <td className="usage-queue-state"><span className={`queue-pill ${state.toLowerCase().replaceAll(' ', '-')}`}>{state}</span></td>
            <td className="usage-expand"><button type="button" aria-expanded={open} aria-controls={`usage-row-detail-${account.id}`} aria-label={`${open ? 'Hide' : 'Show'} details for ${name}`} onClick={() => toggle(account.id)}>{open ? '⌃' : '⌄'}</button></td>
          </tr>
          {open && <tr id={`usage-row-detail-${account.id}`} className="usage-row-detail"><td colSpan={COLUMNS}>
            <AccountDetailContent providerLabel={provider.label} account={account} now={now} capacityKnown={readings.capacityKnown} extras={readings.extras} onDeleted={() => onDeleted(account.id)} onReconnect={() => onReconnect(provider, account)} />
            <RedeemableResets inventory={account.redeemableResets} fresh={fresh && account.status !== 'reconnect' && freshReading(account.updatedAt, now)} providerId={provider.id} now={now} />
          </td></tr>}
        </Fragment>;
      })}
      {!rows.length && <tr><td colSpan={COLUMNS} className="usage-table-empty">{usableOnly ? 'No usable capacity with an upcoming weekly reset is reported.' : 'No accounts are connected.'}</td></tr>}
    </tbody>
  </table></div>;
}

// Column headers already say what resets, so cells drop the "Resets in" prefix.
function countdown(value: string | null, now: number) { return resetText(value, now).replace('Resets in ', ''); }

function GaugeCell({ window, now }: { window?: UsageWindow; now: number }) {
  if (!window) return <td className="usage-gauge missing"><strong>—</strong> <small>Not reported</small></td>;
  return <td className={`usage-gauge ${percentTone(window.remainingPercent)}`}>
    <span className="usage-gauge-line"><strong>{window.remainingPercent}%<span className="sr-only"> remaining</span></strong><small>{window.resetAt ? <time dateTime={window.resetAt} title={`${resetText(window.resetAt, now)} · ${new Date(window.resetAt).toLocaleString()}`}>{countdown(window.resetAt, now)}</time> : 'Reset unknown'}</small></span>
    <div className="quota-track"><i style={{ width: `${window.remainingPercent}%` }} /></div>
  </td>;
}
