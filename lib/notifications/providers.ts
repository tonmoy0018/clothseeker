import { createTransport, type Transporter } from "nodemailer";

// How emails leave the system. Behind an interface so the provider can be swapped:
// - smtp: any SMTP server. Locally that's Mailpit (Supabase's test inbox), in production any
//   transactional email service (configured in Phase 9).
// - log: development without email; the sender logs only the kind and id.
// - memory: tests.

export type OutgoingEmail = { to: string; from: string; subject: string; text: string; html: string };

export interface EmailProvider {
  readonly name: string;
  send(email: OutgoingEmail): Promise<void>;
}

export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  private readonly transport: Transporter;

  constructor(url: string) {
    this.transport = createTransport(url);
  }

  async send(email: OutgoingEmail): Promise<void> {
    await this.transport.sendMail(email);
  }
}

export class LogEmailProvider implements EmailProvider {
  readonly name = "log";

  async send(): Promise<void> {
    // Intentionally nothing: the sender already logs kind + id (never addresses or content).
  }
}

export class MemoryEmailProvider implements EmailProvider {
  readonly name = "memory";
  readonly sent: OutgoingEmail[] = [];

  constructor(private readonly fail: (email: OutgoingEmail) => boolean = () => false) {}

  async send(email: OutgoingEmail): Promise<void> {
    if (this.fail(email)) {
      throw new Error("send failed");
    }
    this.sent.push(email);
  }
}
