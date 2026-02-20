/**
 * Auto-Fix Service
 *
 * Core service that orchestrates the automatic error fixing loop.
 * Receives errors from detectors, formats them for the LLM, and
 * tracks fix attempts. Includes intelligent error classification
 * to provide the LLM with targeted fix instructions.
 */

import { createScopedLogger } from '~/utils/logger';
import {
  autoFixStore,
  getAutoFixStatus,
  getFixHistoryContext,
  markFixComplete,
  markFixFailed,
  resetAutoFix,
  type ErrorSource,
} from '~/lib/stores/autofix';
import { workbenchStore } from '~/lib/stores/workbench';

const logger = createScopedLogger('AutoFixService');

/**
 * Error context for auto-fix
 */
export interface AutoFixError {
  source: ErrorSource;
  type: string;
  message: string;
  content: string;
}

/**
 * Classified error with actionable context
 */
interface ClassifiedError {
  category: 'import-resolution' | 'syntax' | 'type' | 'runtime' | 'build' | 'unknown';
  missingPackage?: string;
  sourceFile?: string;
  fixInstructions: string;
}

/**
 * Formatted message for sending to chat
 */
export interface AutoFixMessage {
  text: string;
  isAutoFix: true;
  attemptNumber: number;
  maxAttempts: number;
}

/**
 * Classify an error to determine the best fix strategy.
 * Returns structured data including the error category and specific fix instructions.
 */
function classifyError(error: AutoFixError): ClassifiedError {
  const content = error.content;

  // Pattern: Failed to resolve import "package" from "file"
  const importResolutionMatch = content.match(/Failed to resolve import ["']([^"']+)["'] from ["']([^"']+)["']/);

  if (importResolutionMatch) {
    const [, pkg, sourceFile] = importResolutionMatch;

    // Determine if it's an npm package (no ./ or ../ prefix) or a local file
    const isNpmPackage = !pkg.startsWith('.') && !pkg.startsWith('/');
    const packageName = isNpmPackage
      ? pkg
          .split('/')
          .slice(0, pkg.startsWith('@') ? 2 : 1)
          .join('/')
      : undefined;

    if (packageName) {
      return {
        category: 'import-resolution',
        missingPackage: packageName,
        sourceFile,
        fixInstructions: [
          `**Root Cause**: The npm package \`${packageName}\` is imported in \`${sourceFile}\` but is NOT installed.`,
          '',
          '**Required Fix** (do ALL three steps):',
          `1. Add \`"${packageName}": "latest"\` to the \`"dependencies"\` object in \`package.json\` (use a file action, NOT npm install <pkg>)`,
          '2. Run `npm install --legacy-peer-deps` as a shell action',
          '3. Run `npm run dev` as a start action to restart the dev server',
          '',
          '**CRITICAL**: Do NOT modify the import statement in the source file — the import is correct, the package just needs to be installed.',
          '**CRITICAL**: Do NOT rewrite package.json from scratch — only ADD the missing package to the existing dependencies.',
        ].join('\n'),
      };
    }

    // Local file import resolution error
    return {
      category: 'import-resolution',
      sourceFile,
      fixInstructions: [
        `**Root Cause**: The import \`${pkg}\` in \`${sourceFile}\` points to a file that doesn't exist.`,
        '',
        '**Required Fix**:',
        `1. Either create the missing file at the expected path, OR`,
        `2. Fix the import path in \`${sourceFile}\` to point to the correct location`,
        '',
        'Verify the relative path is correct by counting directory levels.',
      ].join('\n'),
    };
  }

  // Pattern: Cannot find module 'package'
  const moduleNotFoundMatch = content.match(/Cannot find module ['"]([^'"]+)['"]/);

  if (moduleNotFoundMatch) {
    const pkg = moduleNotFoundMatch[1];
    const isNpmPackage = !pkg.startsWith('.') && !pkg.startsWith('/');

    if (isNpmPackage) {
      const packageName = pkg
        .split('/')
        .slice(0, pkg.startsWith('@') ? 2 : 1)
        .join('/');

      return {
        category: 'import-resolution',
        missingPackage: packageName,
        fixInstructions: [
          `**Root Cause**: Module \`${packageName}\` is not installed.`,
          '',
          '**Required Fix**:',
          `1. Add \`"${packageName}": "latest"\` to package.json dependencies`,
          '2. Run `npm install --legacy-peer-deps`',
          '3. Restart the dev server with `npm run dev`',
        ].join('\n'),
      };
    }
  }

  // Pattern: SyntaxError or parse errors
  if (content.includes('SyntaxError') || content.includes('Unexpected token') || content.includes('Parse error')) {
    return {
      category: 'syntax',
      fixInstructions:
        'Fix the syntax error in the indicated file. Check for missing brackets, semicolons, or invalid JSX.',
    };
  }

  // Pattern: React hook context errors (e.g. "useChart must be used within a <ChartContainer />")
  const hookContextMatch = content.match(/(?:Uncaught Error:\s*)?(\w+)\s+must be used within (?:a\s+)?<(\w+)/);

  if (hookContextMatch) {
    const [, hookName, wrapperComponent] = hookContextMatch;

    return {
      category: 'runtime',
      fixInstructions: [
        `**Root Cause**: The hook \`${hookName}\` requires a \`<${wrapperComponent}>\` ancestor component as a context provider.`,
        '',
        '**Required Fix**:',
        `1. Find the component that calls \`${hookName}()\` or uses a component that internally calls it`,
        `2. Wrap that component (or its chart/content) with \`<${wrapperComponent}>\``,
        `3. If using shadcn/ui charts: wrap recharts components (BarChart, LineChart, etc.) inside \`<ChartContainer config={chartConfig}>\` — NEVER use bare recharts components`,
        '',
        '**Example pattern for shadcn/ui charts**:',
        '```tsx',
        'import { ChartContainer, type ChartConfig } from "@/components/ui/chart"',
        'const config: ChartConfig = { value: { label: "Value", color: "#8884d8" } }',
        '<ChartContainer config={config}>',
        '  <BarChart data={data}><Bar dataKey="value" /></BarChart>',
        '</ChartContainer>',
        '```',
      ].join('\n'),
    };
  }

  // Pattern: "X is not defined" reference errors (e.g. missing imports/components)
  const referenceErrorMatch = content.match(/(?:ReferenceError|Uncaught ReferenceError):\s*(\w+)\s+is not defined/);

  if (referenceErrorMatch) {
    const [, identifier] = referenceErrorMatch;

    return {
      category: 'runtime',
      fixInstructions: [
        `**Root Cause**: \`${identifier}\` is used but not imported or defined in the current scope.`,
        '',
        '**Required Fix**:',
        `1. Add the missing import statement for \`${identifier}\` at the top of the file`,
        `2. If \`${identifier}\` is a component, import it from the correct path (e.g., \`import { ${identifier} } from '@/components/${identifier.toLowerCase()}'\`)`,
        `3. If \`${identifier}\` is a variable/function, ensure it's defined before use`,
      ].join('\n'),
    };
  }

  // Pattern: TypeError
  if (content.includes('TypeError') || content.includes('is not a function') || content.includes('is not defined')) {
    return {
      category: 'runtime',
      fixInstructions:
        'Fix the runtime error. Check that all variables and functions are properly defined and imported.',
    };
  }

  // Pattern: Type errors (TypeScript)
  if (content.includes('TS2') || content.includes('Type ') || content.includes('type error')) {
    return {
      category: 'type',
      fixInstructions: 'Fix the TypeScript type error. Ensure proper typing and interface compatibility.',
    };
  }

  return {
    category: 'unknown',
    fixInstructions: 'Please analyze and fix this error.',
  };
}

/**
 * Format an error for sending to the LLM via chat.
 * Includes intelligent error classification and targeted fix instructions.
 */
export function formatErrorForLLM(error: AutoFixError): AutoFixMessage {
  const status = getAutoFixStatus();
  const historyContext = getFixHistoryContext();
  const classified = classifyError(error);

  // Determine source label
  const sourceLabel = error.source === 'terminal' ? 'terminal' : error.source === 'preview' ? 'preview' : 'build';

  // Build the message text
  const lines: string[] = [];

  // Header with attempt count
  lines.push(`[Auto-Fix Attempt ${status.currentAttempt}/${status.maxAttempts}]`);
  lines.push('');
  lines.push(`*Automatically fixing ${sourceLabel} error (${classified.category})*`);
  lines.push('');

  // Error details
  lines.push(`**Error Type**: ${error.type}`);
  lines.push(`**Error Category**: ${classified.category}`);

  if (classified.missingPackage) {
    lines.push(`**Missing Package**: \`${classified.missingPackage}\``);
  }

  if (classified.sourceFile) {
    lines.push(`**Source File**: \`${classified.sourceFile}\``);
  }

  lines.push('');
  lines.push('**Error Output**:');
  lines.push('```' + (error.source === 'preview' ? 'js' : 'sh'));
  lines.push(error.content.slice(0, 2000));
  lines.push('```');

  // Add targeted fix instructions based on classification
  lines.push('');
  lines.push('---');
  lines.push(classified.fixInstructions);

  // Add history context if there were previous attempts
  if (historyContext) {
    lines.push('');
    lines.push('---');
    lines.push(historyContext);
  }

  // Add escalation for repeated failures
  if (status.currentAttempt >= 2) {
    lines.push('');
    lines.push(
      '**WARNING**: Previous fix attempts failed. Please carefully re-read the error and fix instructions above.',
    );

    if (classified.category === 'import-resolution' && classified.missingPackage) {
      lines.push(
        `Ensure \`${classified.missingPackage}\` is in package.json \`"dependencies"\` AND that \`npm install\` runs successfully.`,
      );
    }
  }

  return {
    text: lines.join('\n'),
    isAutoFix: true,
    attemptNumber: status.currentAttempt,
    maxAttempts: status.maxAttempts,
  };
}

/**
 * Extract missing package name from an import resolution error.
 * Returns the package name if detectable, or undefined.
 */
export function extractMissingPackage(errorContent: string): string | undefined {
  const match = errorContent.match(/Failed to resolve import ["']([^"']+)["']/);

  if (match) {
    const importPath = match[1];

    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
      return importPath
        .split('/')
        .slice(0, importPath.startsWith('@') ? 2 : 1)
        .join('/');
    }
  }

  const moduleMatch = errorContent.match(/Cannot find module ['"]([^'"]+)['"]/);

  if (moduleMatch) {
    const pkg = moduleMatch[1];

    if (!pkg.startsWith('.') && !pkg.startsWith('/')) {
      return pkg
        .split('/')
        .slice(0, pkg.startsWith('@') ? 2 : 1)
        .join('/');
    }
  }

  return undefined;
}

/**
 * Handle successful fix (no more errors detected after fix)
 * Call this when the error is resolved
 */
export function handleFixSuccess(): void {
  logger.info('Auto-fix successful - error resolved');
  markFixComplete();

  // Clear the terminal/preview error alert since the fix succeeded
  workbenchStore.clearAlert();

  // Optionally show success notification
  const state = autoFixStore.get();

  if (state.settings.showNotifications) {
    // Could trigger a toast notification here
    logger.info('Fix completed successfully');
  }
}

/**
 * Handle failed fix (error still present or new error)
 * Call this when the same/similar error is detected after fix attempt
 */
export function handleFixFailure(): void {
  const status = getAutoFixStatus();
  logger.info(`Auto-fix attempt ${status.currentAttempt} failed`);

  markFixFailed();

  // Check if we should continue
  if (status.currentAttempt >= status.maxAttempts) {
    logger.warn('Max auto-fix attempts reached, stopping');

    // The terminal error detector will now show the alert to user
  }
}

/**
 * Cancel ongoing auto-fix session
 * Call this when user manually intervenes or closes the chat
 */
export function cancelAutoFix(): void {
  logger.info('Auto-fix cancelled by user');
  resetAutoFix();
}

/**
 * Check if auto-fix is currently active
 */
export function isAutoFixActive(): boolean {
  return getAutoFixStatus().isActive;
}

/**
 * Get the current auto-fix attempt number
 */
export function getCurrentAttempt(): number {
  return getAutoFixStatus().currentAttempt;
}

/**
 * Get summary of auto-fix session for display
 */
export function getAutoFixSummary(): string {
  const state = autoFixStore.get();

  if (!state.isFixing && state.fixHistory.length === 0) {
    return 'No auto-fix activity';
  }

  const successCount = state.fixHistory.filter((a) => a.wasSuccessful).length;
  const failCount = state.fixHistory.filter((a) => !a.wasSuccessful).length;

  if (state.isFixing) {
    return `Auto-fixing... (Attempt ${state.currentRetries}/${state.settings.maxRetries})`;
  }

  if (successCount > 0) {
    return `Fixed after ${state.currentRetries} attempt(s)`;
  }

  return `Failed after ${failCount} attempt(s)`;
}

/**
 * Create the auto-fix callback function for the terminal error detector
 * This returns a function that can be registered with the detector
 */
export function createAutoFixHandler(sendMessage: (message: string) => void): (error: AutoFixError) => Promise<void> {
  return async (error: AutoFixError): Promise<void> => {
    logger.info('Auto-fix handler triggered', { type: error.type, source: error.source });

    // Format the error for the LLM
    const formattedMessage = formatErrorForLLM(error);

    // Send the fix request via chat
    sendMessage(formattedMessage.text);
  };
}
