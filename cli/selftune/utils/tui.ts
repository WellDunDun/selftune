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

export function createEvolveTUI(opts: { skillName: string; model: string }): EvolveTUI {
  const noColor = !!process.env.NO_COLOR;
  const isTTY = !!process.stderr.isTTY;

  // If not a TTY, return no-op to avoid ANSI noise in pipes/tests
  if (!isTTY && !process.env.SELFTUNE_TUI_FORCE) {
    return createNoopTUI();
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
