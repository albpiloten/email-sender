"use strict";

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, ".env");
const EMAILS_FILE = path.join(ROOT, "emails.txt");
const CONTENT_FILE = path.join(ROOT, "content.txt");

// ---------- helpers ----------

function loadEnv(file) {
  if (!fs.existsSync(file)) {
    fail(`Missing ${path.basename(file)} file.`);
  }
  const env = {};
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadRecipients(file) {
  if (!fs.existsSync(file)) {
    fail(`Missing ${path.basename(file)} file.`);
  }
  const recipients = [];
  const seen = new Set();
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [emailPart, ...nameParts] = line.split(",");
    const email = emailPart.trim();
    const name = nameParts.join(",").trim() || email;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      console.warn(`  ! skipping invalid address: "${line}"`);
      continue;
    }
    if (seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    recipients.push({ email, name });
  }
  return recipients;
}

function loadContent(file) {
  if (!fs.existsSync(file)) {
    fail(`Missing ${path.basename(file)} file.`);
  }
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");

  let subject = "";
  let bodyStart = 0;
  if (/^subject\s*:/i.test(lines[0] || "")) {
    subject = lines[0].replace(/^subject\s*:/i, "").trim();
    bodyStart = 1;
    // skip blank lines between subject and body
    while (bodyStart < lines.length && lines[bodyStart].trim() === "") {
      bodyStart++;
    }
  }
  const body = lines.slice(bodyStart).join("\n").trimEnd();

  if (!subject) fail('content.txt must start with a line like "Subject: ..."');
  if (!body) fail("content.txt has no body text.");
  return { subject, body };
}

function fill(template, vars) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) =>
    key in vars ? vars[key] : `{{${key}}}`
  );
}

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return /^(true|1|yes|on)$/i.test(value);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

// ---------- main ----------

async function main() {
  const env = loadEnv(ENV_FILE);

  for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "FROM_EMAIL"]) {
    if (!env[key]) fail(`${key} is not set in .env`);
  }

  const isHtml = (env.CONTENT_FORMAT || "text").toLowerCase() === "html";
  const delayMs = Number(env.DELAY_MS || 0);
  const dryRun = bool(env.DRY_RUN, false);

  const recipients = loadRecipients(EMAILS_FILE);
  const { subject, body } = loadContent(CONTENT_FILE);

  if (recipients.length === 0) fail("No valid recipients found in emails.txt");

  const from = env.FROM_NAME
    ? `"${env.FROM_NAME}" <${env.FROM_EMAIL}>`
    : env.FROM_EMAIL;

  console.log("=================================================");
  console.log(` SMTP      : ${env.SMTP_HOST}:${env.SMTP_PORT}`);
  console.log(` From      : ${from}`);
  console.log(` Subject   : ${subject}`);
  console.log(` Format    : ${isHtml ? "html" : "text"}`);
  console.log(` Recipients: ${recipients.length}`);
  console.log(` Dry run   : ${dryRun ? "YES (nothing will be sent)" : "no"}`);
  console.log("=================================================\n");

  const transportOptions = {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT),
    secure: bool(env.SMTP_SECURE, Number(env.SMTP_PORT) === 465),
    requireTLS: bool(env.SMTP_REQUIRE_TLS, Number(env.SMTP_PORT) === 587),
    tls: {
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    },
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    ...(env.SOCKS_PROXY ? { proxy: env.SOCKS_PROXY } : {}),
  };

  const transporter = nodemailer.createTransport(transportOptions);

  if (env.SOCKS_PROXY) {
    transporter.set("proxy_socks_module", require("socks"));
  }

  if (!dryRun) {
    try {
      await transporter.verify();
      console.log("SMTP connection OK.\n");
    } catch (err) {
      fail(`Could not connect to SMTP server: ${err.message}`);
    }
  }

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < recipients.length; i++) {
    const { email, name } = recipients[i];
    const vars = { name, email };
    const label = `[${i + 1}/${recipients.length}] ${email}`;

    const message = {
      from,
      to: name !== email ? `"${name}" <${email}>` : email,
      subject: fill(subject, vars),
      ...(env.REPLY_TO ? { replyTo: env.REPLY_TO } : {}),
      ...(isHtml ? { html: fill(body, vars) } : { text: fill(body, vars) }),
    };

    if (dryRun) {
      console.log(`${label}  (dry run)`);
      sent++;
    } else {
      try {
        await transporter.sendMail(message);
        console.log(`${label}  sent`);
        sent++;
      } catch (err) {
        console.error(`${label}  FAILED: ${err.message}`);
        failed++;
      }
    }

    if (delayMs > 0 && i < recipients.length - 1 && !dryRun) {
      await sleep(delayMs);
    }
  }

  console.log("\n-------------------------------------------------");
  console.log(` Done. Sent: ${sent}   Failed: ${failed}`);
  console.log("-------------------------------------------------");

  transporter.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => fail(err.message));
