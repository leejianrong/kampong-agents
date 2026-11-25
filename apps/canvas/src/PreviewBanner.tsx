import { useEffect, useState } from "react";

// KAM-320: a notice the operator can pin to the top of the hosted app (a preview with no SLA, for now). The server
// reports it on /healthz when PREVIEW_NOTICE is set; nothing shows when it is not, or when the probe fails.
export function PreviewBanner({ baseUrl = "" }: { baseUrl?: string }) {
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.resolve()
      .then(() => fetch(`${baseUrl}/healthz`))
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { previewNotice?: unknown } | null) => {
        if (alive && typeof body?.previewNotice === "string" && body.previewNotice !== "") {
          setNotice(body.previewNotice);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [baseUrl]);

  if (!notice) return null;
  return (
    <div
      className="md3-banner md3-banner--warning md3-preview-banner"
      role="status"
      data-testid="preview-banner"
    >
      {notice}
    </div>
  );
}
