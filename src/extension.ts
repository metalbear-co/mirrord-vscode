import * as vscode from 'vscode';
import { DebugProtocol } from '@vscode/debugprotocol';
import { ConfigurationProvider, PendingAttach, pendingAttaches } from './debugger';
import { MirrordStatus } from './status';
import { getMirrordBinary } from './binaryManager';
import { MirrordAPI } from './api';
import Logger from './logger';

export let globalContext: vscode.ExtensionContext;

// This method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	globalContext = context;

	Logger.init(context);

	const enabled = vscode.workspace.getConfiguration().get<boolean | null>("mirrord.enabledByDefault");
	context.workspaceState.update('enabled', enabled);
	vscode.debug.registerDebugConfigurationProvider('*', new ConfigurationProvider(), 2);

	// On Windows, register a DAP tracker to catch the process start event
	// and inject the mirrord layer via `mirrord attach <PID>`.
	if (process.platform === "win32") {
		Logger.info("Registering DAP tracker factory for Windows attach flow");
		vscode.debug.registerDebugAdapterTrackerFactory('*', {
			createDebugAdapterTracker(session: vscode.DebugSession) {
				if (pendingAttaches.length === 0) {
					return undefined;
				}

				Logger.debug(`Creating DAP tracker for session "${session.name}" (type=${session.type}), ${pendingAttaches.length} pending attach(es)`);

				// These are set when we consume a pending attach — either from
				// a DAP 'process' event (which carries systemProcessId) or from
				// a 'stopped' event with reason 'entry' (for debuggers like
				// pwa-node that don't emit 'process' on child sessions).
				let pending: PendingAttach | null = null;
				let attachPromise: Promise<boolean> | null = null;

				/**
				 * Consume a pending attach and start DLL injection for the given PID.
				 */
				function startAttach(pid: number): void {
					if (pending || pendingAttaches.length === 0) {
						return;
					}
					pending = pendingAttaches.shift()!;
					Logger.info(`mirrord: attaching to process ${pid}`);
					attachPromise = (async () => {
						try {
							const api = new MirrordAPI(pending!.cliPath);
							await api.attach(pid, pending!.configEnv);
							Logger.info(`mirrord: layer injected into process ${pid}`);
							return true;
						} catch (err) {
							const errorMsg = err instanceof Error ? err.message : String(err);
							Logger.error(`mirrord: attach failed: ${errorMsg}`);
							vscode.window.showErrorMessage(`mirrord attach failed: ${errorMsg}`);
							return false;
						}
					})();
				}

				return {
					onDidSendMessage: async (message: DebugProtocol.ProtocolMessage) => {
						/* ────────────────────────────────────────────────────────────────────────── */

						// This code heavily depends on the DAP specification, please refer to
						// https://microsoft.github.io/debug-adapter-protocol//specification.html
						// if you are confused about any usage here.

						/* ────────────────────────────────────────────────────────────────────────── */

						if (message.type !== 'event') {
							return;
						}

						const event = message as DebugProtocol.Event;

						// DAP 'process' event carries `systemProcessId`.
						// This fires once when the debug adapter spawns the target process.
						// We shift from pendingAttaches here (not in createDebugAdapterTracker)
						// because pwa-node spawns a parent session first, then a child session
						// for the actual process — and only the child gets the 'process' event.
						if (event.event === 'process') {
							const processEvent = event as DebugProtocol.ProcessEvent;
							const pid = processEvent.body?.systemProcessId;

							if (!pid) {
								Logger.warn(`DAP process event for "${session.name}" has no systemProcessId`);
								return;
							}

							if (pending) {
								Logger.debug(`Ignoring process event for "${session.name}" (pid=${pid}), pending attach already consumed`);
								return;
							}

							if (pendingAttaches.length === 0) {
								Logger.debug(`Process event for "${session.name}" (pid=${pid}) but no pending attaches in queue`);
								return;
							}

							startAttach(pid);
						}

						// DAP 'stopped' event with reason 'entry' fires when the debugger
						// pauses at entry due to stopOnEntry/stopAtEntry we set.
						//
						// Some debuggers (e.g. pwa-node) do NOT emit a 'process' event on the
						// child session, so 'stopped' with reason 'entry' is the first signal
						// that the process is alive and paused. In that case we extract the PID
						// from the session name (pattern: "name [PID]" or "name [PID] « parent").
						//
						// If the 'process' event already fired, `pending` and `attachPromise`
						// are set, so we just await and resume.
						if (event.event === 'stopped') {
							const stoppedEvent = event as DebugProtocol.StoppedEvent;

							if (stoppedEvent.body?.reason !== 'entry') {
								return;
							}

							Logger.debug(`Stopped-on-entry event for "${session.name}"`);

							// If no 'process' event was received, try to consume a pending
							// attach now, extracting the PID from the session name.
							if (!pending && pendingAttaches.length > 0) {
								const pidMatch = session.name.match(/\[(\d+)\]/);
								if (pidMatch) {
									const pid = parseInt(pidMatch[1]!, 10);
									Logger.debug(`Extracted pid=${pid} from session name "${session.name}"`);
									startAttach(pid);
								} else {
									Logger.warn(`Could not extract PID from session name "${session.name}" — no [PID] pattern found`);
								}
							}

							if (!pending) {
								Logger.debug(`No pending attach consumed for "${session.name}", skipping resume`);
								return;
							}

							if (pending.userHadStopOnEntry) {
								Logger.debug(`User had stop-on-entry enabled, not auto-resuming "${session.name}"`);
								return;
							}

							if (!attachPromise) {
								Logger.warn(`No attach promise for "${session.name}", cannot resume`);
								return;
							}

							const success = await attachPromise;
							if (!success) {
								Logger.warn(`Attach was not successful for "${session.name}", not resuming`);
								return;
							}

							const threadId = stoppedEvent.body?.threadId;
							if (threadId === undefined) {
								Logger.warn(`No threadId in stopped event for "${session.name}", cannot resume`);
								return;
							}

							Logger.info(`mirrord: resuming after forced stop-on-entry`);
							try {
								await session.customRequest('continue', { threadId });
								Logger.debug(`Resumed thread ${threadId} for "${session.name}"`);
							} catch (err) {
								const errorMsg = err instanceof Error ? err.message : String(err);
								Logger.error(`mirrord: failed to resume: ${errorMsg}`);
							}
						}
					},
				};
			}
		});
	}

	// Start mirrord binary update, so that we avoid downloading mid session.
	// Do not `await` here. Let this happen in the background.
	getMirrordBinary(true);

	new MirrordStatus(vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0))
		.register()
		.draw();
}
