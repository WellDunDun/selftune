/**
 * tui.ts
 *
 * Zero-dependency TUI primitives for the selftune evolve pipeline.
 * Uses raw ANSI escape codes for spinners, timers, and step progression.
 * All output goes to stderr to keep stdout clean for JSON results.
 */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 80;

export interface EvolveTUI {
  /** Start a new step with a spinner. Completes the previous step (if any) with checkmark. */
  step(label: string): void;
  /** Complete the current step with checkmark and a custom label. */
  done(label: string): void;
  /** Complete the current step as failed with cross mark and a custom label. */
  fail(label: string): void;
  /** Stop all timers and print a summary line. */
  finish(summary: string): void;
  /** Clean up timers without printing. For error paths. */
  destroy(): void;
}

function createNoopTUI(): EvolveTUI {
  return { step() {}, done() {}, fail() {}, finish() {}, destroy() {} };
}

function createPlainTextTUI(opts: { skillName: string; model: string }): EvolveTUI {
  const write = (s: string) => process.stderr.write(s);
  let stepStartTime = Date.now();
  let currentLabel = "";
  let hasActiveStep = false;
  let destroyed = false;

  const checkMark = process.env.NO_COLOR ? "+" : "\u2713";
  const crossMark = process.env.NO_COLOR ? "x" : "\u2717";

  write(`\n  selftune evolve \u2500\u2500 ${opts.skillName} \u2500\u2500 ${opts.model}\n\n`);

  function formatTime(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function writeStartedLine(label: string): void {
    write(`  -> ${label}\n`);
  }

  function writeCompletedLine(marker: string, label: string, elapsed: number): void {
    const time = formatTime(elapsed);
    const padding = Math.max(1, 48 - label.length);
    write(`  ${marker} ${label}${" ".repeat(padding)}${time}\n`);
  }

  function completeCurrentStep(marker: string, label: string): void {
    const elapsed = Date.now() - stepStartTime;
    hasActiveStep = false;
    writeCompletedLine(marker, label, elapsed);
  }

  return {
    step(label: string): void {
      if (destroyed) return;
      if (hasActiveStep) {
        completeCurrentStep(checkMark, currentLabel);
      }
      currentLabel = label;
      stepStartTime = Date.now();
      hasActiveStep = true;
      writeStartedLine(label);
    },

    done(label: string): void {
      if (destroyed) return;
      if (hasActiveStep) {
        completeCurrentStep(checkMark, label);
      } else {
        writeCompletedLine(checkMark, label, 0);
      }
      currentLabel = "";
    },

    fail(label: string): void {
      if (destroyed) return;
      if (hasActiveStep) {
        completeCurrentStep(crossMark, label);
      } else {
        writeCompletedLine(crossMark, label, 0);
      }
      currentLabel = "";
    },

    finish(summary: string): void {
      if (destroyed) return;
      if (hasActiveStep) {
        completeCurrentStep(checkMark, currentLabel);
      }
      write(`\n  ${summary}\n`);
      destroyed = true;
    },

    destroy(): void {
      destroyed = true;
      hasActiveStep = false;
      currentLabel = "";
    },
  };
}

export function createEvolveTUI(opts: { skillName: string; model: string }): EvolveTUI {
  const noColor = !!process.env.NO_COLOR;
  const isTTY = !!process.stderr.isTTY;
  const isTestEnvironment = process.env.BUN_ENV?.includes("test");

  // Non-interactive agent runs still need durable progress lines. Keep tests
  // silent by default unless explicitly forced.
  if (!isTTY && !process.env.SELFTUNE_TUI_FORCE) {
    return isTestEnvironment ? createNoopTUI() : createPlainTextTUI(opts);
  }

  const write = (s: string) => process.stderr.write(s);

  let spinnerFrame = 0;
  let stepStartTime = Date.now();
  let currentLabel = "";
  let hasActiveSpinner = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

  const checkMark = noColor ? "+" : "\u2713";
  const crossMark = noColor ? "x" : "\u2717";

  // Print header
  write(`\n  selftune evolve \u2500\u2500 ${opts.skillName} \u2500\u2500 ${opts.model}\n\n`);

  function formatTime(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function clearSpinnerLine(): void {
    if (hasActiveSpinner) {
      write("\x1b[A\x1b[2K");
    }
  }

  function writeSpinnerLine(): void {
    const frame = noColor ? ">" : SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    const elapsed = formatTime(Date.now() - stepStartTime);
    const padding = Math.max(1, 48 - currentLabel.length);
    write(`  ${frame} ${currentLabel}${" ".repeat(padding)}${elapsed}\n`);
    hasActiveSpinner = true;
  }

  function startSpinner(label: string): void {
    currentLabel = label;
    stepStartTime = Date.now();
    spinnerFrame = 0;
    writeSpinnerLine();
    intervalId = setInterval(() => {
      spinnerFrame++;
      clearSpinnerLine();
      writeSpinnerLine();
    }, TICK_MS);
  }

  function stopSpinner(): void {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function writeCompletedLine(marker: string, label: string, elapsed: number): void {
    const time = formatTime(elapsed);
    const padding = Math.max(1, 48 - label.length);
    write(`  ${marker} ${label}${" ".repeat(padding)}${time}\n`);
  }

  function completeCurrentStep(marker: string, label: string): void {
    const elapsed = Date.now() - stepStartTime;
    stopSpinner();
    clearSpinnerLine();
    hasActiveSpinner = false;
    writeCompletedLine(marker, label, elapsed);
  }

  return {
    step(label: string): void {
      if (destroyed) return;
      // Complete previous step if there was one
      if (hasActiveSpinner) {
        completeCurrentStep(checkMark, currentLabel);
      }
      startSpinner(label);
    },

    done(label: string): void {
      if (destroyed) return;
      if (hasActiveSpinner) {
        // Complete active spinner with custom label
        completeCurrentStep(checkMark, label);
      } else {
        // No active spinner — instant step
        writeCompletedLine(checkMark, label, 0);
      }
      currentLabel = "";
    },

    fail(label: string): void {
      if (destroyed) return;
      if (hasActiveSpinner) {
        completeCurrentStep(crossMark, label);
      } else {
        writeCompletedLine(crossMark, label, 0);
      }
      currentLabel = "";
    },

    finish(summary: string): void {
      if (destroyed) return;
      if (hasActiveSpinner) {
        completeCurrentStep(checkMark, currentLabel);
      }
      stopSpinner();
      write(`\n  ${summary}\n`);
      destroyed = true;
    },

    destroy(): void {
      if (destroyed) return;
      stopSpinner();
      if (hasActiveSpinner) {
        clearSpinnerLine();
        hasActiveSpinner = false;
      }
      destroyed = true;
    },
  };
}
