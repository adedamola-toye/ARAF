import { notFound } from "next/navigation";
import { AuthFrame } from "@/components/Brand";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { formatLagos } from "@/server/time";

export const metadata = { title: "Development mailbox" };
export const dynamic = "force-dynamic";

/** DEVELOPMENT ONLY: shows messages captured by the dev mail adapter. Disabled in production. */
export default async function DevMailbox({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (config.isProduction || config.mailDriver !== "dev") notFound();
  const sp = await searchParams;
  const to = (sp.to ?? "").toLowerCase();
  const rows = (await db.query("SELECT * FROM dev_mailbox WHERE ($1 = '' OR $1 = ANY(to_addresses) OR $1 = ANY(cc_addresses)) ORDER BY id DESC LIMIT 40", [to])).rows;
  return (
    <AuthFrame right={<span className="badge badge-yellow">Development adapter</span>}>
      <div className="stack">
        <div className="card">
          <h1>Development mailbox</h1>
          <p className="muted" style={{ margin: 0 }}>Emails captured by the development mail adapter (MAIL_DRIVER=dev). This page does not exist in production. Assignment emails appear after the worker runs (npm run worker).</p>
          <form className="row" method="get" style={{ marginTop: 12 }}>
            <input name="to" type="email" placeholder="Filter by recipient" defaultValue={sp.to ?? ""} style={{ maxWidth: 320 }} aria-label="Filter by recipient" />
            <button className="btn btn-sm">Filter</button>
          </form>
        </div>
        {rows.map((m) => (
          <article className="card" key={m.id}>
            <div className="small muted">{formatLagos(m.created_at)} · to {m.to_addresses.join(", ")}{m.cc_addresses.length ? ` · cc ${m.cc_addresses.join(", ")}` : ""}</div>
            <h2 style={{ fontSize: "1rem", marginTop: 4 }}>{m.subject}</h2>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, margin: 0 }}>{m.body_text}</pre>
            {m.attachments.length > 0 && <p className="small muted" style={{ marginBottom: 0 }}>{m.attachments.length} attachment(s): {m.attachments.map((a: { filename: string }) => a.filename).join(", ")}</p>}
          </article>
        ))}
      </div>
    </AuthFrame>
  );
}
