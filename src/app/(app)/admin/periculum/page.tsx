import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { periculumSettingsView } from "@/server/integrations/periculum/settings";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { CredentialsForm, TestSignIn } from "./Forms";

export const metadata = { title: "Periculum connection" };

/** Super Admin: Periculum API credentials (the secret is write-only) and a free sign-in test. */
export default async function PericulumSettingsPage() {
  await requireSuperAdmin();
  const v = await periculumSettingsView(db);
  const s = v.saved;
  return (
    <>
      <PageHeader
        crumbs={[{ href: "/admin", label: "Administration" }, { label: "Periculum" }]}
        eyebrow="Administration · Integrations"
        title="Periculum connection"
        intro="The API credentials ARAF uses for Automatic Statement Analysis. Copy them from the bank's Insights portal (Settings → API Credentials). The secret is stored encrypted and is never displayed again."
      />
      <div className="grid-2" style={{ alignItems: "start" }}>
        <section className="card stack" aria-labelledby="h-cred">
          <h2 id="h-cred" style={{ margin: 0 }}>
            Credentials
          </h2>
          <CredentialsForm v={{ clientId: s?.client_id ?? "", baseUrl: s?.base_url ?? v.defaults.baseUrl, authUrl: s?.auth_url ?? v.defaults.authUrl, hasSecret: !!s }} />
        </section>
        <div className="stack">
          <section className="card stack" aria-labelledby="h-status">
            <h2 id="h-status" style={{ margin: 0 }}>
              Status
            </h2>
            <table className="kv">
              <tbody>
                <tr>
                  <th>Credentials</th>
                  <td>
                    {s ? (
                      <>
                        Saved {formatLagos(s.updated_at)}
                        {s.updated_by_name ? ` by ${s.updated_by_name}` : ""}
                      </>
                    ) : v.environmentHasCredentials ? (
                      "From the server environment"
                    ) : (
                      <span className="err">Not set</span>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Last sign-in test</th>
                  <td>
                    {s?.last_test_at ? (
                      <>
                        <span className={`badge ${s.last_test_ok ? "badge-green" : "badge-red"}`}>{s.last_test_ok ? "Signed in" : "Failed"}</span> {formatLagos(s.last_test_at)}
                        <div className="small">{s.last_test_message}</div>
                      </>
                    ) : (
                      "Not tested"
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Statement analysis</th>
                  <td>{v.enabled ? (v.mode === "fixture" ? "On (labelled test data)" : "On") : "Off: switched on by the server setting PERICULUM_ENABLED after approvals"}</td>
                </tr>
                <tr>
                  <th>Blacklist Search</th>
                  <td>{v.blacklistEnabled ? "On" : "Off"}</td>
                </tr>
              </tbody>
            </table>
            <TestSignIn disabled={!s && !v.environmentHasCredentials} />
          </section>
        </div>
      </div>
    </>
  );
}
