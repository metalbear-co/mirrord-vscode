import * as vscode from 'vscode';
import { MirrordAPI } from './api';
import { getMirrordBinary } from './binaryManager';
import { approvalUrl, cliErrorText, loginSummary, OperatorLogin, Whoami } from './cliOutput';
import { globalContext } from './extension';
import { NotificationBuilder } from './notification';
import Logger from './logger';

/**
 * Key of the last URL logged in to from the IDE, offered in the next Log in prompt.
 */
const LAST_LOGIN_URL = 'mirrord-last-login-url';

/**
 * Name of the task `mirrord login` starts, and finishes with its final message.
 */
const LOGIN_TASK = 'mirrord login';

export const loginCommandId = 'mirrord.login';
export const logoutCommandId = 'mirrord.logout';
export const whoamiCommandId = 'mirrord.whoami';

/**
 * Upper bound for scheduling a redraw at the end of the login in use: logins last 24 hours, and a
 * longer timer would only be cleared by the next refresh anyway.
 */
const MAX_EXPIRY_REDRAW_MS = 25 * 60 * 60 * 1000;

/**
 * The logins last read, `undefined` until a session or a login command has run.
 */
let lastWhoami: Whoami | undefined;

/**
 * The CLI the last session or login command used. Background refreshes reuse it instead of
 * resolving the binary again, which shows a notification and may check for updates.
 */
let lastCliPath: string | undefined;

let expiryRedraw: NodeJS.Timeout | undefined;
const summaryChanged = new vscode.EventEmitter<void>();

/**
 * Fires when the line about the operator login in use changes.
 */
export const onLoginSummaryChange = summaryChanged.event;

/**
 * One line about the operator login in use, computed now, so it says "expired" once the login
 * ended; `undefined` when there are no operator logins or none were read yet.
 */
export function currentLoginSummary(): string | undefined {
  return lastWhoami === undefined ? undefined : loginSummary(lastWhoami, new Date());
}

/**
 * Keeps the logins just read, and redraws the status bar now and again when the login in use ends.
 */
function setWhoami(whoami: Whoami): void {
  lastWhoami = whoami;
  clearTimeout(expiryRedraw);
  const active = whoami.operators.find(login => login.active);
  const untilExpiry = active === undefined ? NaN : new Date(active.expiresAt).getTime() - Date.now();
  if (untilExpiry > 0 && untilExpiry < MAX_EXPIRY_REDRAW_MS) {
    expiryRedraw = setTimeout(() => summaryChanged.fire(), untilExpiry + 1000);
  }
  summaryChanged.fire();
}

/**
 * The CLI for a command the user started, shown as an error when there is none.
 */
async function mirrordApi(): Promise<MirrordAPI | undefined> {
  const cliPath = await getMirrordBinary(false);
  if (!cliPath) {
    new NotificationBuilder()
      .withMessage("Couldn't download mirrord binaries or find local one in path")
      .error();
    return undefined;
  }
  lastCliPath = cliPath;
  return new MirrordAPI(cliPath);
}

/**
 * Reads the logins again with `cliPath`, or with the CLI used last, and updates the status bar
 * line. Shows nothing: it runs after sessions, when the user did not ask for it.
 */
export async function refreshLogins(cliPath?: string): Promise<void> {
  lastCliPath = cliPath ?? lastCliPath;
  if (lastCliPath === undefined) {
    return;
  }
  try {
    const result = await new MirrordAPI(lastCliPath).whoami();
    if ('whoami' in result) {
      setWhoami(result.whoami);
    }
  } catch (err) {
    Logger.info(`could not read the mirrord logins: ${err}`);
  }
}

/**
 * Shows the CLI's expired-login message with a Log in action for `url`, or for the login
 * `mirrord whoami` names as active when `url` is not given. `cliPath` is the CLI that failed.
 */
export async function showLoginExpired(message: string, url: string | undefined, cliPath: string): Promise<void> {
  lastCliPath = cliPath;
  let loginUrl = url;
  if (loginUrl === undefined) {
    try {
      const result = await new MirrordAPI(cliPath).whoami();
      if ('whoami' in result) {
        setWhoami(result.whoami);
        loginUrl = result.whoami.activeOperator ?? undefined;
      }
    } catch (err) {
      Logger.info(`could not find the expired login: ${err}`);
    }
  }

  const notification = new NotificationBuilder().withMessage(message);
  if (loginUrl !== undefined) {
    const target = loginUrl;
    notification.withGenericAction("Log in", async () => login(target));
  }
  await notification.error();
  if (url !== undefined) {
    await refreshLogins();
  }
}

/**
 * Asks for the operator URL, offering the last one used.
 */
async function askForUrl(): Promise<string | undefined> {
  return await vscode.window.showInputBox({
    title: 'Log in to a mirrord operator',
    prompt: 'The operator URL your admin gave you. mirrord opens your browser to sign in.',
    placeHolder: 'https://mirrord.example.com',
    value: globalContext.globalState.get<string>(LAST_LOGIN_URL),
    ignoreFocusOut: true,
    // The CLI checks the rest (HTTPS, that it is an operator) before any browser opens.
    validateInput: value => {
      try {
        const url = new URL(value.trim());
        return url.protocol === 'https:' || url.protocol === 'http:'
          ? undefined
          : 'Enter the URL with https://, for example https://mirrord.example.com';
      } catch {
        return 'Enter the URL with https://, for example https://mirrord.example.com';
      }
    },
  });
}

/**
 * Runs `mirrord login --url`. Without `url`, asks for it first. The CLI opens the browser itself;
 * the notification also offers the page, for when the browser did not open.
 */
export async function login(url?: string): Promise<void> {
  const loginUrl = (url ?? await askForUrl())?.trim();
  if (!loginUrl) {
    return;
  }
  const api = await mirrordApi();
  if (api === undefined) {
    return;
  }
  await globalContext.globalState.update(LAST_LOGIN_URL, loginUrl);

  let finalMessage: string | undefined;
  const output = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `mirrord: logging in to ${loginUrl}`,
    cancellable: true,
  }, (progress, token) => api.login(loginUrl, message => {
    if (message.type === 'NewTask' && typeof message.name === 'string') {
      const page = approvalUrl(message.name);
      if (page !== undefined) {
        progress.report({ message: 'approve the login in your browser' });
        new NotificationBuilder()
          .withMessage('Approve the mirrord login in your browser.')
          .withGenericAction('Open login page', async () => vscode.env.openExternal(vscode.Uri.parse(page, true)))
          .info();
      }
    } else if (message.type === 'FinishedTask' && message.name === LOGIN_TASK
      && message.success === true && typeof message.message === 'string') {
      finalMessage = message.message;
    }
  }, token));

  if (output.code === 0) {
    new NotificationBuilder()
      .withMessage(finalMessage ?? `Logged in to ${loginUrl}.`)
      .info();
  } else if (output.code !== null) {
    new NotificationBuilder()
      .withMessage(`mirrord login failed: ${cliErrorText(output.stderr)}`)
      .error();
  }
  await refreshLogins();
}

/**
 * Reads the logins for a command the user started, telling them when the CLI cannot list them.
 */
async function whoamiForUser(api: MirrordAPI): Promise<Whoami | undefined> {
  const result = await api.whoami();
  if ('failure' in result) {
    new NotificationBuilder().withMessage(result.failure).error();
    return undefined;
  }
  setWhoami(result.whoami);
  return result.whoami;
}

function loginItem(operator: OperatorLogin): vscode.QuickPickItem & { url: string } {
  return {
    label: operator.active ? `$(pass-filled) ${operator.host}` : operator.host,
    description: operator.account,
    detail: operator.expiresIn === 'expired' ? 'expired' : `expires ${operator.expiresIn}`,
    url: operator.url,
  };
}

/**
 * Picks an operator login and runs `mirrord logout --url` for it.
 */
async function logout(): Promise<void> {
  const api = await mirrordApi();
  if (api === undefined) {
    return;
  }
  const whoami = await whoamiForUser(api);
  if (whoami === undefined) {
    return;
  }
  if (whoami.operators.length === 0) {
    new NotificationBuilder().withMessage('You are not logged in to any mirrord operator.').info();
    return;
  }

  const picked = await vscode.window.showQuickPick(whoami.operators.map(loginItem), {
    title: 'Log out of a mirrord operator',
  });
  if (picked === undefined) {
    return;
  }

  const output = await api.logout(picked.url);
  if (output.code === 0) {
    new NotificationBuilder().withMessage(output.stdout.trim()).info();
  } else {
    new NotificationBuilder().withMessage(`mirrord logout failed: ${cliErrorText(output.stderr)}`).error();
  }
  await refreshLogins();
}

/**
 * Shows what `mirrord whoami` shows. Picking a login logs in to it, which switches to it while it is
 * valid and opens the browser when it expired; the last item logs in to another operator.
 */
async function whoami(): Promise<void> {
  const api = await mirrordApi();
  if (api === undefined) {
    return;
  }
  const whoami = await whoamiForUser(api);
  if (whoami === undefined) {
    return;
  }

  const fallback = whoami.kubeContext === null
    ? 'No kubeconfig was found.'
    : `Without an operator login, mirrord uses your kubeconfig context ${whoami.kubeContext}.`;
  const cloud = whoami.cloud === null
    ? 'mirrord Cloud: not logged in'
    : `mirrord Cloud: ${whoami.cloud.email}, ${whoami.cloud.expiresIn === 'expired' ? 'expired' : `expires ${whoami.cloud.expiresIn}`}`;
  const anotherOperator = { label: '$(sign-in) Log in to another operator...', detail: `${fallback} ${cloud}` };

  const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { url?: string }>(
    [...whoami.operators.map(loginItem), anotherOperator],
    { title: loginSummary(whoami, new Date()) ?? 'No operator logins', placeHolder: 'Pick a login to use it, or log in again when it expired' },
  );
  if (picked === undefined) {
    return;
  }
  await login(picked.url);
}

/**
 * Registers the Log in, Log out and Who am I commands. The logins are read the first time a session
 * or one of these commands runs, so starting the IDE resolves no binary for them.
 */
export function registerLoginCommands(): void {
  globalContext.subscriptions.push(
    vscode.commands.registerCommand(loginCommandId, async () => login()),
    vscode.commands.registerCommand(logoutCommandId, logout),
    vscode.commands.registerCommand(whoamiCommandId, whoami),
    summaryChanged,
    { dispose: () => clearTimeout(expiryRedraw) },
  );
}
