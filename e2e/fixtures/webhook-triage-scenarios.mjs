// The two sample alerts behind the webhook-triage template (KAM-217), shaped like an Alertmanager webhook body.
// Shared by the fixture recorder, the integration test and the e2e test so they cannot drift apart.

/** A critical, user-facing alert: the model decides to post, so the run pauses for approval. */
export const CRITICAL = {
  status: "firing",
  groupLabels: { alertname: "CheckoutErrorRate" },
  alerts: [
    {
      status: "firing",
      labels: { alertname: "CheckoutErrorRate", severity: "critical", service: "checkout" },
      annotations: { summary: "Checkout is failing 38% of payments since 09:14 UTC." },
    },
  ],
};

/** A flapping, non-urgent warning: the model decides to skip, so nothing is posted. */
export const NOISY = {
  status: "firing",
  groupLabels: { alertname: "DiskUsageHigh" },
  alerts: [
    {
      status: "firing",
      labels: { alertname: "DiskUsageHigh", severity: "warning", service: "batch-runner" },
      annotations: { summary: "Disk usage is 78% and has been flapping around 75% all week." },
    },
  ],
};

/** What the stand-in model answers for each sample alert, and so what the recorded fixtures hold. */
export const DECISIONS = {
  CheckoutErrorRate: {
    decision: "post",
    severity: "critical",
    reason: "Customers cannot pay: a user-facing outage on checkout.",
    message:
      "Checkout is failing 38% of payments since 09:14 UTC. First check the latest deploy and the payment provider status page.",
  },
  DiskUsageHigh: {
    decision: "skip",
    severity: "warning",
    reason: "A flapping disk warning on a batch runner that clears on its own.",
    message: "",
  },
};
