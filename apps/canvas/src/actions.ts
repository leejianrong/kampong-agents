// The canvas's verbs, described once (KAM-214). The run bar, the menu and the status bar render from this list,
// and the command palette (KAM-215) reads the same list, so a verb added here shows up everywhere it belongs and a
// surface never invents its own wording. Pure data plus closures: no React in here.

/** The panels that dock in the side pane. */
export type OpenForm =
  | "tool"
  | "workflow"
  | "guardrails"
  | "run"
  | "checks"
  | "variables"
  | "vars"
  | "trigger"
  | "steps"
  | "edit-tool"
  | "import"
  | "templates";

/** Where an action is drawn: the run bar, the status bar, or the menu (everything that is not frequent). */
export type ActionSurface = "run" | "runbar" | "yaml" | "status" | "menu";

export interface ActionDescriptor {
  id: string;
  /** The words on the control; the accessible name unless `ariaLabel` says more. */
  label: string;
  surface: ActionSurface;
  /** Longer accessible name, which must contain `label`. */
  ariaLabel?: string;
  title?: string;
  /** The command palette's wording for this verb when the label alone is not a command ("Open Secrets"). */
  commandLabel?: string;
  /** Words the command palette matches besides the label. */
  keywords?: string[];
  shortcut?: string;
  /** The panel or drawer this action opens is open now (drawn as pressed). */
  pressed?: boolean;
  /** The action cannot be taken now: its control is disabled and the command palette leaves it out. */
  disabled?: boolean;
  /** A small count beside the label, with the words a screen reader says for it. */
  badge?: { count: number; words: string };
  run: () => void;
}

export interface ActionContext {
  openForm: OpenForm | null;
  yamlOpen: boolean;
  /** The server can list secrets / run the checks (the hosted server cannot yet). */
  hasSecrets: boolean;
  hasChecks: boolean;
  /** The server has ready-made templates to start from (KAM-216); the hosted server has none yet. */
  hasTemplates?: boolean;
  /** No spec file yet: only the actions that need no spec are offered. */
  noSpecYet: boolean;
  /** Secrets the workflow reads that have no value; undefined until known. */
  missingSecrets?: number;
  /** Opens a panel, or closes it when it is already open. */
  toggleForm: (form: OpenForm) => void;
  toggleYaml: () => void;
  download: () => void;
  /** Starts a run (KAM-219), and whether one can start now; without it the Run bar's action is not offered. */
  startRun?: () => void;
  canRun?: boolean;
  /** Opens the command palette (KAM-215); without it the menu has no entry for it. */
  openPalette?: () => void;
  /** Plays the first-run marks again (KAM-220); without it the menu has no entry for it. */
  showTour?: () => void;
}

/** What the command palette calls an action. */
export function commandName(action: ActionDescriptor): string {
  return action.commandLabel ?? action.label;
}

export function buildActions(ctx: ActionContext): ActionDescriptor[] {
  const form = (
    id: string,
    target: OpenForm,
    surface: ActionSurface,
    label: string,
    extra: Partial<ActionDescriptor> = {},
  ): ActionDescriptor => ({
    id,
    label,
    surface,
    ...(surface === "status" && { commandLabel: `Open ${label}` }),
    pressed: ctx.openForm === target,
    run: () => ctx.toggleForm(target),
    ...extra,
  });

  const actions: ActionDescriptor[] = [
    // The top bar's button shows the details of a test run (input, vars, trace, output); Run itself is in the Run bar.
    form("run", "run", "run", "Test Run", {
      commandLabel: "Open Test Run",
      title: "Show the test run: input, vars, trace and output",
      keywords: ["details", "output", "trace", "input"],
    }),
    ...(ctx.startRun
      ? [
          {
            id: "run-now",
            label: "Run",
            surface: "runbar" as const,
            commandLabel: "Run the workflow",
            title: "Try the workflow with a test run",
            keywords: ["test", "execute", "try", "start", "replay"],
            disabled: ctx.canRun === false,
            run: ctx.startRun,
          },
        ]
      : []),
    {
      id: "yaml",
      label: "</>",
      ariaLabel: "For developers: show YAML",
      title: "For developers: show the spec as YAML (Alt+Y)",
      surface: "yaml",
      commandLabel: "Open code (YAML drawer)",
      shortcut: "Alt+Y",
      pressed: ctx.yamlOpen,
      keywords: ["yaml", "developers", "source"],
      run: ctx.toggleYaml,
    },
  ];

  if (!ctx.noSpecYet) {
    actions.push(
      form("vars", "vars", "status", "Vars", { keywords: ["variables", "spec vars"] }),
      ...(ctx.hasSecrets
        ? [
            form("secrets", "variables", "status", "Secrets", {
              keywords: ["keys", "tokens", "env"],
              ...(ctx.missingSecrets
                ? {
                    badge: {
                      count: ctx.missingSecrets,
                      words: `${ctx.missingSecrets} missing`,
                    },
                  }
                : {}),
            }),
          ]
        : []),
      form("guardrails", "guardrails", "status", "Guardrails", {
        keywords: ["limits", "approval", "safety"],
      }),
      ...(ctx.hasChecks
        ? [form("checks", "checks", "status", "Checks", { keywords: ["doctor", "validate"] })]
        : []),
      form("trigger", "trigger", "status", "Trigger", {
        keywords: ["schedule", "webhook", "poll"],
      }),
      form("add-step", "workflow", "menu", "Add step", {
        title: "Add a step by choosing its kind and place",
        keywords: ["workflow step", "new step"],
      }),
      form("add-tool", "tool", "menu", "Add tool", {
        keywords: ["http", "component", "connector"],
      }),
      form("edit-steps", "steps", "menu", "Edit steps", {
        title: "List, reorder, rename and delete steps and tools",
        keywords: ["reorder", "move", "rename", "delete", "tools", "list"],
      }),
    );
  } else {
    // Secrets and checks need no spec, so they stay while the workflow is being started.
    if (ctx.hasSecrets) actions.push(form("secrets", "variables", "status", "Secrets"));
    if (ctx.hasChecks) actions.push(form("checks", "checks", "status", "Checks"));
  }

  if (ctx.openPalette) {
    actions.push({
      id: "commands",
      label: "Search commands",
      surface: "menu",
      shortcut: "Ctrl+K",
      title: "Find any command or jump to a step (Ctrl+K)",
      keywords: ["palette", "command"],
      run: ctx.openPalette,
    });
  }

  if (ctx.showTour) {
    actions.push({
      id: "tour",
      label: "Show tour",
      surface: "menu",
      title: "Replay the three first-run tips",
      keywords: ["help", "onboarding", "intro", "tips", "guide"],
      run: ctx.showTour,
    });
  }

  if (ctx.hasTemplates) {
    actions.push(
      form("templates", "templates", "menu", "New from template", {
        title: "Start from a ready-made workflow",
        keywords: ["gallery", "example", "starter", "new"],
      }),
    );
  }

  actions.push(
    form("import", "import", "menu", "Import YAML", { keywords: ["upload", "file", "replace"] }),
    ...(ctx.noSpecYet
      ? []
      : [
          {
            id: "export",
            label: "Export YAML",
            surface: "menu" as const,
            keywords: ["download", "file", "save"],
            run: ctx.download,
          },
        ]),
  );
  return actions;
}
