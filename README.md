# Email sender

## Setup

1. Put the delivery settings in `.env`.
2. Choose how recipient names are found with `NAME_SOURCE` in `.env`:
   - `NAME_SOURCE=email` takes the name from the part before `@`. For example,
     `adam@gmail.com` becomes `adam`.
   - `NAME_SOURCE=column` takes the name from the comma-separated column beside
     the email. Each line must use the format `person@example.com,Person Name`.
3. Put the subject and body in `content.txt`.
   Use `{{name}}` wherever the recipient's name should appear, for example
   `Hei {{name}},`. You can also use `{{email}}`.

### SMTP

Set `DELIVERY_METHOD=smtp` and fill in the `SMTP_*` settings.

### Resend API

1. Create an API key at https://resend.com/api-keys.
2. Verify your sending domain at https://resend.com/domains.
3. Set `DELIVERY_METHOD=resend`.
4. Set `RESEND_API_KEY` and use an address on the verified domain as
   `FROM_EMAIL`.

## Commands

- `npm run dry-run` validates and previews the send without connecting.
- `npm run verify` checks SMTP connectivity, or validates that Resend settings
  are present, without sending email.
- `npm run send` sends the email to every valid address in `emails.txt`.

For Optimum, use `mail.optimum.net`, port `465`, SSL enabled, and the Optimum
ID (the part before `@`) as `SMTP_USER`.

Keep `.env` private because it contains the SMTP password or Resend API key.
