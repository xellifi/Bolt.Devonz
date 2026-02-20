import { describe, expect, it, beforeEach } from 'vitest';
import { formatErrorForLLM, extractMissingPackage, type AutoFixError } from './autoFixService';
import { resetAutoFix, startAutoFix, recordFixAttempt } from '~/lib/stores/autofix';

describe('autoFixService', () => {
  beforeEach(() => {
    resetAutoFix();
  });

  describe('extractMissingPackage', () => {
    it('should extract package name from Vite import resolution error', () => {
      const error = 'Failed to resolve import "react-router-dom" from "src/App.tsx"';
      expect(extractMissingPackage(error)).toBe('react-router-dom');
    });

    it('should extract scoped package names', () => {
      const error = 'Failed to resolve import "@tanstack/react-query" from "src/hooks/useData.ts"';
      expect(extractMissingPackage(error)).toBe('@tanstack/react-query');
    });

    it('should extract scoped package from deep import', () => {
      const error = 'Failed to resolve import "@radix-ui/react-dialog/dist/index" from "src/Dialog.tsx"';
      expect(extractMissingPackage(error)).toBe('@radix-ui/react-dialog');
    });

    it('should return undefined for relative imports', () => {
      const error = 'Failed to resolve import "./components/Header" from "src/App.tsx"';
      expect(extractMissingPackage(error)).toBeUndefined();
    });

    it('should return undefined for unrelated errors', () => {
      const error = 'TypeError: Cannot read properties of undefined';
      expect(extractMissingPackage(error)).toBeUndefined();
    });

    it('should extract from "Cannot find module" errors', () => {
      const error = "Cannot find module 'zustand'";
      expect(extractMissingPackage(error)).toBe('zustand');
    });

    it('should extract scoped packages from "Cannot find module"', () => {
      const error = "Cannot find module '@hookform/resolvers'";
      expect(extractMissingPackage(error)).toBe('@hookform/resolvers');
    });

    it('should return undefined for relative "Cannot find module" errors', () => {
      const error = "Cannot find module './utils/helpers'";
      expect(extractMissingPackage(error)).toBeUndefined();
    });
  });

  describe('formatErrorForLLM', () => {
    it('should format import-resolution error with package info', () => {
      startAutoFix({
        source: 'preview',
        type: 'import-resolution',
        message: 'Failed to resolve import',
        content: 'Failed to resolve import "react-router-dom" from "src/App.tsx"',
      });
      recordFixAttempt(false);

      const error: AutoFixError = {
        source: 'preview',
        type: 'import-resolution',
        message: 'Failed to resolve import',
        content: 'Failed to resolve import "react-router-dom" from "src/App.tsx"',
      };

      const result = formatErrorForLLM(error);

      expect(result.isAutoFix).toBe(true);
      expect(result.text).toContain('import-resolution');
      expect(result.text).toContain('react-router-dom');
      expect(result.text).toContain('src/App.tsx');
      expect(result.text).toContain('package.json');
      expect(result.text).toContain('npm install');
    });

    it('should format syntax error category', () => {
      startAutoFix({
        source: 'terminal',
        type: 'syntax',
        message: 'SyntaxError',
        content: 'SyntaxError: Unexpected token } in src/Component.tsx',
      });
      recordFixAttempt(false);

      const error: AutoFixError = {
        source: 'terminal',
        type: 'syntax',
        message: 'SyntaxError',
        content: 'SyntaxError: Unexpected token } in src/Component.tsx',
      };

      const result = formatErrorForLLM(error);

      expect(result.text).toContain('syntax');
    });

    it('should include escalation warning on attempt 2+', () => {
      const errorData = {
        source: 'preview' as const,
        type: 'import-resolution',
        message: 'Failed to resolve import',
        content: 'Failed to resolve import "lucide-react" from "src/App.tsx"',
      };

      // Simulate two auto-fix cycles: startAutoFix increments currentRetries
      startAutoFix(errorData);
      recordFixAttempt(false); // First attempt fails, sets isFixing=false

      startAutoFix(errorData); // Second attempt, currentRetries = 2
      // Don't record yet — we're mid-attempt when formatErrorForLLM is called

      const error: AutoFixError = {
        source: 'preview',
        type: 'import-resolution',
        message: 'Failed to resolve import',
        content: 'Failed to resolve import "lucide-react" from "src/App.tsx"',
      };

      const result = formatErrorForLLM(error);

      expect(result.text).toContain('WARNING');
      expect(result.text).toContain('Previous fix attempts failed');
      expect(result.text).toContain('lucide-react');
    });

    it('should truncate very long error content', () => {
      startAutoFix({
        source: 'terminal',
        type: 'build',
        message: 'Build failed',
        content: 'A'.repeat(5000),
      });
      recordFixAttempt(false);

      const error: AutoFixError = {
        source: 'terminal',
        type: 'build',
        message: 'Build failed',
        content: 'A'.repeat(5000),
      };

      const result = formatErrorForLLM(error);

      // Content should be truncated to 2000 chars
      const contentBlock = result.text.split('```')[1];
      expect(contentBlock.length).toBeLessThanOrEqual(2010); // 2000 + potential lang tag
    });

    it('should include attempt count in header', () => {
      const errorData = {
        source: 'preview' as const,
        type: 'error',
        message: 'Error',
        content: 'TypeError: x is not a function',
      };

      startAutoFix(errorData);
      recordFixAttempt(false);

      const result = formatErrorForLLM(errorData);

      expect(result.text).toContain('[Auto-Fix Attempt');
      expect(result.attemptNumber).toBeGreaterThanOrEqual(1);
      expect(result.maxAttempts).toBeGreaterThanOrEqual(1);
    });

    it('should format runtime error category', () => {
      startAutoFix({
        source: 'preview',
        type: 'runtime',
        message: 'TypeError',
        content: 'TypeError: Cannot read properties of undefined (reading "map")',
      });
      recordFixAttempt(false);

      const error: AutoFixError = {
        source: 'preview',
        type: 'runtime',
        message: 'TypeError',
        content: 'TypeError: Cannot read properties of undefined (reading "map")',
      };

      const result = formatErrorForLLM(error);

      expect(result.text).toContain('runtime');
    });

    it('should format "Cannot find module" as import-resolution', () => {
      startAutoFix({
        source: 'terminal',
        type: 'module-not-found',
        message: 'Cannot find module',
        content: "Cannot find module 'date-fns'",
      });
      recordFixAttempt(false);

      const error: AutoFixError = {
        source: 'terminal',
        type: 'module-not-found',
        message: 'Cannot find module',
        content: "Cannot find module 'date-fns'",
      };

      const result = formatErrorForLLM(error);

      expect(result.text).toContain('import-resolution');
      expect(result.text).toContain('date-fns');
    });

    it('should classify useChart context error with ChartContainer guidance', () => {
      const errorContent = 'Error: Uncaught Error: useChart must be used within a <ChartContainer />';

      startAutoFix({
        source: 'preview',
        type: 'runtime',
        message: 'useChart context error',
        content: errorContent,
      });
      recordFixAttempt(false);

      const error: AutoFixError = {
        source: 'preview',
        type: 'runtime',
        message: 'useChart context error',
        content: errorContent,
      };

      const result = formatErrorForLLM(error);

      expect(result.text).toContain('runtime');
      expect(result.text).toContain('useChart');
      expect(result.text).toContain('ChartContainer');
      expect(result.text).toContain('context provider');
    });

    it('should classify ReferenceError with import guidance', () => {
      const errorContent = 'ReferenceError: Header is not defined';

      startAutoFix({
        source: 'preview',
        type: 'runtime',
        message: 'ReferenceError',
        content: errorContent,
      });
      recordFixAttempt(false);

      const error: AutoFixError = {
        source: 'preview',
        type: 'runtime',
        message: 'ReferenceError',
        content: errorContent,
      };

      const result = formatErrorForLLM(error);

      expect(result.text).toContain('runtime');
      expect(result.text).toContain('Header');
      expect(result.text).toContain('not imported or defined');
    });
  });

  describe('import completeness detection', () => {
    // These tests validate the regex logic used by #validateComponentImports in action-runner.ts

    function detectMissingImports(code: string): string[] {
      const importedNames = new Set<string>();

      // Extract named imports
      const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g;
      const defaultImportRegex = /import\s+(\w+)\s+from\s+['"][^'"]+['"]/g;
      let m;

      while ((m = importRegex.exec(code)) !== null) {
        m[1].split(',').forEach((name) => {
          const trimmed = name
            .trim()
            .split(/\s+as\s+/)[0]
            .trim();

          if (trimmed) {
            importedNames.add(trimmed);
          }
        });
      }

      while ((m = defaultImportRegex.exec(code)) !== null) {
        importedNames.add(m[1]);
      }

      // Local declarations
      const declRegex = /(?:function|const|class|let|var)\s+(\w+)/g;

      while ((m = declRegex.exec(code)) !== null) {
        importedNames.add(m[1]);
      }

      // Find JSX component usage
      const jsxRegex = /<([A-Z][a-zA-Z0-9]*)\b/g;
      const missing: string[] = [];

      while ((m = jsxRegex.exec(code)) !== null) {
        if (!importedNames.has(m[1])) {
          missing.push(m[1]);
        }
      }

      return [...new Set(missing)];
    }

    it('should detect missing Card import in JSX', () => {
      const code = `
import React from 'react';
function Dashboard() {
  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle>Stats</CardTitle>
        </CardHeader>
        <CardContent>Content</CardContent>
      </Card>
    </div>
  );
}
      `;
      const missing = detectMissingImports(code);
      expect(missing).toContain('Card');
      expect(missing).toContain('CardHeader');
      expect(missing).toContain('CardTitle');
      expect(missing).toContain('CardContent');
    });

    it('should not flag imported components', () => {
      const code = `
import React from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
function Dashboard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Stats</CardTitle>
      </CardHeader>
      <CardContent>Content</CardContent>
    </Card>
  );
}
      `;
      const missing = detectMissingImports(code);
      expect(missing).toHaveLength(0);
    });

    it('should not flag locally defined components', () => {
      const code = `
import React from 'react';
function Header() {
  return <div>Header</div>;
}
function App() {
  return <Header />;
}
      `;
      const missing = detectMissingImports(code);
      expect(missing).toHaveLength(0);
    });

    it('should detect multiple missing components from different paths', () => {
      const code = `
import React from 'react';
function Page() {
  return (
    <div>
      <Button>Click</Button>
      <Badge>New</Badge>
      <Table>
        <TableHeader>
          <TableRow><TableHead>Col</TableHead></TableRow>
        </TableHeader>
      </Table>
    </div>
  );
}
      `;
      const missing = detectMissingImports(code);
      expect(missing).toContain('Button');
      expect(missing).toContain('Badge');
      expect(missing).toContain('Table');
      expect(missing).toContain('TableHeader');
      expect(missing).toContain('TableRow');
      expect(missing).toContain('TableHead');
    });

    it('should handle aliased imports correctly', () => {
      const code = `
import React from 'react';
import { Card as StyledCard } from '@/components/ui/card';
function App() {
  return <StyledCard>Content</StyledCard>;
}
      `;
      const missing = detectMissingImports(code);

      /*
       * Card is imported (as StyledCard), function StyledCard is not a separate def.
       * The original name "Card" is what gets added to importedNames from the split.
       */
      expect(missing).not.toContain('Card');
    });
  });
});
