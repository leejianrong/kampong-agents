// Which credential a run or check message says is missing (KAM-192), so the canvas can offer to set it in the
// Secrets panel instead of telling the author to go and edit their shell or a .env file. The engine and doctor
// word it a few ways; all of them name the environment variable and say it is "not set".

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const LEADING = new RegExp(`^(${NAME}) is not set\\b`);
const MENTIONED = new RegExp(`[Ee]nvironment variable "?(${NAME})"?`, "g");

/** The environment variable names a message says are not set, each once, in order. */
export function missingSecretNames(message: string | undefined): string[] {
  if (!message || !message.includes("not set")) return [];
  const names: string[] = [];
  const lead = LEADING.exec(message);
  if (lead?.[1]) names.push(lead[1]);
  for (const match of message.matchAll(MENTIONED)) if (match[1]) names.push(match[1]);
  return [...new Set(names)];
}

/** The names across several messages, each once. */
export function missingSecretNamesIn(messages: (string | undefined)[]): string[] {
  return [...new Set(messages.flatMap((m) => missingSecretNames(m)))];
}
