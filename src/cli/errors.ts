/**
 * Standardized CLI error handling.
 *
 * Provides consistent error reporting and exit codes across all CLI commands.
 */

/** Exit codes matching the documented behavior */
export const EXIT_CODES = {
  SUCCESS: 0,
  TASK_FAILED: 1,
  INFRA_ERROR: 2,
} as const;

/**
 * Handle a CLI error with consistent formatting and exit code.
 *
 * @param message - User-facing error message
 * @param details - Optional technical details (shown in verbose mode)
 * @param exitCode - Exit code (default: TASK_FAILED)
 */
export function cliError(
  message: string,
  details?: string,
  exitCode: number = EXIT_CODES.TASK_FAILED,
): never {
  console.error(`\n❌ ${message}`);
  if (details) {
    console.error(`   ${details}`);
  }
  process.exit(exitCode);
}

/**
 * Handle a validation error with field-specific context.
 */
export function validationError(field: string, message: string, fix: string): never {
  console.error(`\n❌ Validation error: ${field}`);
  console.error(`   ${message}`);
  console.error(`   Fix: ${fix}`);
  process.exit(EXIT_CODES.TASK_FAILED);
}

/**
 * Handle a "not found" error with suggestions.
 */
export function notFoundError(resource: string, id: string, suggestion?: string): never {
  console.error(`\n❌ ${resource} not found: ${id}`);
  if (suggestion) {
    console.error(`\n${suggestion}`);
  }
  process.exit(EXIT_CODES.TASK_FAILED);
}

/**
 * Handle an infrastructure error (budget exceeded, timeout, etc.).
 */
export function infraError(message: string, details?: string): never {
  console.error(`\n❌ Infrastructure error: ${message}`);
  if (details) {
    console.error(`   ${details}`);
  }
  process.exit(EXIT_CODES.INFRA_ERROR);
}

/**
 * Print a success message.
 */
export function cliSuccess(message: string): void {
  console.log(`✅ ${message}`);
}

/**
 * Print a warning message.
 */
export function cliWarning(message: string): void {
  console.warn(`⚠️  ${message}`);
}

/**
 * Print an info message.
 */
export function cliInfo(message: string): void {
  console.log(`ℹ️  ${message}`);
}
