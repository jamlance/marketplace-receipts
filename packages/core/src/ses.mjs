// Shared SES email sender. Reuses the same verified `bookerva.com` SES domain
// + IAM creds the Bookerva app uses. Env:
//   AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
//   SES_FROM  (default "Bookerva <noreply@bookerva.com>")
//
//   import { sendEmail, sesConfigured } from "@inkress/apps-core/ses";
//   await sendEmail({ to, subject, html, text, replyTo });
//
// Fails closed with a clear error when creds are absent, so an app that
// advertises "we'll email the link" never silently no-ops.

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

let client = null;

export function sesConfigured() {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY,
  );
}

function getClient() {
  if (!sesConfigured()) {
    throw new Error("SES is not configured (missing AWS credentials).");
  }
  if (!client) {
    client = new SESClient({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

export function defaultFrom() {
  return process.env.SES_FROM || "Bookerva <noreply@bookerva.com>";
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Send an email via SES.
 * @param {{to:string|string[], subject:string, html?:string, text?:string,
 *   from?:string, replyTo?:string|string[]}} msg
 * @returns {Promise<{messageId:string}>}
 */
export async function sendEmail(msg) {
  const to = Array.isArray(msg.to) ? msg.to : [msg.to];
  if (!to.length || !to[0]) throw new Error("sendEmail: no recipient.");
  if (!msg.subject) throw new Error("sendEmail: no subject.");

  const Body = {};
  if (msg.html) Body.Html = { Data: msg.html, Charset: "UTF-8" };
  Body.Text = { Data: msg.text || stripHtml(msg.html), Charset: "UTF-8" };

  const cmd = new SendEmailCommand({
    Source: msg.from || defaultFrom(),
    Destination: { ToAddresses: to },
    Message: {
      Subject: { Data: msg.subject, Charset: "UTF-8" },
      Body,
    },
    ...(msg.replyTo
      ? { ReplyToAddresses: Array.isArray(msg.replyTo) ? msg.replyTo : [msg.replyTo] }
      : {}),
  });

  const out = await getClient().send(cmd);
  return { messageId: out.MessageId };
}
