/**
 * Parsing of what the mirrord CLI prints for the login commands and its errors.
 *
 * Kept free of the `vscode` module so the unit tests run under plain mocha.
 */

/**
 * The `code` the CLI puts on the error of an expired operator login.
 */
export const LOGIN_EXPIRED_CODE = "mirrord::login_expired";

/**
 * The final error of `mirrord ls`, `mirrord ext` and `mirrord container-ext`, which the CLI prints
 * on stderr as `Error: {json}`.
 */
export interface CliError {
  message: string;
  help?: string;
  code?: string;
}

/**
 * Finds the CLI's JSON error in `stderr`, `undefined` when there is none. Only the JSON line counts:
 * other output that happens to start with `Error:` (a log line, a quoted error) is not the CLI's
 * final error, so the exit code decides those runs.
 */
export function parseCliError(stderr: string): CliError | undefined {
  for (const match of stderr.matchAll(/Error: (.*)/g)) {
    try {
      const parsed = JSON.parse(match[1] ?? "");
      if (typeof parsed?.message === "string") {
        return {
          message: parsed.message,
          help: typeof parsed.help === "string" ? parsed.help : undefined,
          code: typeof parsed.code === "string" ? parsed.code : undefined,
        };
      }
    } catch {
      // Not the JSON error; keep looking.
    }
  }
  return undefined;
}

/**
 * One operator login in `mirrord whoami -o json`.
 */
export interface OperatorLogin {
  /** What `mirrord login --url` and `mirrord logout --url` take. */
  url: string;
  host: string;
  account: string;
  expiresAt: string;
  /** `in 6 hours`, or `expired`. */
  expiresIn: string;
  active: boolean;
}

/**
 * `mirrord whoami -o json`.
 */
export interface Whoami {
  /** Active login first, then the others from the most recent login to the oldest. */
  operators: OperatorLogin[];
  /** URL of the login mirrord uses, kept when that login expired. `null` with the kubeconfig. */
  activeOperator: string | null;
  kubeContext: string | null;
  cloud: { email: string, expiresAt: string, expiresIn: string } | null;
}

/**
 * Parses `mirrord whoami -o json`, `undefined` when the output is not that JSON: a CLI older than
 * the `-o json` flag prints its usage error instead.
 */
export function parseWhoami(stdout: string): Whoami | undefined {
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed?.operators)) {
      return undefined;
    }
    return parsed as Whoami;
  } catch {
    return undefined;
  }
}

/**
 * How the status line names the end of a login: the day and the time, in the user's locale, so the
 * line stays true however long it is shown.
 */
export function defaultFormatTime(time: Date): string {
  return time.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * One line about the operator login in use at `now`, what the status bar tooltip shows; `undefined`
 * when there are no operator logins at all, so users who never log in see nothing new.
 */
export function loginSummary(whoami: Whoami, now: Date, formatTime: (time: Date) => string = defaultFormatTime): string | undefined {
  if (whoami.operators.length === 0) {
    return undefined;
  }

  const active = whoami.operators.find(login => login.active);
  if (active === undefined) {
    const fallback = whoami.kubeContext === null
      ? "no kubeconfig was found"
      : `mirrord uses your kubeconfig context ${whoami.kubeContext}`;
    return `No operator login in use, ${fallback}`;
  }

  const expiresAt = new Date(active.expiresAt);
  if (expiresAt <= now) {
    return `Your login to ${active.host} expired`;
  }

  return `Logged in to ${active.host} as ${active.account}, until ${formatTime(expiresAt)}`;
}

/**
 * Shown when the CLI is older than `mirrord whoami -o json`.
 */
export const TOO_OLD_CLI = 'The installed mirrord CLI is too old to list logins. Update mirrord to the latest release, '
  + 'or remove the version pin in the `mirrord.autoUpdate` setting.';

/**
 * What to tell the user when `mirrord whoami -o json` fails: a CLI older than `-o json` rejects the
 * flag, anything else is the CLI's own error.
 */
export function whoamiFailure(stderr: string): string {
  if (stderr.includes("unexpected argument '-o'")) {
    return TOO_OLD_CLI;
  }
  return `mirrord whoami failed: ${cliErrorText(stderr)}`;
}

/**
 * The text of a failed `mirrord login`, `logout` or `whoami`, which print their error for a person
 * on stderr (`Error:   × <message>` and a `help:` line), as one line for a notification.
 */
export function cliErrorText(stderr: string): string {
  return stderr
    // Terminal colors, in case the CLI decides to print them.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map(line => line.replace(/^\s*Error:\s*/, "").replace(/^\s*×\s+/, "").trim())
    .filter(line => line.length > 0)
    .join(" ");
}

/**
 * The page to open in the browser, taken from the name of the task `mirrord login` starts while it
 * waits for the browser: `Approve the login in your browser. If it does not open, visit:\n\n<url>\n`.
 */
export function approvalUrl(taskName: string): string | undefined {
  return taskName.match(/visit:\s+(\S+)/)?.[1];
}
