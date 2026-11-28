import { useEffect, useState } from "react";
import { PanelError } from "./Panel";
import type { UsageBucketDto, UsageDto } from "./api.js";

// KAM-325: the hosted Usage panel. What the workspace has run, how many model tokens that used and what it cost, by
// day and by deployment, with the monthly and concurrent run limits beside current use. It shows what the server
// stored and adds nothing: a cost is shown only for runs whose model had a price, and the panel says how many that
// is, so a shortfall is never read as "free".

export interface UsagePanelProps {
  load: (days: number) => Promise<UsageDto>;
}

const WINDOWS = [7, 30, 90] as const;

const number = (n: number) => n.toLocaleString("en-US");

export function formatCost(bucket: UsageBucketDto): string {
  if (bucket.costUsd === null) return "No price set";
  const digits = bucket.costUsd !== 0 && bucket.costUsd < 0.01 ? 4 : 2;
  return `$${bucket.costUsd.toFixed(digits)}`;
}

function costNote(b: UsageBucketDto): string | null {
  if (b.runs === 0) return null;
  if (b.costRuns === 0)
    return "No price is set for the models these runs used, so the cost is not estimated. Tokens are still counted.";
  if (b.costRuns < b.runs)
    return `The cost covers ${b.costRuns} of ${b.runs} runs. The others used a model with no price, or no model.`;
  return null;
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  return (
    <div className="md3-usage__meter">
      <span className="md3-body-small">
        {label}:{" "}
        <strong>
          {number(used)} of {limit > 0 ? number(limit) : "no limit"}
        </strong>
      </span>
      {limit > 0 && (
        <progress
          className="md3-usage__bar"
          value={Math.min(used, limit)}
          max={limit}
          aria-label={label}
        />
      )}
    </div>
  );
}

export function UsagePanel({ load }: UsagePanelProps) {
  const [days, setDays] = useState<number>(30);
  const [usage, setUsage] = useState<UsageDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    load(days).then(
      (u) => !cancelled && setUsage(u),
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [load, days]);

  const note = usage ? costNote(usage.totals) : null;

  return (
    <div className="md3-usage" data-testid="usage-panel-body">
      {error && <PanelError messages={[error]} />}
      {!usage && !error && <p className="md3-body-medium">Loading usage…</p>}
      {usage && (
        <>
          <div className="md3-usage__limits" data-testid="usage-limits">
            <Meter
              label="Runs this month"
              used={usage.limits.monthlyRuns.used}
              limit={usage.limits.monthlyRuns.limit}
            />
            <Meter
              label="Runs going now"
              used={usage.limits.concurrentRuns.running}
              limit={usage.limits.concurrentRuns.limit}
            />
            {usage.limits.maxRunMinutes > 0 && (
              <span className="md3-body-small md3-usage__muted">
                A run is stopped after {usage.limits.maxRunMinutes} minutes.
              </span>
            )}
          </div>

          <div className="md3-usage__row">
            <label className="md3-body-small" htmlFor="usage-window">
              Show the last
            </label>
            <select
              id="usage-window"
              className="md3-text-field"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {w} days
                </option>
              ))}
            </select>
          </div>

          <dl className="md3-usage__totals" data-testid="usage-totals">
            <div>
              <dt className="md3-body-small">Runs</dt>
              <dd className="md3-title-medium">{number(usage.totals.runs)}</dd>
            </div>
            <div>
              <dt className="md3-body-small">Tokens in / out</dt>
              <dd className="md3-title-medium">
                {number(usage.totals.tokensIn)} / {number(usage.totals.tokensOut)}
              </dd>
            </div>
            <div>
              <dt className="md3-body-small">Estimated cost</dt>
              <dd className="md3-title-medium" data-testid="usage-cost">
                {formatCost(usage.totals)}
              </dd>
            </div>
          </dl>
          {note && (
            <p className="md3-body-small md3-usage__muted" data-testid="usage-cost-note">
              {note}
            </p>
          )}

          {usage.totals.runs === 0 ? (
            <p className="md3-body-medium">No runs in this window.</p>
          ) : (
            <>
              <h3 className="md3-title-small">By deployment</h3>
              <table className="md3-usage__table" data-testid="usage-deployments">
                <thead>
                  <tr>
                    <th scope="col">Workflow</th>
                    <th scope="col">Runs</th>
                    <th scope="col">Tokens</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.deployments.map((d) => (
                    <tr key={d.specId}>
                      <th scope="row">{d.name}</th>
                      <td>{number(d.runs)}</td>
                      <td>{number(d.tokensIn + d.tokensOut)}</td>
                      <td>{formatCost(d)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h3 className="md3-title-small">By day</h3>
              <table className="md3-usage__table" data-testid="usage-days">
                <thead>
                  <tr>
                    <th scope="col">Day (UTC)</th>
                    <th scope="col">Runs</th>
                    <th scope="col">Tokens</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {[...usage.days].reverse().map((d) => (
                    <tr key={d.day}>
                      <th scope="row">{d.day}</th>
                      <td>{number(d.runs)}</td>
                      <td>{number(d.tokensIn + d.tokensOut)}</td>
                      <td>{formatCost(d)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}
