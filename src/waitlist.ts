import axios from 'axios';
import * as vscode from 'vscode';
import { globalContext } from './extension';
import { NotificationBuilder } from './notification';

interface IWaitlistResult {
    successful: boolean,
    message: string,
}

export const WAITLIST_SUPPRESS = 'mirrord-waitlist-suppress';
export const WAITLIST_COUNTER = 'mirrord-waitlist-counter';

const WAITLIST_CTA_START = 100;
const WAITLIST_CTA_REPEAT = 30;

export async function waitlistRegisterCommand(email?: string, blockPrompt?: boolean): Promise<IWaitlistResult> {
    if (email && email.length > 0) {
        try {
            let response = await axios.postForm(`https://waitlist.metalbear.co/v1/waitlist?source=vscode`, { email });

            if (response.status === 200) {
                return {
                    successful: true,
                    message: 'Thank you for joining the waitlist for mirrord for Teams! We\'ll be in touch soon.',
                };
            }

            console.error('waitlist signup bad response', response);

            return {
                successful: true,
                message: 'Failed to join the waitlist. Please contact us at support@metalbear.co',
            };
        } catch (e) {
            console.error(e);

            return {
                successful: true,
                message: 'Failed to join the waitlist. Please contact us at support@metalbear.co',
            };
        }
    }

    if (!blockPrompt) {
        let emailInput = vscode.window.createInputBox();
        emailInput.prompt = 'Email Address';

        emailInput.onDidAccept(() => {
            emailInput.hide();

            vscode.commands.executeCommand<IWaitlistResult>('mirrord.waitlistSignup', emailInput.value, true).then(({ successful, message }) => {
                if (successful) {
                    new NotificationBuilder()
                        .withMessage(message)
                        .info();
                    globalContext.globalState.update(WAITLIST_SUPPRESS, 'true');
                } else {
                    new NotificationBuilder()
                        .withMessage(message)
                        .error();
                    emailInput.show();
                }
            });
        });

        emailInput.show();
    }

    return { successful: false, message: 'Please enter your email' };
}

export async function waitlistRegisterCta(message?: string) {
    if (!!globalContext.globalState.get(WAITLIST_SUPPRESS)) {
        return;
    }

    new NotificationBuilder()
        .withMessage(message ?? "Hey, you should join mirrord-teams")
        .withGenericAction("Join the waitlist", async () => {
            await vscode.commands.executeCommand<IWaitlistResult>('mirrord.waitlistSignup');
        })
        .withDisableAction("promptWaitlistSignup")
        .info();
}

export function tickWaitlistCounter(isDeploymentExec: boolean) {
    const counter = parseInt(globalContext.globalState.get(WAITLIST_COUNTER) ?? '0') || 0;

    if (isDeploymentExec) {
        waitlistRegisterCta('When targeting multi-pod deployments, mirrord impersonates the first pod in the deployment.\n \
                      Support for multi-pod impersonation requires the mirrord operator, which is part of mirrord for Teams.\n \
                      To try it out, join the waitlist. [Read More](https://mirrord.dev/docs/teams/introduction/)');
    } else if (counter >= WAITLIST_CTA_START) {
        if (counter === WAITLIST_CTA_START || (counter - WAITLIST_CTA_START) % WAITLIST_CTA_REPEAT === 0) {
            waitlistRegisterCta();
        }
    }

    globalContext.globalState.update(WAITLIST_COUNTER, `${counter + 1}`);
}
