// Shared AWS SNS SMS sender. Reuses the same IAM creds as ses.mjs.
// Env: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
//      SMS_SENDER_ID (optional; alphanumeric sender id where supported)
//
//   import { sendSms, snsConfigured } from "@inkress/apps-core/sns";
//   await sendSms({ to: "+18765550133", message: "..." });
//
// Fails closed with a clear error when creds are absent, so an app that
// advertises SMS never silently no-ops.

import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

let client = null;

export function snsConfigured() {
  return Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

function getClient() {
  if (!snsConfigured()) throw new Error("SMS is not configured (missing AWS credentials).");
  if (!client) {
    client = new SNSClient({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

// Best-effort E.164 normaliser. Jamaica/NANP default when a bare 10-digit or
// 7-digit local number is given; otherwise respects a leading +.
export function toE164(raw, defaultCountry = "1") {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("+")) return "+" + s.slice(1).replace(/\D/g, "");
  s = s.replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return `+${defaultCountry}${s}`;       // NANP 10-digit
  if (s.length === 11 && s.startsWith("1")) return `+${s}`;   // 1XXXXXXXXXX
  return `+${s}`;
}

/**
 * Send an SMS via SNS.
 * @param {{to:string, message:string, senderId?:string, transactional?:boolean}} msg
 * @returns {Promise<{messageId:string, to:string}>}
 */
export async function sendSms(msg) {
  const to = toE164(msg.to);
  if (!to) throw new Error("sendSms: no/invalid phone number.");
  if (!msg.message) throw new Error("sendSms: empty message.");

  const attrs = {
    "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: msg.transactional === false ? "Promotional" : "Transactional" },
  };
  const senderId = msg.senderId || process.env.SMS_SENDER_ID;
  if (senderId) attrs["AWS.SNS.SMS.SenderID"] = { DataType: "String", StringValue: String(senderId).slice(0, 11) };

  const out = await getClient().send(new PublishCommand({
    PhoneNumber: to,
    Message: String(msg.message).slice(0, 1500),
    MessageAttributes: attrs,
  }));
  return { messageId: out.MessageId, to };
}
