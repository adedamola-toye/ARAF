/* eslint-disable @next/next/no-img-element */
import s from "./landing.module.css";
import { AppearanceMenu } from "@/components/Appearance";
import { appearanceClasses, BankLogo } from "@/components/Brand";
import { themePreference } from "./_lib/theme";

export const metadata = { title: { absolute: "Retail Asset Factory" } };

/** Workspace entry points. Each goes through /enter/<workspace>, which reuses the existing OTP sign-in. */
const WORKSPACES = [
  { href: "/enter/relationship-manager", num: "01", title: "Relationship Manager", text: "Originate and manage customer financing requests." },
  { href: "/enter/delight-officer", num: "02", title: "Delight Officer / Smile Associate", text: "Sell Altphones outright or on credit." },
  { href: "/enter/staff-personal-request", num: "03", title: "Staff Personal Request", text: "Apply for financing and track your request." },
];

/** Approved landing page (V39). Markup mirrors the reference so landing.module.css applies unchanged. */
export default async function Landing() {
  const pref = await themePreference();
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
              {WORKSPACES.map((w) => (
                <a key={w.href} className={s.role} href={w.href}>
                  <div className={s["role-top"]}>
                    <span className={s["role-num"]}>{w.num}</span>
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
