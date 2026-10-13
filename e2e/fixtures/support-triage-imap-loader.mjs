// A module-loader hook: `import "imapflow"` resolves to the offline fake (support-triage-fake-imapflow.mjs).
const FAKE = new URL("./support-triage-fake-imapflow.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "imapflow") return { url: FAKE, shortCircuit: true };
  return nextResolve(specifier, context);
}
