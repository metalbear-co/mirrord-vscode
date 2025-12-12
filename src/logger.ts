import * as vscode from 'vscode';

class Logger {
  private static instance: vscode.LogOutputChannel;

  static init(context: vscode.ExtensionContext): void {
    Logger.instance = vscode.window.createOutputChannel('mirrord', { log: true });
    context.subscriptions.push(Logger.instance);
  }

  static get(): vscode.LogOutputChannel {
    if (!Logger.instance) {
      throw new Error('Logger not initialized');
    }
    return Logger.instance;
  }

  static trace(message: string): void {
    Logger.get().trace(message);
  }

  static debug(message: string): void {
    Logger.get().debug(message);
  }

  static info(message: string): void {
    Logger.get().info(message);
  }

  static warn(message: string): void {
    Logger.get().warn(message);
  }

  static error(message: string): void {
    Logger.get().error(message);
  }
}

export default Logger;