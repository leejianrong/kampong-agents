// The notice a panel shows on a version "1.0" spec for what only "1.1" has (KAM-198). One component so the three
// panels say it the same way. The banner is a flex row, so the sentence must be one child: inline `<code>` runs
// directly inside it each became a column and the text ran off the card.

export interface VersionGateProps {
  /** What needs 1.1, as the start of the sentence: "Vars", "Per-step settings and an output schema". */
  what: string;
}

export function VersionGate({ what }: VersionGateProps) {
  return (
    <div role="status" className="md3-banner md3-banner--info">
      <p className="md3-banner__text">
        {what} need spec version <code>"1.1"</code>. Change <code>version</code> in the YAML when
        you are ready: 1.1 reads <code>{"{{ }}"}</code> references as expressions, which can change
        what an existing 1.0 spec means.
      </p>
    </div>
  );
}
