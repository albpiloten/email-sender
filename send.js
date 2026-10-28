"use strict";

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const { Resend } = require("resend");

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
      value = value.slice(1, -1).trim();
    }
    env[key] = value;
  }
  return env;
}

function nameFromEmail(email) {
  return email
    .slice(0, email.lastIndexOf("@"))
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function loadRecipients(file, nameSource) {
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
    const columnName = nameParts.join(",").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      console.warn(`  ! skipping invalid address: "${line}"`);
      continue;
    }
    if (nameSource === "column" && !columnName) {
      console.warn(`  ! skipping address without a name column: "${line}"`);
      continue;
    }
    if (seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    const name = nameSource === "column" ? columnName : nameFromEmail(email);
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

function stripInvisible(value) {
  return String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .trim();
}

const BARE_EMAIL =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

function extractEmail(value) {
  const cleaned = stripInvisible(value);
  const bracketed = cleaned.match(/<([^<>\s]+)>/);
  if (bracketed && BARE_EMAIL.test(bracketed[1])) return bracketed[1];
  const found = cleaned.match(
    /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/
  );
  return found ? found[0] : cleaned;
}

function displayNameForResend(name) {
  const cleaned = stripInvisible(name)
    .replace(/<[^>]*>/g, " ")
    .replace(/[^\p{L}\p{N} .'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.includes("@")) return "";
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u.test(cleaned)) return "";
  return cleaned;
}

function formatResendAddress(name, email) {
  const address = extractEmail(email);
  if (!BARE_EMAIL.test(address)) return "";
  const display = displayNameForResend(name);
  return display ? `${display} <${address}>` : address;
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
  const env = { ...loadEnv(ENV_FILE), ...process.env };
  const args = new Set(process.argv.slice(2));
  const supportedArgs = new Set(["--dry-run", "--verify"]);
  for (const arg of args) {
    if (!supportedArgs.has(arg)) {
      fail(`Unknown option "${arg}". Use --dry-run or --verify.`);
    }
  }

  const deliveryMethod = (env.DELIVERY_METHOD || "smtp").toLowerCase();
  if (!["smtp", "resend"].includes(deliveryMethod)) {
    fail('DELIVERY_METHOD must be either "smtp" or "resend".');
  }

  const requiredKeys =
    deliveryMethod === "smtp"
      ? ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "FROM_EMAIL"]
      : ["RESEND_API_KEY", "FROM_EMAIL"];
  for (const key of requiredKeys) {
    if (!env[key]) fail(`${key} is not set in .env`);
  }

  const isHtml = (env.CONTENT_FORMAT || "text").toLowerCase() === "html";
  const nameSource = (env.NAME_SOURCE || "email").toLowerCase();
  const delayMs = Number(env.DELAY_MS || 0);
  const dryRun = args.has("--dry-run") || bool(env.DRY_RUN, false);
  const verifyOnly = args.has("--verify");

  if (!["email", "column"].includes(nameSource)) {
    fail('NAME_SOURCE must be either "email" or "column".');
  }
  if (
    deliveryMethod === "smtp" &&
    (!Number.isInteger(Number(env.SMTP_PORT)) || Number(env.SMTP_PORT) < 1)
  ) {
    fail("SMTP_PORT must be a valid port number.");
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    fail("DELAY_MS must be zero or a positive number.");
  }

  const recipients = loadRecipients(EMAILS_FILE, nameSource);
  const { subject, body } = loadContent(CONTENT_FILE);

  if (recipients.length === 0) fail("No valid recipients found in emails.txt");

  const fromAddress = extractEmail(env.FROM_EMAIL);
  if (!BARE_EMAIL.test(fromAddress)) {
    fail(
      "FROM_EMAIL must be an address like sender@yourdomain.com. Resend only accepts email@example.com or Name <email@example.com>."
    );
  }
  const fromName = displayNameForResend(env.FROM_NAME);
  if (stripInvisible(env.FROM_NAME) && !fromName) {
    console.warn(
      "  ! FROM_NAME was left off the sender. Resend rejects that name, so the email is sent from the address only."
    );
  }
  const from = fromName
    ? { name: fromName, address: fromAddress }
    : fromAddress;
  const fromLabel = formatResendAddress(fromName, fromAddress);

  console.log("=================================================");
  console.log(` Provider  : ${deliveryMethod === "smtp" ? "SMTP" : "Resend API"}`);
  if (deliveryMethod === "smtp") {
    console.log(` SMTP      : ${env.SMTP_HOST}:${env.SMTP_PORT}`);
  }
  console.log(` From      : ${fromLabel}`);
  console.log(` Subject   : ${subject}`);
  console.log(` Format    : ${isHtml ? "html" : "text"}`);
  console.log(` Names     : ${nameSource === "email" ? "from email address" : "from name column"}`);
  console.log(` Recipients: ${recipients.length}`);
  console.log(` Dry run   : ${dryRun ? "YES (nothing will be sent)" : "no"}`);
  console.log("=================================================\n");

  let transporter;
  let resend;

  if (deliveryMethod === "smtp") {
    const transportOptions = {
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT),
      secure: bool(env.SMTP_SECURE, Number(env.SMTP_PORT) === 465),
      requireTLS: bool(env.SMTP_REQUIRE_TLS, Number(env.SMTP_PORT) === 587),
      tls: {
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
      },
      connectionTimeout: Number(env.SMTP_CONNECTION_TIMEOUT_MS || 15000),
      greetingTimeout: Number(env.SMTP_GREETING_TIMEOUT_MS || 10000),
      socketTimeout: Number(env.SMTP_SOCKET_TIMEOUT_MS || 30000),
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      ...(env.SOCKS_PROXY ? { proxy: env.SOCKS_PROXY } : {}),
    };

    transporter = nodemailer.createTransport(transportOptions);
    if (env.SOCKS_PROXY) {
      transporter.set("proxy_socks_module", require("socks"));
    }

    if (!dryRun || verifyOnly) {
      try {
        await transporter.verify();
        console.log("SMTP connection OK.\n");
      } catch (err) {
        fail(`Could not connect to SMTP server: ${err.message}`);
      }
    }
  } else {
    resend = new Resend(env.RESEND_API_KEY);
  }

  if (verifyOnly) {
    if (deliveryMethod === "smtp") {
      console.log("SMTP settings verified. No email was sent.");
      transporter.close();
    } else {
      console.log("Resend configuration is present. No email was sent.");
      console.log("A Resend API key can only be fully tested by sending an email.");
    }
    return;
  }

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < recipients.length; i++) {
    const { email, name } = recipients[i];
    const vars = { name, email };
    const label = `[${i + 1}/${recipients.length}] ${email}`;

    const personalizedSubject = fill(subject, vars);
    const personalizedBody = fill(body, vars);
    const smtpMessage = {
      from,
      to: name !== email ? { name, address: email } : email,
      subject: personalizedSubject,
      ...(env.REPLY_TO ? { replyTo: env.REPLY_TO } : {}),
      ...(isHtml ? { html: personalizedBody } : { text: personalizedBody }),
    };
    const resendTo = formatResendAddress(name !== email ? name : "", email);
    const resendMessage = {
      from: fromLabel,
      to: resendTo || email,
      subject: personalizedSubject,
      ...(env.REPLY_TO ? { replyTo: env.REPLY_TO } : {}),
      ...(isHtml ? { html: personalizedBody } : { text: personalizedBody }),
    };

    if (dryRun) {
      console.log(`${label}  (dry run)`);
      sent++;
    } else {
      try {
        if (deliveryMethod === "smtp") {
          await transporter.sendMail(smtpMessage);
        } else {
          const { error } = await resend.emails.send(resendMessage);
          if (error) throw new Error(error.message || JSON.stringify(error));
        }
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

  if (transporter) transporter.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => fail(err.message));
