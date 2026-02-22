import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isBinaryFile,
  shouldIncludeFile,
  generateId,
  MAX_FILES,
  IGNORE_PATTERNS,
  ig,
  detectProjectType,
  filesToArtifacts,
} from './fileUtils';

describe('fileUtils', () => {
  describe('IGNORE_PATTERNS', () => {
    it('should include node_modules', () => {
      expect(IGNORE_PATTERNS).toContain('node_modules/**');
    });

    it('should include .git', () => {
      expect(IGNORE_PATTERNS).toContain('.git/**');
    });

    it('should include common build directories', () => {
      expect(IGNORE_PATTERNS).toContain('dist/**');
      expect(IGNORE_PATTERNS).toContain('build/**');
      expect(IGNORE_PATTERNS).toContain('.next/**');
    });

    it('should include log files', () => {
      expect(IGNORE_PATTERNS).toContain('**/*.log');
    });
  });

  describe('MAX_FILES', () => {
    it('should be 1000', () => {
      expect(MAX_FILES).toBe(1000);
    });
  });

  describe('generateId', () => {
    it('should generate a string', () => {
      const id = generateId();
      expect(typeof id).toBe('string');
    });

    it('should generate unique ids', () => {
      const ids = new Set<string>();

      for (let i = 0; i < 100; i++) {
        ids.add(generateId());
      }
      expect(ids.size).toBe(100);
    });

    it('should generate alphanumeric ids', () => {
      const id = generateId();
      expect(id).toMatch(/^[a-z0-9]+$/);
    });

    it('should generate ids with reasonable length', () => {
      const id = generateId();
      expect(id.length).toBeGreaterThan(5);
      expect(id.length).toBeLessThan(20);
    });
  });

  describe('shouldIncludeFile', () => {
    it('should include regular source files', () => {
      expect(shouldIncludeFile('src/index.ts')).toBe(true);
      expect(shouldIncludeFile('app/component.tsx')).toBe(true);
      expect(shouldIncludeFile('styles.css')).toBe(true);
    });

    it('should exclude node_modules', () => {
      expect(shouldIncludeFile('node_modules/package/index.js')).toBe(false);
    });

    it('should exclude .git directory', () => {
      expect(shouldIncludeFile('.git/config')).toBe(false);
      expect(shouldIncludeFile('.git/HEAD')).toBe(false);
    });

    it('should exclude dist directory', () => {
      expect(shouldIncludeFile('dist/bundle.js')).toBe(false);
    });

    it('should exclude build directory', () => {
      expect(shouldIncludeFile('build/index.html')).toBe(false);
    });

    it('should exclude log files', () => {
      expect(shouldIncludeFile('error.log')).toBe(false);
      expect(shouldIncludeFile('debug.log')).toBe(false);
    });

    it('should exclude .DS_Store', () => {
      expect(shouldIncludeFile('.DS_Store')).toBe(false);
      expect(shouldIncludeFile('some/folder/.DS_Store')).toBe(false);
    });

    it('should exclude coverage directory', () => {
      expect(shouldIncludeFile('coverage/lcov-report/index.html')).toBe(false);
    });

    it('should exclude .next directory', () => {
      expect(shouldIncludeFile('.next/cache/webpack/client.json')).toBe(false);
    });

    it('should exclude npm debug logs', () => {
      expect(shouldIncludeFile('npm-debug.log')).toBe(false);
      expect(shouldIncludeFile('npm-debug.log.1')).toBe(false);
    });
  });

  describe('isBinaryFile', () => {
    it('should detect text file as non-binary', async () => {
      const textContent = new Blob(['Hello, world!'], { type: 'text/plain' });
      const file = new File([textContent], 'test.txt', { type: 'text/plain' });

      const result = await isBinaryFile(file);
      expect(result).toBe(false);
    });

    it('should detect file with null bytes as binary', async () => {
      const binaryContent = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      const file = new File([binaryContent], 'test.bin', { type: 'application/octet-stream' });

      const result = await isBinaryFile(file);
      expect(result).toBe(true);
    });

    it('should detect file with control characters as binary', async () => {
      // Control characters below 32 (except tab, newline, carriage return)
      const binaryContent = new Uint8Array([0x01, 0x02, 0x03]);
      const file = new File([binaryContent], 'test.bin', { type: 'application/octet-stream' });

      const result = await isBinaryFile(file);
      expect(result).toBe(true);
    });

    it('should allow tab characters in text files', async () => {
      const textContent = new Blob(['line1\tcolumn2\nline2'], { type: 'text/plain' });
      const file = new File([textContent], 'test.txt', { type: 'text/plain' });

      const result = await isBinaryFile(file);
      expect(result).toBe(false);
    });

    it('should allow newline characters', async () => {
      const textContent = new Blob(['line1\nline2\r\nline3'], { type: 'text/plain' });
      const file = new File([textContent], 'test.txt', { type: 'text/plain' });

      const result = await isBinaryFile(file);
      expect(result).toBe(false);
    });

    it('should handle empty file', async () => {
      const file = new File([], 'empty.txt', { type: 'text/plain' });

      const result = await isBinaryFile(file);
      expect(result).toBe(false);
    });

    it('should only check first 1024 bytes', async () => {
      // Large text file should be fast because we only check first chunk
      const largeContent = 'a'.repeat(10000);
      const file = new File([largeContent], 'large.txt', { type: 'text/plain' });

      const startTime = performance.now();
      const result = await isBinaryFile(file);
      const endTime = performance.now();

      expect(result).toBe(false);
      expect(endTime - startTime).toBeLessThan(100); // Should be fast
    });

    it('should detect JSON as non-binary', async () => {
      const jsonContent = JSON.stringify({ hello: 'world' });
      const file = new File([jsonContent], 'data.json', { type: 'application/json' });

      const result = await isBinaryFile(file);
      expect(result).toBe(false);
    });
  });

  describe('ig (ignore instance)', () => {
    it('should ignore node_modules paths', () => {
      expect(ig.ignores('node_modules/lodash/index.js')).toBe(true);
    });

    it('should ignore .git paths', () => {
      expect(ig.ignores('.git/HEAD')).toBe(true);
    });

    it('should not ignore regular source files', () => {
      expect(ig.ignores('src/index.ts')).toBe(false);
    });

    it('should ignore .DS_Store in any directory', () => {
      expect(ig.ignores('foo/bar/.DS_Store')).toBe(true);
    });

    it('should ignore yarn error logs', () => {
      expect(ig.ignores('yarn-error.log')).toBe(true);
      expect(ig.ignores('yarn-error.log.1')).toBe(true);
    });

    it('should ignore .vscode directory', () => {
      expect(ig.ignores('.vscode/settings.json')).toBe(true);
    });

    it('should ignore .idea directory', () => {
      expect(ig.ignores('.idea/workspace.xml')).toBe(true);
    });

    it('should ignore .cache directory', () => {
      expect(ig.ignores('.cache/some-file')).toBe(true);
    });
  });

  describe('detectProjectType', () => {
    // Polyfill FileReader for Node.js test environment
    const ORIGINAL_FILE_READER = globalThis.FileReader;

    beforeAll(() => {
      if (!globalThis.FileReader) {
        // Minimal FileReader polyfill for tests
        globalThis.FileReader = class {
          result: string | null = null;
          onload: (() => void) | null = null;
          onerror: (() => void) | null = null;

          readAsText(blob: Blob) {
            blob.text().then((text) => {
              this.result = text;
              this.onload?.();
            });
          }
        } as unknown as typeof FileReader;
      }
    });

    afterAll(() => {
      if (ORIGINAL_FILE_READER) {
        globalThis.FileReader = ORIGINAL_FILE_READER;
      }
    });

    /**
     * Helper to create a mock File with webkitRelativePath set.
     * The standard File constructor does not accept webkitRelativePath,
     * so we use Object.defineProperty to set it.
     *
     * Also polyfills FileReader behavior for the test environment,
     * since Node.js does not have FileReader as a global.
     */
    function createMockFile(relativePath: string, content = ''): File {
      const file = new File([content], relativePath.split('/').pop() ?? relativePath, { type: 'text/plain' });
      Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, writable: false });

      return file;
    }

    it('should detect Node.js project with "dev" script', async () => {
      const packageJson = JSON.stringify({ scripts: { dev: 'vite', build: 'tsc && vite build' } });
      const files = [createMockFile('project/package.json', packageJson), createMockFile('project/src/index.ts')];

      const result = await detectProjectType(files);

      expect(result.type).toBe('Node.js');
      expect(result.setupCommand).toBe('npm install && npm run dev');
      expect(result.followupMessage).toContain('"dev"');
    });

    it('should detect Node.js project with "start" script when no "dev"', async () => {
      const packageJson = JSON.stringify({ scripts: { start: 'node server.js', build: 'tsc' } });
      const files = [createMockFile('project/package.json', packageJson)];

      const result = await detectProjectType(files);

      expect(result.type).toBe('Node.js');
      expect(result.setupCommand).toBe('npm install && npm run start');
      expect(result.followupMessage).toContain('"start"');
    });

    it('should detect Node.js project with "preview" script when no "dev" or "start"', async () => {
      const packageJson = JSON.stringify({ scripts: { preview: 'vite preview', build: 'tsc' } });
      const files = [createMockFile('project/package.json', packageJson)];

      const result = await detectProjectType(files);

      expect(result.type).toBe('Node.js');
      expect(result.setupCommand).toBe('npm install && npm run preview');
      expect(result.followupMessage).toContain('"preview"');
    });

    it('should prioritize "dev" over "start" and "preview"', async () => {
      const packageJson = JSON.stringify({ scripts: { dev: 'vite', start: 'node index.js', preview: 'vite preview' } });
      const files = [createMockFile('project/package.json', packageJson)];

      const result = await detectProjectType(files);

      expect(result.setupCommand).toBe('npm install && npm run dev');
    });

    it('should prioritize "start" over "preview" when no "dev"', async () => {
      const packageJson = JSON.stringify({ scripts: { start: 'node index.js', preview: 'vite preview' } });
      const files = [createMockFile('project/package.json', packageJson)];

      const result = await detectProjectType(files);

      expect(result.setupCommand).toBe('npm install && npm run start');
    });

    it('should fall back to npm install when package.json has no preferred scripts', async () => {
      const packageJson = JSON.stringify({ scripts: { build: 'tsc', lint: 'eslint .' } });
      const files = [createMockFile('project/package.json', packageJson)];

      const result = await detectProjectType(files);

      expect(result.type).toBe('Node.js');
      expect(result.setupCommand).toBe('npm install');
      expect(result.followupMessage).toContain('inspect package.json');
    });

    it('should fall back to npm install when package.json has no scripts key', async () => {
      const packageJson = JSON.stringify({ name: 'my-project', version: '1.0.0' });
      const files = [createMockFile('project/package.json', packageJson)];

      const result = await detectProjectType(files);

      expect(result.type).toBe('Node.js');
      expect(result.setupCommand).toBe('npm install');
    });

    it('should fall back to npm install when package.json has empty scripts', async () => {
      const packageJson = JSON.stringify({ scripts: {} });
      const files = [createMockFile('project/package.json', packageJson)];

      const result = await detectProjectType(files);

      expect(result.type).toBe('Node.js');
      expect(result.setupCommand).toBe('npm install');
    });

    it('should detect static project with index.html', async () => {
      const files = [createMockFile('project/index.html', '<html></html>'), createMockFile('project/style.css')];

      const result = await detectProjectType(files);

      expect(result.type).toBe('Static');
      expect(result.setupCommand).toBe('npx --yes serve');
      expect(result.followupMessage).toBe('');
    });

    it('should return empty values when no recognizable project files exist', async () => {
      const files = [createMockFile('project/README.md'), createMockFile('project/data.csv')];

      const result = await detectProjectType(files);

      expect(result.type).toBe('');
      expect(result.setupCommand).toBe('');
      expect(result.followupMessage).toBe('');
    });

    it('should prefer package.json over index.html when both exist', async () => {
      const packageJson = JSON.stringify({ scripts: { dev: 'vite' } });
      const files = [
        createMockFile('project/package.json', packageJson),
        createMockFile('project/index.html', '<html></html>'),
      ];

      const result = await detectProjectType(files);

      expect(result.type).toBe('Node.js');
    });

    it('should handle malformed package.json gracefully', async () => {
      const files = [createMockFile('project/package.json', 'not valid json {{{{')];

      const result = await detectProjectType(files);

      // readPackageJson returns null on error, so falls through to npm install fallback
      expect(result.type).toBe('Node.js');
      expect(result.setupCommand).toBe('npm install');
    });

    it('should handle empty file list', async () => {
      const result = await detectProjectType([]);

      expect(result.type).toBe('');
      expect(result.setupCommand).toBe('');
      expect(result.followupMessage).toBe('');
    });

    it('should match package.json in nested directories', async () => {
      const packageJson = JSON.stringify({ scripts: { start: 'node app.js' } });
      const files = [createMockFile('project/subdir/package.json', packageJson)];

      const result = await detectProjectType(files);

      expect(result.type).toBe('Node.js');
    });

    it('should match index.html in nested directories', async () => {
      const files = [createMockFile('project/public/index.html', '<html></html>')];

      const result = await detectProjectType(files);

      expect(result.type).toBe('Static');
    });
  });

  describe('filesToArtifacts', () => {
    it('should generate artifact XML for a single file', () => {
      const files = { 'src/index.ts': { content: 'console.log("hello");' } };
      const result = filesToArtifacts(files, 'test-id');

      expect(result).toContain('<devonzArtifact id="test-id"');
      expect(result).toContain('title="User Updated Files"');
      expect(result).toContain('<devonzAction type="file" filePath="src/index.ts">');
      expect(result).toContain('console.log("hello");');
      expect(result).toContain('</devonzAction>');
      expect(result).toContain('</devonzArtifact>');
    });

    it('should generate artifact XML for multiple files', () => {
      const files = {
        'src/index.ts': { content: 'export {}' },
        'src/utils.ts': { content: 'export const x = 1;' },
        'README.md': { content: '# Hello' },
      };
      const result = filesToArtifacts(files, 'multi-id');

      expect(result).toContain('filePath="src/index.ts"');
      expect(result).toContain('filePath="src/utils.ts"');
      expect(result).toContain('filePath="README.md"');
      expect(result).toContain('export {}');
      expect(result).toContain('export const x = 1;');
      expect(result).toContain('# Hello');
    });

    it('should handle empty files object', () => {
      const result = filesToArtifacts({}, 'empty-id');

      expect(result).toContain('<devonzArtifact id="empty-id"');
      expect(result).toContain('</devonzArtifact>');
      expect(result).not.toContain('<devonzAction');
    });

    it('should handle files with empty content', () => {
      const files = { 'empty.txt': { content: '' } };
      const result = filesToArtifacts(files, 'empty-content-id');

      expect(result).toContain('filePath="empty.txt"');
    });

    it('should preserve special characters in file content', () => {
      const files = { 'template.html': { content: '<div class="test">&amp;</div>' } };
      const result = filesToArtifacts(files, 'special-chars');

      expect(result).toContain('<div class="test">&amp;</div>');
    });

    it('should use the provided id in the artifact tag', () => {
      const files = { 'a.txt': { content: 'a' } };

      const result1 = filesToArtifacts(files, 'id-one');
      const result2 = filesToArtifacts(files, 'id-two');

      expect(result1).toContain('id="id-one"');
      expect(result2).toContain('id="id-two"');
    });

    it('should handle file paths with special characters', () => {
      const files = { 'src/my component/Widget.tsx': { content: 'export default {}' } };
      const result = filesToArtifacts(files, 'path-id');

      expect(result).toContain('filePath="src/my component/Widget.tsx"');
    });

    it('should handle multiline file content', () => {
      const content = 'line1\nline2\nline3';
      const files = { 'multi.txt': { content } };
      const result = filesToArtifacts(files, 'multiline-id');

      expect(result).toContain('line1\nline2\nline3');
    });
  });
});
