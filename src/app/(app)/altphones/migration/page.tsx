import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { ActionForm, SubmitButton } from "@/components/forms";
import { db } from "@/server/db";
import { formatLagos } from "@/server/time";
import { CLASSIFICATION_LABEL, type Classification, historicalTotals, listBatches, migrationAccess } from "@/server/altphones/migration";
import { stageRegisterAction } from "../actions";
import { STATUS_BADGE, STATUS_LABEL } from "./labels";

export const metadata = { title: "Historical migration" };

const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-NG");
const naira = (kobo: unknown) => `₦${(Number(kobo ?? 0) / 100).toLocaleString("en-NG", { maximumFractionDigits: 0 })}`;

export default async function MigrationHome() {
  const { session } = await requireUser();
  const access = await migrationAccess(db, session.staffId);
  if (!access.view) redirect("/altphones");
  const [batches, totals] = await Promise.all([listBatches(db), historicalTotals(db)]);
  const open = batches.find((b) => b.status === "DRAFT" || b.status === "SUBMITTED");
  const lastMonthEnd = (() => {
    const d = new Date(Date.now() + 3600_000);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10);
  })();
  const all = totals.reduce((a, t) => ({ accounts: a.accounts + t.accounts, units: a.units + t.units, outstanding: a.outstanding + Number(t.outstanding), arrears: a.arrears + Number(t.arrears) }), { accounts: 0, units: 0, outstanding: 0, arrears: 0 });

  return (
    <>
      <PageHeader
        eyebrow="Altphones"
        title="Historical migration"
        intro="Bring the sales register kept before ARAF into the system as verified records. Each upload is staged and checked; nothing is published until a Unit Head approves it, and publishing never moves stock."
      />

      <div className="metric-grid" style={{ marginBottom: "var(--space-4)" }}>
        {(
          [
            ["Verified historical accounts", n(all.accounts)],
            ["Phones", n(all.units)],
            ...(["CURRENT", "IN_ARREARS", "COMPLETED"] as Classification[]).map((s) => [CLASSIFICATION_LABEL[s], n(totals.find((t) => t.status === s)?.accounts ?? 0)] as [string, string]),
            ["Outstanding (register)", naira(all.outstanding)],
          ] as [string, string][]
        ).map(([k, v]) => (
          <div key={k} className="metric">
            <div className="k">{k}</div>
            <div className="v">{v}</div>
          </div>
        ))}
      </div>

      {access.prepare && !open && (
        <section className="card" aria-labelledby="h-upload">
          <h2 id="h-upload">Upload a register</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            Upload the workbook as it is kept by the team (.xlsx with Internal, External, Completed and Cancelled sheets). Rows are read, personal data is encrypted, and every row is classified from its monthly yes/no marks up to the as-at date: yes is a paid instalment, no a missed one. The Completed sheet is taken as completed; nothing else is assumed complete.
          </p>
          <ActionForm action={stageRegisterAction} encType="multipart/form-data" className="stack">
            <div className="grid-2">
              <div className="field">
                <label htmlFor="file">Register workbook (.xlsx)</label>
                <input id="file" name="file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
              </div>
              <div className="field">
                <label htmlFor="asAt">Register correct as at</label>
                <input id="asAt" name="asAt" type="date" required defaultValue={lastMonthEnd} />
                <span className="hint">The last day covered by the month columns. Months after it are not counted.</span>
              </div>
            </div>
            <div className="action-bar">
              <SubmitButton>Upload and check</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}
      {open && (
        <section className="card action-panel" aria-labelledby="h-open">
          <h2 id="h-open">In progress</h2>
          <p style={{ margin: 0 }}>
            <Link href={`/altphones/migration/${open.id}`} className="mono">
              {open.ref}
            </Link>{" "}
            — {open.filename} · <span className={`badge ${STATUS_BADGE[open.status]}`}>{STATUS_LABEL[open.status]}</span>
            {open.status === "DRAFT" && open.summary?.blockedOpen > 0 && <span className="small muted"> · {n(open.summary.blockedOpen)} records need a decision</span>}
          </p>
          <p className="small muted" style={{ marginBottom: 0 }}>
            One batch is worked on at a time, so the same customers are never staged twice.
          </p>
        </section>
      )}

      <section className="card" aria-labelledby="h-batches">
        <h2 id="h-batches">Batches</h2>
        {batches.length === 0 ? (
          <p className="muted">No register has been uploaded yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Batch</th>
                  <th scope="col">As at</th>
                  <th scope="col" className="num">
                    Records
                  </th>
                  <th scope="col" className="num">
                    Excluded
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Prepared</th>
                  <th scope="col">Decided</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link href={`/altphones/migration/${b.id}`} className="mono">
                        {b.ref}
                      </Link>
                      <div className="small muted">{b.filename}</div>
                    </td>
                    <td>{b.as_at}</td>
                    <td className="num">{n(b.summary?.records)}</td>
                    <td className="num">{n(b.summary?.excluded)}</td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[b.status]}`}>{STATUS_LABEL[b.status]}</span>
                    </td>
                    <td className="small">
                      {b.prepared_by_name}
                      <div className="muted">{formatLagos(b.prepared_at)}</div>
                    </td>
                    <td className="small">
                      {b.decided_by_name ?? "—"}
                      {b.decided_at && <div className="muted">{formatLagos(b.decided_at)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
