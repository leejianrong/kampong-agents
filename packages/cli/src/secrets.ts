import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// The canvas's Variables panel: set a credential once, by name, and have runs and checks use it, the way a
// CI settings page does. Write-only by design -- nothing here, and no route, ever returns a value; a caller
// learns only a name, whether it is set, and where it comes from. A spec still holds `${NAME}` and nothing else.
//
// Values are kept in `<.kampong>/secrets.env`, mode 0600, next to the layout sidecar, with a `.gitignore`
// beside it so `git add .` in a project cannot pick it up. The server applies them to its own environment
// (which runs, doctor and components already read), so a change takes effect with no restart.

export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE_CHARS = 16_384;

export type SecretSource = "saved" | "environment" | "unset";

export interface SecretStatus {
  name: string;
  source: SecretSource;
  /** True when the open spec reads this name through `${NAME}`. */
  referenced: boolean;
}

export class SecretStore {
  private readonly file: string;
  // What the environment held before a saved value overrode it, so deleting restores it.
  private readonly shadowed = new Map<string, string | undefined>();
  private saved = new Set<string>();

  constructor(
    dir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.file = join(dir, "secrets.env");
  }

  /** Reads the file (if any) and applies it to the environment. Call once at start-up. */
  async load(): Promise<void> {
    const values = await this.read();
    for (const [name, value] of Object.entries(values)) this.apply(name, value);
  }

  list(referenced: Iterable<string>): SecretStatus[] {
    const wanted = new Set(referenced);
    const names = new Set([...wanted, ...this.saved]);
    return [...names].sort().map((name) => ({
      name,
      referenced: wanted.has(name),
      source: this.saved.has(name)
        ? "saved"
        : this.env[name] !== undefined && this.env[name] !== ""
          ? "environment"
          : "unset",
    }));
  }

  async set(name: string, value: string): Promise<void> {
    const values = await this.read();
    values[name] = value;
    await this.write(values);
    this.apply(name, value);
  }

  /** Removes a saved value; the variable falls back to whatever the environment held. */
  async remove(name: string): Promise<boolean> {
    const values = await this.read();
    if (!(name in values)) return false;
    delete values[name];
    await this.write(values);
    this.saved.delete(name);
    const original = this.shadowed.get(name);
    this.shadowed.delete(name);
    if (original === undefined) delete this.env[name];
    else this.env[name] = original;
    return true;
  }

  private apply(name: string, value: string): void {
    if (!this.shadowed.has(name)) this.shadowed.set(name, this.env[name]);
    this.env[name] = value;
    this.saved.add(name);
  }

  // One `NAME=<JSON string>` per line: a value with a space, quote or newline survives, and nothing reads
  // the file as shell code.
  private async read(): Promise<Record<string, string>> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    const values: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const at = line.indexOf("=");
      if (at < 1) continue;
      const name = line.slice(0, at);
      if (!SECRET_NAME.test(name)) continue;
      try {
        const value: unknown = JSON.parse(line.slice(at + 1));
        if (typeof value === "string") values[name] = value;
      } catch {
        // a hand-edited line that is not valid is skipped, not fatal
      }
    }
    return values;
  }

  private async write(values: Record<string, string>): Promise<void> {
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true });
    // Never overwrites a .gitignore the author already keeps here.
    await writeFile(join(dir, ".gitignore"), "secrets.env\n", { flag: "wx" }).catch(() => {});
    const body = Object.entries(values)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}\n`)
      .join("");
    const temp = `${this.file}.tmp`;
    await writeFile(temp, body, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.file);
  }
}

export function validateSecret(
  name: string,
  value: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (!SECRET_NAME.test(name)) {
    return {
      ok: false,
      error: "A name is letters, digits and underscores, and starts with a letter or _.",
    };
  }
  if (typeof value !== "string" || value === "") {
    return { ok: false, error: "A value is required." };
  }
  if (value.length > MAX_VALUE_CHARS) {
    return { ok: false, error: `A value can be at most ${MAX_VALUE_CHARS} characters.` };
  }
  return { ok: true, value };
}
