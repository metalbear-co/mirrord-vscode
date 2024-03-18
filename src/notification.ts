import * as vscode from 'vscode';

export class NotificationBuilder {
  private message: string;
  private actions: [string, () => Thenable<any>][];
  private configEntry?: string;

  constructor() {
    this.message = "";
    this.actions = [];
  }

  private async show(fun: (message: string, ...actions: string[]) => Thenable<string | undefined>) {
    if (this.configEntry !== undefined) {
      const enabled = vscode.workspace.getConfiguration().get(`mirrord.${this.configEntry}`);
      if (enabled === false) {
        return;
      }
    }

    const buttons = this.actions.map(a => a[0]);
    const selected = await fun(this.message, ...buttons);

    if (selected === undefined) {
      return;
    }

    const action = this.actions.find(a => a[0] === selected);
    if (action === undefined) {
      return;
    }

    await action[1]();
  }

  withMessage(message: string): NotificationBuilder {
    this.message = message;
    return this;
  }

  withGenericAction(name: string, handler: () => Thenable<any>): NotificationBuilder {
    this.actions.push([name, handler]);
    return this;
  }

  withOpenFileAction(uri: vscode.Uri): NotificationBuilder {
    this.actions.push([
      "Open",
      async () => {
        let doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
      }
    ]);
    return this;
  }

  withDisableAction(configEntry: string): NotificationBuilder {
    this.configEntry = configEntry;
    this.actions.push([
      "Don't show again",
      async () => {
        const config = vscode.workspace.getConfiguration();
        await config.update(`mirrord.${this.configEntry}`, false);
      }
    ]);
    return this;
  }

  async error() {
    await this.show(vscode.window.showErrorMessage);
  }

  async warning() {
    await this.show(vscode.window.showWarningMessage);
  }

  async info() {
    await this.show(vscode.window.showInformationMessage);
  }
}
