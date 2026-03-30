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
		console.log("[mirrord] registering DAP tracker factory (Windows)");
		vscode.debug.registerDebugAdapterTrackerFactory('*', {
			createDebugAdapterTracker(session: vscode.DebugSession) {
				console.log(`[mirrord] createDebugAdapterTracker called for session="${session.name}" (type="${session.type}", id="${session.id}"), pendingAttaches.length=${pendingAttaches.length}`);
				if (pendingAttaches.length === 0) {
					console.log(`[mirrord] createDebugAdapterTracker: no pending attaches, returning undefined`);
					return undefined;
				}

				const pending = pendingAttaches.shift()!;
				console.log(`[mirrord] createDebugAdapterTracker: shifted pending attach — cliPath="${pending.cliPath}", stopOnEntryProperty="${pending.stopOnEntryProperty}", userHadStopOnEntry=${pending.userHadStopOnEntry}, remaining=${pendingAttaches.length}`);

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

						if (message.type !== 'event') {
							console.log(`[mirrord] onDidSendMessage: non-event message type="${message.type}", seq=${message.seq}`);
							return;
						}

						const event = message as DebugProtocol.Event;
						console.log(`[mirrord] onDidSendMessage: event="${event.event}", seq=${event.seq}`);

						// DAP 'process' event carries `systemProcessId`.
						// This fires once when the debug adapter spawns the target process.
						// We inject the mirrord layer DLL into it here.
						if (event.event === 'process') {
							const processEvent = event as DebugProtocol.ProcessEvent;
							const pid = processEvent.body?.systemProcessId;
							console.log(`[mirrord] process event: pid=${pid}, attachPromise already set=${attachPromise !== null}`);
							if (pid && !attachPromise) {
								console.log(`[mirrord] starting attach for pid=${pid}`);
								Logger.info(`mirrord: attaching to process ${pid}`);
								attachPromise = (async () => {
									try {
										const api = new MirrordAPI(pending.cliPath);
										console.log(`[mirrord] calling api.attach(${pid}) with cliPath="${pending.cliPath}"`);
										await api.attach(pid, pending.configEnv);
										console.log(`[mirrord] attach succeeded for pid=${pid}`);
										Logger.info(`mirrord: layer injected into process ${pid}`);
										return true;
									} catch (err) {
										const errorMsg = err instanceof Error ? err.message : String(err);
										console.log(`[mirrord] attach FAILED for pid=${pid}: ${errorMsg}`);
										Logger.error(`mirrord: attach failed: ${errorMsg}`);
										vscode.window.showErrorMessage(`mirrord attach failed: ${errorMsg}`);
										return false;
									}
								})();
							} else if (!pid) {
								console.log(`[mirrord] process event has no systemProcessId — body: ${JSON.stringify(processEvent.body)}`);
							} else {
								console.log(`[mirrord] process event: ignoring duplicate, attachPromise already set`);
							}
						}

						// DAP 'stopped' event with reason 'entry' fires when the debugger
						// pauses at entry due to stopOnEntry/stopAtEntry we set.
						// This arrives in a later `onDidSendMessage` call than 'process'.
						// We await the closure's `attachPromise` to ensure DLL injection
						// finished, then resume if the user didn't originally request
						// stop-on-entry.
						if (event.event === 'stopped') {
							const stoppedEvent = event as DebugProtocol.StoppedEvent;
							console.log(`[mirrord] stopped event: reason="${stoppedEvent.body?.reason}", threadId=${stoppedEvent.body?.threadId}, userHadStopOnEntry=${pending.userHadStopOnEntry}, attachPromise set=${attachPromise !== null}`);

							if (pending.userHadStopOnEntry) {
								console.log(`[mirrord] stopped event: user had stop-on-entry, not auto-resuming`);
								return;
							}

							if (!attachPromise) {
								console.log(`[mirrord] stopped event: no attachPromise, cannot resume (attach may not have started)`);
								return;
							}

							if (stoppedEvent.body?.reason !== 'entry') {
								console.log(`[mirrord] stopped event: reason is "${stoppedEvent.body?.reason}", not "entry" — ignoring`);
								return;
							}

							console.log(`[mirrord] stopped event: awaiting attachPromise before resuming...`);
							const success = await attachPromise;
							console.log(`[mirrord] stopped event: attachPromise resolved, success=${success}`);

							if (!success) {
								console.log(`[mirrord] stopped event: attach was not successful, not resuming`);
								return;
							}

							const threadId = stoppedEvent.body?.threadId;
							if (threadId === undefined) {
								console.log(`[mirrord] stopped event: no threadId in stopped event body, cannot resume`);
								return;
							}

							console.log(`[mirrord] resuming thread ${threadId} after forced stop-on-entry`);
							Logger.info(`mirrord: resuming after forced stop-on-entry`);
							try {
								await session.customRequest('continue', { threadId });
								console.log(`[mirrord] resume succeeded for thread ${threadId}`);
							} catch (err) {
								const errorMsg = err instanceof Error ? err.message : String(err);
								console.log(`[mirrord] resume FAILED for thread ${threadId}: ${errorMsg}`);
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
