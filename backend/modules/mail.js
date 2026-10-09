import nodemailer from "nodemailer";
// One transport per config, shared by the OTP sender and security notices.
const transports = new WeakMap();
function transport(c) {
  if (transports.has(c)) return transports.get(c);
  const smtp = nodemailer.createTransport({
    host: c.SMTP_HOST,
    port: c.SMTP_PORT,
    secure: c.SMTP_SECURE === "true",
    requireTLS: c.NODE_ENV === "production",
    auth: c.SMTP_USER
      ? { user: c.SMTP_USER, pass: c.SMTP_PASSWORD }
      : undefined,
    connectionTimeout: 8000,
    socketTimeout: 10000,
  });
  transports.set(c, smtp);
  return smtp;
}
// Best-effort security notices (never contain codes or keys).
export function notifier(c) {
  const smtp = transport(c);
  return async (email, { subject, text }) => {
    await smtp.sendMail({ from: c.MAIL_FROM, to: email, subject, text });
  };
}
export function mailer(c) {
  const smtp = transport(c);
  return async (email, code) => {
    await smtp.sendMail({
      from: c.MAIL_FROM,
      to: email,
      subject: "Your Sandbee Admin verification code",
      text: `Your Sandbee Admin code is ${code}. It expires in 10 minutes. Never share this code. If you did not request it, ignore this email.`,
      html: `<div style="background:#f4f5f2;padding:40px 18px;font-family:Arial,sans-serif;color:#193b34"><div style="max-width:460px;margin:auto;background:white;border:1px solid #dce2dd;border-radius:16px;padding:32px"><div style="font-weight:700;font-size:19px">sandbee <span style="color:#727c76;font-weight:400">/ admin</span></div><h1 style="font-size:25px;margin-top:32px">Verify your access</h1><p style="color:#53645d;line-height:1.6">Use this code to complete your request. It is valid for 10 minutes and can be used once.</p><div style="background:#f4f5f2;padding:22px;text-align:center;font-size:32px;letter-spacing:9px;font-weight:700">${code}</div><p style="font-size:13px;line-height:1.6;color:#53645d;margin-top:24px">Never share this code. Sandbee will not ask for it by phone or chat. If you did not request this email, you can ignore it.</p></div></div>`,
    });
  };
}
