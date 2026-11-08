import { config, assertNotProduction } from "../config";
import { db } from "../db";

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}
export interface OutgoingEmail {
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  attachments: OutgoingAttachment[];
  outboxId?: string | null;
}
export interface MailTransport {
  readonly name: string;
  send(m: OutgoingEmail): Promise<{ messageId: string }>;
}

/** DEVELOPMENT ADAPTER: stores messages in the dev_mailbox table, viewable at /dev/mailbox. */
class DevMailbox implements MailTransport {
  readonly name = "dev-mailbox (development adapter)";
  async send(m: OutgoingEmail) {
    assertNotProduction("Development mailbox");
    const r = await db.query<{ id: string }>(
      `INSERT INTO dev_mailbox (outbox_id, to_addresses, cc_addresses, subject, body_text, attachments)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        m.outboxId ?? null,
        m.to,
        m.cc,
        m.subject,
        m.text,
        JSON.stringify(m.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.content.length }))),
      ],
    );
    return { messageId: `dev-${r.rows[0].id}` };
  }
}

/** SMTP relay (bank-approved delivery channel). */
class SmtpTransport implements MailTransport {
  readonly name = "smtp";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private transporter: any = null;
  async send(m: OutgoingEmail) {
    if (!this.transporter) {
      const nodemailer = await import("nodemailer");
      const s = config.smtp;
      this.transporter = nodemailer.createTransport({
        host: s.host,
        port: s.port,
        secure: s.secure,
        auth: s.user ? { user: s.user, pass: s.pass } : undefined,
      });
    }
    const info = await this.transporter.sendMail({
      from: config.mailFrom,
      to: m.to,
      cc: m.cc.length ? m.cc : undefined,
      subject: m.subject,
      text: m.text,
      attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    return { messageId: String(info.messageId) };
  }
}

let transport: MailTransport | null = null;
export function mailTransport(): MailTransport {
  if (!transport) transport = config.mailDriver === "smtp" ? new SmtpTransport() : new DevMailbox();
  return transport;
}
export function setMailTransportForTests(t: MailTransport | null) {
  transport = t;
}
