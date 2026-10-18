import { createContext, useContext } from "react";
import type { PatchOp } from "@kampong/spec";

// What the version notice needs to offer an upgrade (KAM-199) without every panel passing it down: the spec's text
// (to preview the change) and a way to apply a patch. Only the local app provides it. The hosted server does not
// run a 1.1 spec yet and refuses one by name, so there the notice has no Upgrade action.
export interface UpgradeContextValue {
  source: string;
  apply: (ops: PatchOp[]) => Promise<boolean>;
}

export const UpgradeContext = createContext<UpgradeContextValue | null>(null);

export const useUpgrade = () => useContext(UpgradeContext);
