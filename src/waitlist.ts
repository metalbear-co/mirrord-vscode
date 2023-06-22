import axios from 'axios';
import * as vscode from 'vscode';

interface IWaitlistResult {
    successful: boolean,
    message: string,
}

export async function waitlistRegisterCommand(email?: string): Promise<IWaitlistResult> {
    if (email && email.length > 0) {
        try {
            await axios.postForm(`https://waitlist.metalbear.co/v1/waitlist`, { email });

            return {
                successful: true,
                message: 'Thank you for joining the waitlist! We\'ll be in touch soon.'
            }

        } catch (e) {
            console.error(e);

            return {
                successful: true,
                message: 'Failed to join the waitlist. Please contact us at support@metalbear.co',
            }
        }
    }

    let emailInput = vscode.window.createInputBox();
    emailInput.prompt = 'Email Address';

    emailInput.onDidAccept(() => {
        emailInput.hide();

        vscode.commands.executeCommand<IWaitlistResult>('mirrord.waitlistSignup', emailInput.value).then(({ successful, message }) => {
            if (successful) {
                vscode.window.showInformationMessage(message);
            } else {
                vscode.window.showErrorMessage(message);   
                emailInput.show()
            }
        });
    });

    emailInput.show();

    return { successful: false, message: "User Prompted" };
}
