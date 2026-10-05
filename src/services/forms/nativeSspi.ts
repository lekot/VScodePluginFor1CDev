import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

export interface SspiStep {
  token: Buffer;
  complete: boolean;
}

export interface SspiAuthenticator {
  nextToken(challenge?: Buffer, signal?: AbortSignal): Promise<SspiStep>;
  dispose(): Promise<void>;
}

const HELPER_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CdtNativeSspiHelper {
    [StructLayout(LayoutKind.Sequential)]
    private struct SecHandle { public IntPtr Lower; public IntPtr Upper; }
    [StructLayout(LayoutKind.Sequential)]
    private struct SecBuffer { public int Size; public int Type; public IntPtr Data; }
    [StructLayout(LayoutKind.Sequential)]
    private struct SecBufferDesc { public int Version; public int Count; public IntPtr Buffers; }

    [DllImport("secur32.dll", CharSet = CharSet.Unicode, EntryPoint = "AcquireCredentialsHandleW")]
    private static extern int AcquireCredentialsHandle(string principal, string package, int usage,
        IntPtr logonId, IntPtr authData, IntPtr getKeyFn, IntPtr getKeyArgument,
        out SecHandle credential, out long expiry);
    [DllImport("secur32.dll", CharSet = CharSet.Unicode, EntryPoint = "InitializeSecurityContextW")]
    private static extern int InitializeSecurityContext(ref SecHandle credential, IntPtr oldContext,
        string targetName, int contextRequirements, int reserved1, int dataRepresentation,
        IntPtr input, int reserved2, IntPtr newContext, IntPtr output,
        out int contextAttributes, out long expiry);
    [DllImport("secur32.dll", EntryPoint = "CompleteAuthToken")]
    private static extern int CompleteAuthToken(ref SecHandle context, IntPtr token);
    [DllImport("secur32.dll", EntryPoint = "FreeContextBuffer")]
    private static extern int FreeContextBuffer(IntPtr buffer);
    [DllImport("secur32.dll", EntryPoint = "DeleteSecurityContext")]
    private static extern int DeleteSecurityContext(ref SecHandle context);
    [DllImport("secur32.dll", EntryPoint = "FreeCredentialsHandle")]
    private static extern int FreeCredentialsHandle(ref SecHandle credential);

    private const int SecPackageOutbound = 2;
    private const int SecBufferVersion = 0;
    private const int SecBufferToken = 2;
    private const int SecSuccess = 0;
    private const int SecContinueNeeded = 0x00090312;
    private const int SecCompleteNeeded = 0x00090313;
    private const int SecCompleteAndContinue = 0x00090314;
    private const int IscReqAllocateMemory = 0x00000100;
    private const int IscReqConnection = 0x00000800;
    private const int IscReqReplayDetect = 0x00000004;
    private const int IscReqSequenceDetect = 0x00000008;
    private const int IscReqConfidentiality = 0x00000010;
    private const int IscReqIntegrity = 0x00010000;

    private static SecHandle credential;
    private static SecHandle context;
    private static bool hasCredential;
    private static bool hasContext;

    public static void Run() {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.WriteLine("READY");
        Console.Out.Flush();
        try {
            string line;
            while ((line = Console.ReadLine()) != null) {
                if (line == "dispose") break;
                try {
                    byte[] input = line == "start" ? new byte[0] : Convert.FromBase64String(line.Substring(5));
                    SspiStep(input);
                } catch {
                    Console.WriteLine("ERROR:sspi-token-exchange-failed");
                    Console.Out.Flush();
                    break;
                }
            }
        } finally {
            if (hasContext) DeleteSecurityContext(ref context);
            if (hasCredential) FreeCredentialsHandle(ref credential);
        }
    }

    private static void SspiStep(byte[] inputBytes) {
        if (!hasCredential) {
            long credentialExpiry;
            int acquireStatus = AcquireCredentialsHandle(null, "NTLM", SecPackageOutbound,
                IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out credential, out credentialExpiry);
            if (acquireStatus != SecSuccess) throw new InvalidOperationException();
            hasCredential = true;
        }

        IntPtr inputData = IntPtr.Zero;
        IntPtr inputBuffer = IntPtr.Zero;
        IntPtr inputDescription = IntPtr.Zero;
        IntPtr outputBuffer = IntPtr.Zero;
        IntPtr outputDescription = IntPtr.Zero;
        IntPtr newContextPointer = IntPtr.Zero;
        IntPtr oldContextPointer = IntPtr.Zero;
        IntPtr outputToken = IntPtr.Zero;
        try {
            if (inputBytes.Length > 0) {
                inputData = Marshal.AllocHGlobal(inputBytes.Length);
                Marshal.Copy(inputBytes, 0, inputData, inputBytes.Length);
                SecBuffer inBuffer = new SecBuffer { Size = inputBytes.Length, Type = SecBufferToken, Data = inputData };
                inputBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecBuffer)));
                Marshal.StructureToPtr(inBuffer, inputBuffer, false);
                SecBufferDesc inDesc = new SecBufferDesc { Version = SecBufferVersion, Count = 1, Buffers = inputBuffer };
                inputDescription = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecBufferDesc)));
                Marshal.StructureToPtr(inDesc, inputDescription, false);
            }

            SecBuffer outBuffer = new SecBuffer { Size = 0, Type = SecBufferToken, Data = IntPtr.Zero };
            outputBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecBuffer)));
            Marshal.StructureToPtr(outBuffer, outputBuffer, false);
            SecBufferDesc outDesc = new SecBufferDesc { Version = SecBufferVersion, Count = 1, Buffers = outputBuffer };
            outputDescription = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecBufferDesc)));
            Marshal.StructureToPtr(outDesc, outputDescription, false);

            if (hasContext) {
                oldContextPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecHandle)));
                Marshal.StructureToPtr(context, oldContextPointer, false);
            }
            newContextPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecHandle)));
            int attributes;
            long expiry;
            int status = InitializeSecurityContext(ref credential, oldContextPointer, null,
                IscReqAllocateMemory | IscReqConnection | IscReqReplayDetect | IscReqSequenceDetect |
                    IscReqConfidentiality | IscReqIntegrity,
                0, 0x10, inputDescription, 0, newContextPointer, outputDescription, out attributes, out expiry);

            context = (SecHandle)Marshal.PtrToStructure(newContextPointer, typeof(SecHandle));
            hasContext = true;
            SecBuffer returned = (SecBuffer)Marshal.PtrToStructure(outputBuffer, typeof(SecBuffer));
            outputToken = returned.Data;
            if (status == SecCompleteNeeded || status == SecCompleteAndContinue) {
                int completeStatus = CompleteAuthToken(ref context, outputDescription);
                if (completeStatus != SecSuccess) throw new InvalidOperationException();
                status = status == SecCompleteNeeded ? SecSuccess : SecContinueNeeded;
            }
            if (status != SecSuccess && status != SecContinueNeeded) throw new InvalidOperationException();

            byte[] token = new byte[returned.Size];
            if (returned.Size > 0) Marshal.Copy(returned.Data, token, 0, returned.Size);
            string state = status == SecSuccess ? "DONE" : "MORE";
            Console.WriteLine("OK:" + state + ":" + Convert.ToBase64String(token));
            Console.Out.Flush();
        } finally {
            if (outputToken != IntPtr.Zero) FreeContextBuffer(outputToken);
            if (newContextPointer != IntPtr.Zero) Marshal.FreeHGlobal(newContextPointer);
            if (oldContextPointer != IntPtr.Zero) Marshal.FreeHGlobal(oldContextPointer);
            if (outputDescription != IntPtr.Zero) Marshal.FreeHGlobal(outputDescription);
            if (outputBuffer != IntPtr.Zero) Marshal.FreeHGlobal(outputBuffer);
            if (inputDescription != IntPtr.Zero) Marshal.FreeHGlobal(inputDescription);
            if (inputBuffer != IntPtr.Zero) Marshal.FreeHGlobal(inputBuffer);
            if (inputData != IntPtr.Zero) Marshal.FreeHGlobal(inputData);
        }
    }
}
`;

const RESPONSE_TIMEOUT_MS = 20_000;
const STARTUP_TIMEOUT_MS = 30_000;

export interface WindowsSspiAuthenticatorOptions {
  /** Injection seam for lifecycle tests; production always uses the OS PowerShell path. */
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
  powershellPath?: string;
  responseTimeoutMs?: number;
  startupTimeoutMs?: number;
}

/**
 * Uses inbox Windows PowerShell and .NET Framework's C# compiler to expose SSPI's
 * opaque NTLM tokens. The process receives tokens over stdin and never logs them.
 */
export class WindowsSspiAuthenticator implements SspiAuthenticator {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly lines: ReadlineInterface;
  private readonly queuedLines: string[] = [];
  private readonly lineWaiters: Array<(line: string) => void> = [];
  private processError?: Error;
  private disposed = false;
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly options: WindowsSspiAuthenticatorOptions = {}) {
    if ((options.platform ?? process.platform) !== 'win32') {
      throw new Error('Нативное подключение к 1С TestClient доступно только в Windows.');
    }
    const powershell = options.powershellPath
      ?? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(HELPER_SOURCE, 'utf8').toString('base64') + "'))",
      'Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop',
      '[CdtNativeSspiHelper]::Run()',
    ].join('; ');
    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
    this.process = (options.spawnProcess ?? spawn)(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand,
    ], { windowsHide: true, stdio: 'pipe' });
    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on('line', (line) => this.receiveLine(line));
    this.ready = this.readLine(options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS).then((line) => {
      if (line !== 'READY') {throw new Error('Не удалось запустить Windows SSPI helper.');}
    });
    void this.ready.catch(() => this.dispose());
    this.process.on('error', (error) => this.fail(error));
    this.process.on('exit', (code, signal) => {
      if (!this.disposed) {this.fail(new Error(`SSPI helper завершился (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`));}
    });
    this.process.stdin.on('error', (error) => this.fail(error));
    // stderr is intentionally drained but not retained: it may contain details
    // from the host security package that must not leak into diagnostics.
    this.process.stderr.resume();
  }

  async nextToken(challenge?: Buffer, signal?: AbortSignal): Promise<SspiStep> {
    const run = this.operation.then(async () => {
      await this.ready;
      this.throwIfUnavailable();
      if (signal?.aborted) {throw abortError();}
      const response = this.readLine(this.options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS, signal);
      const input = challenge ? `token ${challenge.toString('base64')}` : 'start';
      try {
        await this.writeLine(input);
      } catch (error) {
        await this.dispose();
        throw error;
      }
      let line: string;
      try {
        line = await response;
      } catch (error) {
        await this.dispose();
        throw error;
      }
      if (line.startsWith('ERROR:')) {throw new Error('Windows SSPI не смог сформировать токен NTLM.');}
      const match = /^OK:(MORE|DONE):([A-Za-z0-9+/=]*)$/.exec(line);
      if (!match) {throw new Error('SSPI helper вернул некорректный ответ.');}
      return { token: Buffer.from(match[2], 'base64'), complete: match[1] === 'DONE' };
    });
    this.operation = run.then(() => undefined, () => undefined);
    return run;
  }

  private readonly ready: Promise<void>;

  async dispose(): Promise<void> {
    if (this.disposed) {return;}
    this.disposed = true;
    this.lines.close();
    if (this.process.pid !== undefined && this.process.exitCode === null) {
      if (!this.processError && !this.process.stdin.destroyed && this.process.stdin.writable) {
        await this.writeLine('dispose').catch(() => undefined);
      }
      if (!this.process.stdin.destroyed) {this.process.stdin.end();}
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.process.kill();
          resolve();
        }, 1_000);
        this.process.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private receiveLine(line: string): void {
    const waiter = this.lineWaiters.shift();
    if (waiter) {waiter(line);}
    else {this.queuedLines.push(line);}
  }

  private readLine(timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const queued = this.queuedLines.shift();
    if (queued !== undefined) {return Promise.resolve(queued);}
    if (this.processError) {return Promise.reject(this.processError);}
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.lineWaiters.indexOf(onLine);
        if (index >= 0) {this.lineWaiters.splice(index, 1);}
      };
      const finish = (action: () => void) => {
        if (settled) {return;}
        settled = true;
        cleanup();
        action();
      };
      const onLine = (line: string) => finish(() => resolve(line));
      const onAbort = () => finish(() => reject(abortError()));
      const timer = setTimeout(() => finish(() => reject(new Error('Таймаут ответа Windows SSPI helper.'))), timeoutMs);
      this.lineWaiters.push(onLine);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private writeLine(line: string): Promise<void> {
    if (this.process.stdin.destroyed || !this.process.stdin.writable) {
      return Promise.reject(this.processError ?? new Error('Windows SSPI helper input is closed.'));
    }
    return new Promise<void>((resolve, reject) => {
      this.process.stdin.write(`${line}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  private fail(error: Error): void {
    if (this.processError) {return;}
    this.processError = error;
    for (const waiter of this.lineWaiters.splice(0)) {
      // Deliver a non-token protocol error to the waiting request.
      waiter(`ERROR:${error.message.replace(/[\r\n]/g, ' ')}`);
    }
  }

  private throwIfUnavailable(): void {
    if (this.disposed) {throw new Error('Windows SSPI helper уже остановлен.');}
    if (this.processError) {throw this.processError;}
    if (this.process.exitCode !== null) {throw new Error('Windows SSPI helper завершился.');}
  }
}

function abortError(): Error {
  const error = new Error('Операция SSPI отменена.');
  error.name = 'AbortError';
  return error;
}
