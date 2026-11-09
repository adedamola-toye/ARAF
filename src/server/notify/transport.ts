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

/** TEST ADAPTER: captures messages in the dev_mailbox table. Never used by the app by default. */
class DevMailbox implements MailTransport {
  readonly name = "test-mailbox";
  async send(m: OutgoingEmail) {
    assertNotProduction("Test mailbox");
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

/** Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
class ResendTransport implements MailTransport {
  readonly name = "resend";
  async send(m: OutgoingEmail) {
    const r = config.resend;
    if (!r.apiKey) throw new Error("RESEND_API_KEY is required when MAIL_DRIVER=resend");
    const body: Record<string, unknown> = {
      from: config.mailFrom,
      to: m.to,
      subject: m.subject,
      text: m.text,
    };
    if (m.cc.length) body.cc = m.cc;
    if (r.replyTo) body.reply_to = r.replyTo;
    if (m.attachments.length) {
      body.attachments = m.attachments.map((a) => ({
        filename: a.filename,
        content: a.content.toString("base64"),
        content_type: a.contentType,
      }));
    }
    const res = await fetch(`${r.baseUrl}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${r.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500);
      throw new Error(`Resend API ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as { id?: string };
    return { messageId: data.id ? `resend-${data.id}` : `resend-${Date.now()}` };
  }
}

let transport: MailTransport | null = null;
export function mailTransport(): MailTransport {
  if (!transport) {
    transport =
      config.mailDriver === "resend"
        ? new ResendTransport()
        : config.mailDriver === "smtp"
          ? new SmtpTransport()
          : new DevMailbox();
  }
  return transport;
}
export function setMailTransportForTests(t: MailTransport | null) {
  transport = t;
}
