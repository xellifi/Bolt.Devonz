import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanTerminalOutput, newDevonzShellProcess, newShellProcess, DevonzShell } from './shell';
import type { RuntimeProvider, SpawnedProcess, Disposer } from '~/lib/runtime/runtime-provider';
import type { ITerminal } from '~/types/terminal';

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

vi.mock('~/utils/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('~/utils/terminalErrorDetector', () => ({
  detectTerminalErrors: vi.fn(),
}));

vi.mock('~/utils/debugLogger', () => ({
  captureTerminalLog: vi.fn(),
}));

vi.mock('~/lib/stores/qrCode', () => ({
  expoUrlAtom: { set: vi.fn(), get: vi.fn(() => '') },
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/** Flush the microtask queue so `await`-ed mock promises inside init resolve. */
const flushMicrotasks = () => new Promise<void>((r) => queueMicrotask(r));

function createMockTerminal(overrides: Partial<ITerminal> = {}): ITerminal {
  return {
    cols: 80,
    rows: 15,
    reset: vi.fn(),
    write: vi.fn(),
    onData: vi.fn(),
    input: vi.fn(),
    ...overrides,
  };
}

type DataCallback = (data: string) => void;

function createMockProcess(
  overrides: Partial<SpawnedProcess> = {},
): SpawnedProcess & { _dataCallbacks: DataCallback[] } {
  const dataCallbacks: DataCallback[] = [];

  return {
    id: 'mock-process-1',
    pid: 12345,
    write: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
    onExit: new Promise<number>(() => {
      /* never resolves in mock */
    }),
    onData: vi.fn((cb: DataCallback): Disposer => {
      dataCallbacks.push(cb);

      return () => {
        const idx = dataCallbacks.indexOf(cb);

        if (idx >= 0) {
          dataCallbacks.splice(idx, 1);
        }
      };
    }),
    _dataCallbacks: dataCallbacks,
    ...overrides,
  };
}

function createMockRuntime(process?: SpawnedProcess): RuntimeProvider {
  const mockProcess = process ?? createMockProcess();

  return {
    type: 'local',
    projectId: 'test-project',
    workdir: '/tmp/test',
    fs: {} as RuntimeProvider['fs'],
    boot: vi.fn(),
    spawn: vi.fn().mockResolvedValue(mockProcess),
    exec: vi.fn(),
    onPortEvent: vi.fn(),
    teardown: vi.fn(),
  } as unknown as RuntimeProvider;
}

/**
 * Helper: initialize a DevonzShell with mocks, wait for readiness,
 * and return the onData callback for further simulation.
 */
async function initDevonzShell(target: DevonzShell) {
  const mockProcess = createMockProcess();
  const runtime = createMockRuntime(mockProcess);
  const terminal = createMockTerminal();

  const initPromise = target.init(runtime, terminal);

  /* Flush microtask queue so `await runtime.spawn()` inside init resolves */
  await flushMicrotasks();

  const onDataCb = (mockProcess.onData as ReturnType<typeof vi.fn>).mock.calls[0][0] as DataCallback;
  onDataCb('__DEVONZ_CMD_DONE___READY');

  await initPromise;

  return { mockProcess, runtime, terminal, onDataCb };
}

/* ------------------------------------------------------------------ */
/*  cleanTerminalOutput                                               */
/* ------------------------------------------------------------------ */

describe('cleanTerminalOutput', () => {
  it('should return empty string for empty input', () => {
    expect(cleanTerminalOutput('')).toBe('');
  });

  it('should pass through plain text unchanged', () => {
    expect(cleanTerminalOutput('hello world')).toBe('hello world');
  });

  it('should strip ANSI color codes (ESC[ sequences)', () => {
    const input = '\u001b[31mError\u001b[0m: something failed';
    const result = cleanTerminalOutput(input);
    expect(result).not.toContain('\u001b');
    expect(result).toContain('Error');
    expect(result).toContain('something failed');
  });

  it('should strip hex-style ANSI codes (\\x1b)', () => {
    const input = '\x1b[1;32mSuccess\x1b[0m';
    const result = cleanTerminalOutput(input);
    expect(result).not.toContain('\x1b');
    expect(result).toContain('Success');
  });

  it('should remove OSC sequences terminated by BEL (\\x07)', () => {
    const input = '\x1b]0;Window Title\x07Some output';
    const result = cleanTerminalOutput(input);
    expect(result).not.toContain('Window Title');
    expect(result).toContain('Some output');
  });

  it('should normalize \\r\\n to \\n', () => {
    const input = 'line1\r\nline2\r\nline3';
    const result = cleanTerminalOutput(input);
    expect(result).toBe('line1\nline2\nline3');
  });

  it('should normalize bare \\r to \\n', () => {
    const input = 'line1\rline2\rline3';
    const result = cleanTerminalOutput(input);
    expect(result).toBe('line1\nline2\nline3');
  });

  it('should collapse 3+ consecutive newlines to 2', () => {
    const input = 'line1\n\n\n\nline2';
    const result = cleanTerminalOutput(input);
    expect(result).toBe('line1\nline2');
  });

  it('should trim leading/trailing whitespace', () => {
    const input = '   hello world   ';
    const result = cleanTerminalOutput(input);
    expect(result).toBe('hello world');
  });

  it('should remove null characters', () => {
    const input = 'hello\u0000world';
    const result = cleanTerminalOutput(input);
    expect(result).not.toContain('\u0000');
    expect(result).toContain('helloworld');
  });

  it('should collapse multiple spaces to single space', () => {
    const input = 'hello    world';
    const result = cleanTerminalOutput(input);
    expect(result).toBe('hello world');
  });

  it('should normalize colon spacing', () => {
    const input = 'Error:    something broke';
    const result = cleanTerminalOutput(input);
    expect(result).toContain('Error: something');
  });

  it('should add newline before error/warning keywords', () => {
    const input = 'some output error: something went wrong';
    const result = cleanTerminalOutput(input);
    expect(result).toContain('\nerror: something went wrong');
  });

  it('should add newline before npm ERR!', () => {
    const input = 'some output npm ERR! code ENOENT';
    const result = cleanTerminalOutput(input);
    expect(result).toContain('\nnpm ERR!');
  });

  it('should handle complex mixed ANSI + content', () => {
    const input = '\x1b[36m>\x1b[39m \x1b[1mbuild\x1b[22m\n\x1b[31merror\x1b[39m: Module not found';
    const result = cleanTerminalOutput(input);
    expect(result).not.toContain('\x1b');
    expect(result).toContain('build');
  });

  it('should handle "at" stack trace lines by adding newline', () => {
    const input = 'Error: failat Object.<anonymous> (index.js:1:1)';
    const result = cleanTerminalOutput(input);
    expect(result).toContain('\nat Object');
  });

  it('should not break "at async" patterns', () => {
    const input = 'at async loadModule (loader.js:10:5)';
    const result = cleanTerminalOutput(input);
    expect(result).toContain('at async');
  });

  it('should strip empty lines produced by cleaning', () => {
    const input = '\n\n\nhello\n\n\n\nworld\n\n\n';
    const result = cleanTerminalOutput(input);
    expect(result).toBe('hello\nworld');
  });

  it('should handle question mark ANSI sequences', () => {
    const input = '\x1b[?25hsome text\x1b[?25l';
    const result = cleanTerminalOutput(input);
    expect(result).toContain('some text');
    expect(result).not.toContain('\x1b');
  });

  it('should handle prompt-like output with ❯ character', () => {
    const input = '~/project❯ npm start';
    const result = cleanTerminalOutput(input);
    expect(result).toContain('~/project');
    expect(result).toContain('❯');
  });
});

/* ------------------------------------------------------------------ */
/*  newDevonzShellProcess                                             */
/* ------------------------------------------------------------------ */

describe('newDevonzShellProcess', () => {
  it('should return a DevonzShell instance', () => {
    const shell = newDevonzShellProcess();
    expect(shell).toBeInstanceOf(DevonzShell);
  });

  it('should return a new instance each call', () => {
    const a = newDevonzShellProcess();
    const b = newDevonzShellProcess();
    expect(a).not.toBe(b);
  });
});

/* ------------------------------------------------------------------ */
/*  newShellProcess                                                   */
/* ------------------------------------------------------------------ */

describe('newShellProcess', () => {
  it('should spawn a process via runtime.spawn', async () => {
    const mockProcess = createMockProcess();
    const runtime = createMockRuntime(mockProcess);
    const terminal = createMockTerminal();

    const result = await newShellProcess(runtime, terminal);
    expect(runtime.spawn).toHaveBeenCalledTimes(1);
    expect(result).toBe(mockProcess);
  });

  it('should pass terminal dimensions to spawn options', async () => {
    const mockProcess = createMockProcess();
    const runtime = createMockRuntime(mockProcess);
    const terminal = createMockTerminal({ cols: 120, rows: 40 });

    await newShellProcess(runtime, terminal);

    expect(runtime.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        terminal: { cols: 120, rows: 40 },
      }),
    );
  });

  it('should default cols to 80 and rows to 15 when terminal has no dimensions', async () => {
    const mockProcess = createMockProcess();
    const runtime = createMockRuntime(mockProcess);
    const terminal = createMockTerminal({ cols: undefined, rows: undefined });

    await newShellProcess(runtime, terminal);

    expect(runtime.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        terminal: { cols: 80, rows: 15 },
      }),
    );
  });

  it('should forward process output to terminal.write', async () => {
    const mockProcess = createMockProcess();
    const runtime = createMockRuntime(mockProcess);
    const terminal = createMockTerminal();

    await newShellProcess(runtime, terminal);

    /* Simulate process data event */
    const onDataCb = (mockProcess.onData as ReturnType<typeof vi.fn>).mock.calls[0][0] as DataCallback;
    onDataCb('hello from shell');

    expect(terminal.write).toHaveBeenCalledWith('hello from shell');
  });

  it('should forward terminal input to process.write', async () => {
    const mockProcess = createMockProcess();
    const runtime = createMockRuntime(mockProcess);
    let terminalDataCb: DataCallback | undefined;
    const terminal = createMockTerminal({
      onData: vi.fn((cb: DataCallback) => {
        terminalDataCb = cb;
      }),
    });

    await newShellProcess(runtime, terminal);

    /* Simulate terminal input */
    terminalDataCb?.('user typed something');
    expect(mockProcess.write).toHaveBeenCalledWith('user typed something');
  });
});

/* ------------------------------------------------------------------ */
/*  DevonzShell                                                       */
/* ------------------------------------------------------------------ */

describe('DevonzShell', () => {
  let shell: DevonzShell;

  beforeEach(() => {
    shell = new DevonzShell();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor & ready()', () => {
    it('ready() returns a promise', () => {
      const promise = shell.ready();
      expect(promise).toBeInstanceOf(Promise);
    });

    it('ready() resolves after init completes', async () => {
      await initDevonzShell(shell);

      /* ready() should now resolve immediately */
      await shell.ready();
    });
  });

  describe('init()', () => {
    it('should spawn a shell process', async () => {
      const { runtime } = await initDevonzShell(shell);
      expect(runtime.spawn).toHaveBeenCalledTimes(1);
    });

    it('should send readiness echo command', async () => {
      const { mockProcess } = await initDevonzShell(shell);

      expect(mockProcess.write).toHaveBeenCalledWith(expect.stringContaining('echo "__DEVONZ_CMD_DONE___READY"'));
    });

    it('should reset terminal after readiness detected', async () => {
      const { terminal } = await initDevonzShell(shell);
      expect(terminal.reset).toHaveBeenCalledTimes(1);
    });

    it('should forward terminal input to process', async () => {
      const mockProcess = createMockProcess();
      const runtime = createMockRuntime(mockProcess);
      let terminalDataCb: DataCallback | undefined;
      const terminal = createMockTerminal({
        onData: vi.fn((cb: DataCallback) => {
          terminalDataCb = cb;
        }),
      });

      const initPromise = shell.init(runtime, terminal);
      await flushMicrotasks();

      const onDataCb = (mockProcess.onData as ReturnType<typeof vi.fn>).mock.calls[0][0] as DataCallback;
      onDataCb('__DEVONZ_CMD_DONE___READY');
      await initPromise;

      terminalDataCb?.('ls -la');
      expect(mockProcess.write).toHaveBeenCalledWith('ls -la');
    });

    it('should expose terminal and process getters after init', async () => {
      const { terminal, mockProcess } = await initDevonzShell(shell);
      expect(shell.terminal).toBe(terminal);
      expect(shell.process).toBe(mockProcess);
    });

    it('should filter internal marker noise from terminal output', async () => {
      const { terminal, onDataCb } = await initDevonzShell(shell);
      (terminal.write as ReturnType<typeof vi.fn>).mockClear();

      onDataCb('some output; echo "__DEVONZ_CMD_DONE__abc_0"');

      const writtenData = (terminal.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string | undefined;

      if (writtenData) {
        expect(writtenData).not.toContain('; echo "__DEVONZ_CMD_DONE__');
      }
    });

    it('should filter bash startup noise from terminal output', async () => {
      const { terminal, onDataCb } = await initDevonzShell(shell);
      (terminal.write as ReturnType<typeof vi.fn>).mockClear();

      onDataCb('bash: cannot set terminal process group (-1): Inappropriate ioctl for device');

      const writtenData = (terminal.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string | undefined;

      if (writtenData) {
        expect(writtenData).not.toContain('bash: cannot set terminal process group');
      }
    });
  });

  describe('interruptExecution()', () => {
    it('should send Ctrl+C to process', async () => {
      const { mockProcess } = await initDevonzShell(shell);
      shell.interruptExecution();
      expect(mockProcess.write).toHaveBeenCalledWith('\x03');
    });

    it('should not throw if process is undefined', () => {
      expect(() => shell.interruptExecution()).not.toThrow();
    });
  });

  describe('executionState', () => {
    it('should be undefined initially', () => {
      expect(shell.executionState.get()).toBeUndefined();
    });
  });

  describe('executeCommand()', () => {
    it('should return undefined if process is not initialized', async () => {
      const result = await shell.executeCommand('session1', 'echo hello');
      expect(result).toBeUndefined();
    });

    it('should write marker-wrapped command to process', async () => {
      const { mockProcess, onDataCb } = await initDevonzShell(shell);
      (mockProcess.write as ReturnType<typeof vi.fn>).mockClear();

      const cmdPromise = shell.executeCommand('session1', 'npm install');

      const writtenCommand = (mockProcess.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(writtenCommand).toContain('npm install');
      expect(writtenCommand).toContain('echo "__DEVONZ_CMD_DONE__');
      expect(writtenCommand).toContain('$?');

      const markerId = writtenCommand.match(/__DEVONZ_CMD_DONE___(\w+)_/)?.[1];

      if (!markerId) {
        throw new Error('Could not extract markerId from written command');
      }

      onDataCb(`command output here\n__DEVONZ_CMD_DONE___${markerId}_0`);

      const result = await cmdPromise;
      expect(result).toBeDefined();
      expect(result!.exitCode).toBe(0);
    });

    it('should capture command output before marker', async () => {
      const { mockProcess, onDataCb } = await initDevonzShell(shell);
      (mockProcess.write as ReturnType<typeof vi.fn>).mockClear();

      const cmdPromise = shell.executeCommand('session1', 'echo test');

      const writtenCommand = (mockProcess.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      const markerId = writtenCommand.match(/__DEVONZ_CMD_DONE___(\w+)_/)?.[1];

      if (!markerId) {
        throw new Error('Could not extract markerId');
      }

      onDataCb(`test output\n__DEVONZ_CMD_DONE___${markerId}_0`);

      const result = await cmdPromise;
      expect(result).toBeDefined();
      expect(result!.output).toContain('test output');
    });

    it('should report non-zero exit codes', async () => {
      const { mockProcess, onDataCb } = await initDevonzShell(shell);
      (mockProcess.write as ReturnType<typeof vi.fn>).mockClear();

      const cmdPromise = shell.executeCommand('session1', 'exit 1');

      const writtenCommand = (mockProcess.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      const markerId = writtenCommand.match(/__DEVONZ_CMD_DONE___(\w+)_/)?.[1];

      if (!markerId) {
        throw new Error('Could not extract markerId');
      }

      onDataCb(`error output\n__DEVONZ_CMD_DONE___${markerId}_1`);

      const result = await cmdPromise;
      expect(result).toBeDefined();
      expect(result!.exitCode).toBe(1);
    });

    it('should set executionState to active during execution', async () => {
      const { mockProcess, onDataCb } = await initDevonzShell(shell);
      (mockProcess.write as ReturnType<typeof vi.fn>).mockClear();

      const cmdPromise = shell.executeCommand('session1', 'long command');

      const state = shell.executionState.get();
      expect(state?.active).toBe(true);
      expect(state?.sessionId).toBe('session1');

      const writtenCommand = (mockProcess.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      const markerId = writtenCommand.match(/__DEVONZ_CMD_DONE___(\w+)_/)?.[1];

      if (!markerId) {
        throw new Error('Could not extract markerId');
      }

      onDataCb(`done\n__DEVONZ_CMD_DONE___${markerId}_0`);
      await cmdPromise;

      const finalState = shell.executionState.get();
      expect(finalState?.active).toBe(false);
    });

    it('should handle accumulated output across multiple data events', async () => {
      const { mockProcess, onDataCb } = await initDevonzShell(shell);
      (mockProcess.write as ReturnType<typeof vi.fn>).mockClear();

      const cmdPromise = shell.executeCommand('session1', 'multiline');

      const writtenCommand = (mockProcess.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      const markerId = writtenCommand.match(/__DEVONZ_CMD_DONE___(\w+)_/)?.[1];

      if (!markerId) {
        throw new Error('Could not extract markerId');
      }

      onDataCb('chunk1 ');
      onDataCb('chunk2 ');
      onDataCb(`chunk3\n__DEVONZ_CMD_DONE___${markerId}_0`);

      const result = await cmdPromise;
      expect(result).toBeDefined();
      expect(result!.output).toContain('chunk1');
      expect(result!.output).toContain('chunk2');
      expect(result!.output).toContain('chunk3');
      expect(result!.exitCode).toBe(0);
    });

    it('should trim whitespace from commands', async () => {
      const { mockProcess, onDataCb } = await initDevonzShell(shell);
      (mockProcess.write as ReturnType<typeof vi.fn>).mockClear();

      const cmdPromise = shell.executeCommand('session1', '  echo padded  ');

      const writtenCommand = (mockProcess.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(writtenCommand).toMatch(/^echo padded/);

      const markerId = writtenCommand.match(/__DEVONZ_CMD_DONE___(\w+)_/)?.[1];

      if (!markerId) {
        throw new Error('Could not extract markerId');
      }

      onDataCb(`padded\n__DEVONZ_CMD_DONE___${markerId}_0`);
      await cmdPromise;
    });

    it('should interrupt previous active command before starting new one', async () => {
      const { mockProcess, onDataCb } = await initDevonzShell(shell);
      (mockProcess.write as ReturnType<typeof vi.fn>).mockClear();

      /* Start first command */
      const firstCmdPromise = shell.executeCommand('session1', 'first command');

      const firstWritten = (mockProcess.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      const firstMarkerId = firstWritten.match(/__DEVONZ_CMD_DONE___(\w+)_/)?.[1];

      /*
       * Schedule first command completion during the 100ms setTimeout window
       * that executeCommand uses when interrupting a running command.
       */
      setTimeout(() => {
        if (firstMarkerId) {
          onDataCb(`interrupted\n__DEVONZ_CMD_DONE___${firstMarkerId}_130`);
        }
      }, 50);

      /* Start second command — should send Ctrl+C and interrupt first */
      const secondCmdPromise = shell.executeCommand('session2', 'second command');

      expect(mockProcess.write).toHaveBeenCalledWith('\x03');

      /*
       * Wait for the second executeCommand's internal awaits to complete:
       * - 100ms setTimeout (interrupt settling)
       * - await state.executionPrms (first command resolved at 50ms)
       * After those, the second command writes its marker to the process.
       */
      await new Promise((r) => setTimeout(r, 200));

      /* Now the second command should have written its marker command */
      const secondWritten = (mockProcess.write as ReturnType<typeof vi.fn>).mock.calls.find((call) =>
        (call[0] as string).includes('second command'),
      );

      if (secondWritten) {
        const secondMarkerId = (secondWritten[0] as string).match(/__DEVONZ_CMD_DONE___(\w+)_/)?.[1];

        if (secondMarkerId) {
          onDataCb(`second output\n__DEVONZ_CMD_DONE___${secondMarkerId}_0`);
        }
      }

      await firstCmdPromise;

      const secondResult = await secondCmdPromise;
      expect(secondResult).toBeDefined();
    });
  });

  describe('Expo URL detection', () => {
    it('should detect Expo URLs in output and set the atom', async () => {
      const { expoUrlAtom } = await import('~/lib/stores/qrCode');
      const { onDataCb } = await initDevonzShell(shell);

      onDataCb('Metro bundling complete. exp://192.168.1.5:19000 ready');

      expect(expoUrlAtom.set).toHaveBeenCalledWith(expect.stringContaining('exp://192.168.1.5:19000'));
    });
  });

  describe('#filterInternalNoise (via terminal.write)', () => {
    it('should pass through data without markers or bash noise', async () => {
      const { terminal, onDataCb } = await initDevonzShell(shell);
      (terminal.write as ReturnType<typeof vi.fn>).mockClear();

      onDataCb('normal output line');
      expect(terminal.write).toHaveBeenCalledWith('normal output line');
    });

    it('should strip marker echo suffix from command lines', async () => {
      const { terminal, onDataCb } = await initDevonzShell(shell);
      (terminal.write as ReturnType<typeof vi.fn>).mockClear();

      onDataCb('npm install; echo "__DEVONZ_CMD_DONE__abc123_$?"');

      const written = (terminal.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(written).not.toContain('; echo "__DEVONZ_CMD_DONE__');
    });

    it('should remove lines containing marker prefix entirely', async () => {
      const { terminal, onDataCb } = await initDevonzShell(shell);
      (terminal.write as ReturnType<typeof vi.fn>).mockClear();

      onDataCb('__DEVONZ_CMD_DONE__abc_0');

      const written = (terminal.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;

      if (written) {
        expect(written.trim()).not.toContain('__DEVONZ_CMD_DONE__');
      }
    });

    it('should remove bash no-job-control noise', async () => {
      const { terminal, onDataCb } = await initDevonzShell(shell);
      (terminal.write as ReturnType<typeof vi.fn>).mockClear();

      onDataCb('bash: no job control in this shell');

      const written = (terminal.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;

      if (written) {
        expect(written.trim()).not.toContain('no job control');
      }
    });

    it('should collapse excessive blank lines after filtering', async () => {
      const { terminal, onDataCb } = await initDevonzShell(shell);
      (terminal.write as ReturnType<typeof vi.fn>).mockClear();

      /* Include a marker line so filterInternalNoise engages blank-line collapsing */
      onDataCb('line1\n\n\n\n__DEVONZ_CMD_DONE__removed\n\n\nline2');

      const written = (terminal.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(written).not.toMatch(/\n{3,}/);
    });
  });

  describe('getters before init', () => {
    it('terminal should be undefined before init', () => {
      expect(shell.terminal).toBeUndefined();
    });

    it('process should be undefined before init', () => {
      expect(shell.process).toBeUndefined();
    });
  });
});
