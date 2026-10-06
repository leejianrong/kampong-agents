// kampong/gmail: sends a plain-text message through the Gmail API.
//
// A module rather than a manifest because the API wants the whole message as base64url MIME, which a
// request template cannot build. It sees only `ctx`: the token comes from the declared slot and the
// only host it can reach is gmail.googleapis.com.

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

export async function invoke(op, input, ctx) {
  if (op === "get_profile") return getProfile(ctx);
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
    throw new Error(describeFailure(response.status, text));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Gmail returned a response that is not JSON");
  }
}

async function getProfile(ctx) {
  const response = await ctx.fetch(PROFILE_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${ctx.secrets.get("token")}` },
    signal: ctx.signal,
  });
  const text = await response.text();
  if (!response.ok) {
    // `status` lets `kampong doctor` tell a refused token (401, 403) from a service that is down.
    throw Object.assign(new Error(describeFailure(response.status, text)), {
      status: response.status,
    });
  }
  try {
    const { emailAddress } = JSON.parse(text);
    return { emailAddress };
  } catch {
    throw new Error("Gmail returned a response that is not JSON");
  }
}

// Google answers errors as { "error": { "status": "PERMISSION_DENIED", "message": "..." } }; say which,
// so a missing scope is not just "HTTP 403". The runner scrubs any secret from the message.
function describeFailure(status, text) {
  let detail = "";
  try {
    const error = JSON.parse(text).error;
    const parts = [error?.status, error?.message].filter((part) => typeof part === "string");
    detail = parts.join(": ").slice(0, 300);
  } catch {
    // Not JSON: report the status alone.
  }
  return detail ? `Gmail returned HTTP ${status} (${detail})` : `Gmail returned HTTP ${status}`;
}
