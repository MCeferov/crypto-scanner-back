import nodemailer from "nodemailer";
import { config } from "dotenv"; config();
for (const [label, extra] of [["default", {}], ["ipv4", { family: 4 }], ["ipv4", { family: 4 }], ["port2525-ipv4", { family: 4, port: 2525 }]]) {
  const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: 587, secure: false, family: undefined, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }, connectionTimeout: 15000, ...extra });
  const t0 = Date.now();
  try { await t.verify(); console.log(label, "OK", Date.now() - t0, "ms"); }
  catch (e) { console.log(label, "FAIL", e.code, e.responseCode ?? "", String(e.message).slice(0, 80), Date.now() - t0, "ms"); }
}
