import * as vscode from 'vscode';
import { DebugProtocol } from '@vscode/debugprotocol';
import { ConfigurationProvider, pendingAttaches } from './debugger';
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
		vscode.debug.registerDebugAdapterTrackerFactory('*', {
			createDebugAdapterTracker(session: vscode.DebugSession) {
				if (pendingAttaches.length === 0) {
					return undefined;
				}

				const pending = pendingAttaches.shift()!;

				// Closure variable shared across `onDidSendMessage` invocations for
				// this debug session. Set once when we receive the DAP 'process' event,
				// then awaited by the 'stopped' handler to ensure DLL injection is
				// complete before resuming execution.
				let attachPromise: Promise<boolean> | null = null;

				return {
					onDidSendMessage: async (message: DebugProtocol.ProtocolMessage) => {
						/* ────────────────────────────────────────────────────────────────────────── */

						// This code heavily depends on the DAP specification, please refer to
						// https://microsoft.github.io/debug-adapter-protocol//specification.html
						// if you are confused about any usage here.

						/* ────────────────────────────────────────────────────────────────────────── */

						// DAP 'process' event carries `systemProcessId`.
						// This fires once when the debug adapter spawns the target process.
						// We inject the mirrord layer DLL into it here.
						if (message.type === 'event') {
							const event = message as DebugProtocol.Event;
							if (event.event === 'process') {
								const processEvent = event as DebugProtocol.ProcessEvent;
								const pid = processEvent.body?.systemProcessId;
								if (pid && !attachPromise) {
									Logger.info(`mirrord: attaching to process ${pid}`);
									attachPromise = (async () => {
										try {
											const api = new MirrordAPI(pending.cliPath);
											await api.attach(pid, pending.configEnv);
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
							}

							// DAP 'stopped' event with reason 'entry' fires when the debugger
							// pauses at entry due to stopOnEntry/stopAtEntry we set.
							// This arrives in a later `onDidSendMessage` call than 'process'.
							// We await the closure's `attachPromise` to ensure DLL injection
							// finished, then resume if the user didn't originally request
							// stop-on-entry.
							if (!pending.userHadStopOnEntry && event.event === 'stopped' && attachPromise) {
								const stoppedEvent = event as DebugProtocol.StoppedEvent;
								if (stoppedEvent.body?.reason === 'entry') {
									const success = await attachPromise;
									if (success) {
										const threadId = stoppedEvent.body?.threadId;
										if (threadId !== undefined) {
											Logger.info(`mirrord: resuming after forced stop-on-entry`);
											try {
												await session.customRequest('continue', { threadId });
											} catch (err) {
												const errorMsg = err instanceof Error ? err.message : String(err);
												Logger.error(`mirrord: failed to resume: ${errorMsg}`);
											}
										}
									}
								}
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
