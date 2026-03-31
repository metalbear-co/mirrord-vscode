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
		console.log("[mirrord] registering DAP tracker factory (Windows)");
		vscode.debug.registerDebugAdapterTrackerFactory('*', {
			createDebugAdapterTracker(session: vscode.DebugSession) {
				console.log(`[mirrord] createDebugAdapterTracker called for session="${session.name}" (type="${session.type}", id="${session.id}"), pendingAttaches.length=${pendingAttaches.length}`);
				if (pendingAttaches.length === 0) {
					console.log(`[mirrord] createDebugAdapterTracker: no pending attaches, returning undefined`);
					return undefined;
				}

				console.log(`[mirrord] createDebugAdapterTracker: pending attaches available, returning tracker for session="${session.name}"`);

				// These are set when we consume a pending attach on the 'process' event.
				// Shared across `onDidSendMessage` invocations for this session.
				let pending: PendingAttach | null = null;
				let attachPromise: Promise<boolean> | null = null;

				return {
					onDidSendMessage: async (message: DebugProtocol.ProtocolMessage) => {
						/* ────────────────────────────────────────────────────────────────────────── */

						// This code heavily depends on the DAP specification, please refer to
						// https://microsoft.github.io/debug-adapter-protocol//specification.html
						// if you are confused about any usage here.

						/* ────────────────────────────────────────────────────────────────────────── */

						if (message.type !== 'event') {
							console.log(`[mirrord] onDidSendMessage(${session.name}): non-event message type="${message.type}", seq=${message.seq}`);
							return;
						}

						const event = message as DebugProtocol.Event;
						console.log(`[mirrord] onDidSendMessage(${session.name}): event="${event.event}", seq=${event.seq}`);

						// DAP 'process' event carries `systemProcessId`.
						// This fires once when the debug adapter spawns the target process.
						// We shift from pendingAttaches here (not in createDebugAdapterTracker)
						// because pwa-node spawns a parent session first, then a child session
						// for the actual process — and only the child gets the 'process' event.
						if (event.event === 'process') {
							const processEvent = event as DebugProtocol.ProcessEvent;
							const pid = processEvent.body?.systemProcessId;
							console.log(`[mirrord] process event(${session.name}): pid=${pid}, pending already consumed=${pending !== null}, attachPromise already set=${attachPromise !== null}`);

							if (!pid) {
								console.log(`[mirrord] process event(${session.name}): no systemProcessId — body: ${JSON.stringify(processEvent.body)}`);
								return;
							}

							if (pending) {
								console.log(`[mirrord] process event(${session.name}): ignoring duplicate, pending already consumed`);
								return;
							}

							if (pendingAttaches.length === 0) {
								console.log(`[mirrord] process event(${session.name}): pid=${pid} but pendingAttaches queue is empty, nothing to do`);
								return;
							}

							pending = pendingAttaches.shift()!;
							console.log(`[mirrord] process event(${session.name}): shifted pending attach — cliPath="${pending.cliPath}", stopOnEntryProperty="${pending.stopOnEntryProperty}", userHadStopOnEntry=${pending.userHadStopOnEntry}, remaining=${pendingAttaches.length}`);
							console.log(`[mirrord] starting attach for pid=${pid}`);
							Logger.info(`mirrord: attaching to process ${pid}`);
							attachPromise = (async () => {
								try {
									const api = new MirrordAPI(pending!.cliPath);
									console.log(`[mirrord] calling api.attach(${pid}) with cliPath="${pending!.cliPath}"`);
									await api.attach(pid, pending!.configEnv);
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
						}

						// DAP 'stopped' event with reason 'entry' fires when the debugger
						// pauses at entry due to stopOnEntry/stopAtEntry we set.
						// This arrives in a later `onDidSendMessage` call than 'process'.
						// We await the closure's `attachPromise` to ensure DLL injection
						// finished, then resume if the user didn't originally request
						// stop-on-entry.
						if (event.event === 'stopped') {
							const stoppedEvent = event as DebugProtocol.StoppedEvent;
							console.log(`[mirrord] stopped event(${session.name}): reason="${stoppedEvent.body?.reason}", threadId=${stoppedEvent.body?.threadId}, pending consumed=${pending !== null}, userHadStopOnEntry=${pending?.userHadStopOnEntry}, attachPromise set=${attachPromise !== null}`);

							if (!pending) {
								console.log(`[mirrord] stopped event(${session.name}): no pending attach was consumed by this tracker, ignoring`);
								return;
							}

							if (pending.userHadStopOnEntry) {
								console.log(`[mirrord] stopped event(${session.name}): user had stop-on-entry, not auto-resuming`);
								return;
							}

							if (!attachPromise) {
								console.log(`[mirrord] stopped event(${session.name}): no attachPromise, cannot resume (attach may not have started)`);
								return;
							}

							if (stoppedEvent.body?.reason !== 'entry') {
								console.log(`[mirrord] stopped event(${session.name}): reason is "${stoppedEvent.body?.reason}", not "entry" — ignoring`);
								return;
							}

							console.log(`[mirrord] stopped event(${session.name}): awaiting attachPromise before resuming...`);
							const success = await attachPromise;
							console.log(`[mirrord] stopped event(${session.name}): attachPromise resolved, success=${success}`);

							if (!success) {
								console.log(`[mirrord] stopped event(${session.name}): attach was not successful, not resuming`);
								return;
							}

							const threadId = stoppedEvent.body?.threadId;
							if (threadId === undefined) {
								console.log(`[mirrord] stopped event(${session.name}): no threadId in stopped event body, cannot resume`);
								return;
							}

							console.log(`[mirrord] resuming thread ${threadId} after forced stop-on-entry (session="${session.name}")`);
							Logger.info(`mirrord: resuming after forced stop-on-entry`);
							try {
								await session.customRequest('continue', { threadId });
								console.log(`[mirrord] resume succeeded for thread ${threadId} (session="${session.name}")`);
							} catch (err) {
								const errorMsg = err instanceof Error ? err.message : String(err);
								console.log(`[mirrord] resume FAILED for thread ${threadId} (session="${session.name}"): ${errorMsg}`);
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
