// kampong/gmail: sends a plain-text message through the Gmail API.
//
// A module rather than a manifest because the API wants the whole message as base64url MIME, which a
// request template cannot build. It sees only `ctx`: the token comes from the declared slot and the
// only host it can reach is gmail.googleapis.com.

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export async function invoke(op, input, ctx) {
  if (op !== "send") throw new Error(`kampong/gmail has no op "${op}"`);

  // The values land in MIME header lines; a line break would let a value add headers such as Bcc.
  for (const field of ["to", "subject"]) {
    if (/[\r\n]/.test(input[field])) {
      throw new Error(`${field} must not contain a line break`);
    }
  }

  const mime = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    input.body,
  ].join("\r\n");
  const raw = Buffer.from(mime, "utf8").toString("base64url");

  const token = ctx.secrets.get("token");
  const response = await ctx.fetch(SEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
    signal: ctx.signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Gmail returned HTTP ${response.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Gmail returned a response that is not JSON");
  }
}
