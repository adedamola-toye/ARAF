/* eslint-disable @next/next/no-img-element */
import s from "./landing.module.css";

export const metadata = { title: { absolute: "Retail Asset Factory" } };

/** Workspace entry points. Each goes through /enter/<workspace>, which reuses the existing OTP sign-in. */
const WORKSPACES = [
  { href: "/enter/relationship-manager", num: "01", title: "Relationship Manager", text: "Originate and manage customer financing requests.", tone: s.rm },
  { href: "/enter/delight-officer", num: "02", title: "Delight Officer", text: "Initiate and manage in-branch financing requests.", tone: s.delight },
  { href: "/enter/staff-personal-request", num: "03", title: "Staff Personal Request", text: "Apply for financing and track your request.", tone: s.staff },
];

export default function Landing() {
  return (
    <div className={s.page}>
      <div className={s.shell}>
        <header className={s.header}>
          <div className={s.brand}>
            <h1>Retail Asset Factory</h1>
            <p>A Payments and Collections Product</p>
          </div>
          <img className={s.bankLogo} src="/images/landing/alternative-bank-logo.webp" alt="The Alternative Bank" width={460} height={231} decoding="async" />
        </header>
        <main className={s.main} id="main">
          <div className={s.hero}>
            <div className={s.intro}>
              <p className={s.eyebrow}>Retail Financing &amp; Disbursements</p>
              <h2>
                From Request to Disbursement. <em>Seamlessly.</em>
              </h2>
              <p>Initiate requests, manage approvals and track disbursements in one place.</p>
            </div>
            <div className={s.photo}>
              <img src="/images/landing/family.webp" alt="A smiling family at home" width={760} height={876} fetchPriority="high" />
            </div>
          </div>
          <section aria-labelledby="workspaces">
            <h2 id="workspaces" className={s.sectionLabel}>
              Continue to your workspace
            </h2>
            <div className={s.roles}>
              {WORKSPACES.map((w) => (
                <a key={w.href} href={w.href} className={`${s.role} ${w.tone}`}>
                  <div className={s.roleTop}>
                    <span className={s.roleNum}>{w.num}</span>
                    <span className={s.arrow} aria-hidden="true">
                      ›
                    </span>
                  </div>
                  <div>
                    <h3>{w.title}</h3>
                    <p>{w.text}</p>
                  </div>
                </a>
              ))}
            </div>
          </section>
          <p className={s.accessNote}>Authorised staff only. Available actions are determined by your assigned role.</p>
        </main>
        <footer className={s.footer}>
          <div className={s.footerCopy}>
            <p>A platform by The Alternative Bank.</p>
            <p>Internal use only</p>
          </div>
          <div className={s.footerLogos}>
            <img className={s.footerBankLogo} src="/images/landing/alternative-bank-logo.webp" alt="The Alternative Bank" width={460} height={231} loading="lazy" />
            <img className={s.footerNifiLogo} src="/images/landing/nifi-logo.png" alt="NIFI" width={210} height={165} loading="lazy" />
          </div>
        </footer>
      </div>
    </div>
  );
}
