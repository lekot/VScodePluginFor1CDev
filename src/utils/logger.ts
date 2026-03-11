let vscode: any;
try {
  vscode = require('vscode');
} catch {
  vscode = null;
}

/**
 * Logger utility for the extension
 */
export class Logger {
  private static outputChannel: any = null;

  static initialize(): void {
    try {
      if (vscode && vscode.window) {
        this.outputChannel = vscode.window.createOutputChannel('1C Metadata Tree');
      }
    } catch {
      // vscode not available (e.g., in tests)
      this.outputChannel = null;
    }
  }

  static info(message: string, ...args: unknown[]): void {
    this.log('INFO', message, args);
  }

  static warn(message: string, ...args: unknown[]): void {
    this.log('WARN', message, args);
  }

  static error(message: string, error?: Error | unknown): void {
    const errorStr = error instanceof Error ? error.message : String(error);
    this.log('ERROR', message, [errorStr]);
  }

  static debug(message: string, ...args: unknown[]): void {
    this.log('DEBUG', message, args);
  }

  private static log(level: string, message: string, args: unknown[]): void {
    const timestamp = new Date().toISOString();
    const argsStr = args.length > 0 ? ` ${JSON.stringify(args)}` : '';
    const logMessage = `[${timestamp}] [${level}] ${message}${argsStr}`;

    if (this.outputChannel) {
      this.outputChannel.appendLine(logMessage);
    }

    if (level === 'ERROR') {
      console.error(logMessage);
    } else {
      console.log(logMessage);
    }
  }

  static show(): void {
    if (this.outputChannel) {
      this.outputChannel.show();
    }
  }
}
