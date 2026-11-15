/* eslint-disable @next/next/no-img-element */
import s from "./landing.module.css";
import { AppearanceMenu } from "@/components/Appearance";
import { appearanceClasses, BankLogo } from "@/components/Brand";
import { cookies } from "next/headers";
import { themePreference } from "./_lib/theme";
import { baseCtx } from "./_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";

export const metadata = { title: { absolute: "Retail Asset Factory" } };

/** Workspace entry points. Each goes through /enter/<workspace>, which reuses the existing OTP sign-in. */
const WORKSPACES: { href: string; title: string; text: string; roles?: string[] }[] = [
  { roles: ["RM"], href: "/enter/relationship-manager", title: "Relationship Manager", text: "Originate and manage customer financing requests." },
  { roles: ["DELIGHT_OFFICER", "SMILE_ASSOCIATE"], href: "/enter/delight-officer", title: "Delight Officer / Smile Associate", text: "Sell Altphones outright or on credit." },
  { href: "/enter/staff-personal-request", title: "Staff Personal Request", text: "Apply for financing and track your request." },
];

/** Approved landing page (V39). Markup mirrors the reference so landing.module.css applies unchanged. */
export default async function Landing() {
  const pref = await themePreference();
  // Signed in: offer only the workspaces this person holds (the entry routes enforce the same rule).
  let held: string[] | null = null;
  try {
    const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, await baseCtx(), { touch: false });
    if (r.status === "ok") held = r.session.roles.map((x) => x.role);
  } catch {
    held = null;
  }
  const workspaces = WORKSPACES.filter((w) => !held || !w.roles || w.roles.some((r) => held.includes(r)));
  return (
    <div className={s.page}>
      <div className={s.shell}>
        <header>
          <div className={s.brand}>
            <h1>Retail Asset Factory</h1>
            <p>A Payments and Collections Product</p>
          </div>
          <div className={s["header-actions"]}>
            <BankLogo className={s["bank-logo"]} />
          </div>
        </header>
        <main id="main">
          <div className={s.hero}>
            <div className={s.intro}>
              <p className={s.eyebrow}>RETAIL FINANCING &amp; DISBURSEMENTS</p>
              <h2>
                From Request to Disbursement. <em>Seamlessly.</em>
              </h2>
              <p>Initiate requests, manage approvals and track disbursements in one place.</p>
            </div>
            <div className={s.photo}>
              <img alt="A smiling family of three: a mother and daughter in beige hijabs and a father in beige, against a yellow background" src="/images/landing/family.webp" width={760} height={876} fetchPriority="high" />
            </div>
          </div>
          <section aria-labelledby="workspaces">
            <h2 id="workspaces" className={s["section-label"]}>
              Continue to your workspace
            </h2>
            <div className={s.roles}>
              {workspaces.map((w, i) => (
                <a key={w.href} className={s.role} href={w.href}>
                  <div className={s["role-top"]}>
                    <span className={s["role-num"]}>{String(i + 1).padStart(2, "0")}</span>
                    <span aria-hidden="true" className={s.arrow}>
                      ›
                    </span>
                  </div>
                  <div className={s["role-bottom"]}>
                    <h3>{w.title}</h3>
                    <p>{w.text}</p>
                  </div>
                </a>
              ))}
            </div>
          </section>
          <p className={s["access-note"]}>Authorised staff only. Available actions are determined by your assigned role.</p>
          <p className={s.notice} aria-hidden="true" />
        </main>
        <footer>
          <div className={s["footer-copy"]}>
            <p>A platform by The Alternative Bank.</p>
            <p>Internal use only</p>
          </div>
          <div className={s["footer-logos"]}>
            <BankLogo className={s["footer-bank-logo"]} lazy />
            <img alt="NIFI" className={s["footer-nifi-logo"]} src="/images/landing/nifi-logo.png" width={210} height={165} loading="lazy" />
          </div>
          <AppearanceMenu initial={pref} classes={appearanceClasses} />
        </footer>
      </div>
    </div>
  );
}
