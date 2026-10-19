import { describe, expect, it, vi } from "vitest";

const createTransport = vi.fn<(options: Record<string, unknown>) => unknown>(() => ({ sendMail: vi.fn(async () => ({ messageId: "<id@test>" })) }));
vi.mock("nodemailer", () => ({ createTransport }));

const { createSmtpSender } = await import("../src/modules/email/smtp-sender.js");

describe("SMTP sender", () => {
  it("passes requireTLS to nodemailer so plain smtp:// must upgrade with STARTTLS", () => {
    createSmtpSender("smtp://smtp.example.com:587", "Spark <no-reply@spark.example>", { requireTls: true });
    expect(createTransport.mock.calls.at(-1)?.[0]).toMatchObject({ url: "smtp://smtp.example.com:587", requireTLS: true });
    createSmtpSender("smtp://127.0.0.1:1025", "Spark <no-reply@spark.local>", { requireTls: false });
    expect(createTransport.mock.calls.at(-1)?.[0]).toMatchObject({ requireTLS: false });
  });
});
