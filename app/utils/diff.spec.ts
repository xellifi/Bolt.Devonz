import { describe, expect, it } from 'vitest';
import {
  extractRelativePath,
  diffFiles,
  computeFileModifications,
  fileModificationsToHTML,
  modificationsRegex,
} from './diff';
import { WORK_DIR, MODIFICATIONS_TAG_NAME } from './constants';
import type { FileMap } from '~/lib/stores/files';

describe('extractRelativePath', () => {
  it('should strip out WORK_DIR prefix', () => {
    const filePath = `${WORK_DIR}/index.js`;
    const result = extractRelativePath(filePath);
    expect(result).toBe('index.js');
  });

  it('should strip WORK_DIR from nested paths', () => {
    expect(extractRelativePath(`${WORK_DIR}/src/components/App.tsx`)).toBe('src/components/App.tsx');
  });

  it('should return the path unchanged if WORK_DIR is not a prefix', () => {
    expect(extractRelativePath('/other/dir/file.js')).toBe('/other/dir/file.js');
  });

  it('should return empty string when path is exactly WORK_DIR/', () => {
    expect(extractRelativePath(`${WORK_DIR}/`)).toBe('');
  });
});

describe('diffFiles', () => {
  it('should return undefined when files are identical', () => {
    const content = 'hello world\n';
    expect(diffFiles('test.txt', content, content)).toBeUndefined();
  });

  it('should return a unified diff without the patch header', () => {
    const oldContent = 'line1\nline2\nline3\n';
    const newContent = 'line1\nline2-changed\nline3\n';
    const result = diffFiles('test.txt', oldContent, newContent);

    expect(result).toBeDefined();

    // Should NOT contain the header lines
    expect(result).not.toContain('--- test.txt');
    expect(result).not.toContain('+++ test.txt');

    // Should contain the actual diff hunks
    expect(result).toContain('-line2');
    expect(result).toContain('+line2-changed');
  });

  it('should handle adding new content to an empty file', () => {
    const result = diffFiles('empty.txt', '', 'new content\n');

    expect(result).toBeDefined();
    expect(result).toContain('+new content');
  });

  it('should handle removing all content', () => {
    const result = diffFiles('full.txt', 'old content\n', '');

    expect(result).toBeDefined();
    expect(result).toContain('-old content');
  });

  it('should handle multi-line diffs', () => {
    const oldContent = 'a\nb\nc\nd\ne\n';
    const newContent = 'a\nB\nc\nD\ne\n';
    const result = diffFiles('multi.txt', oldContent, newContent);

    expect(result).toBeDefined();
    expect(result).toContain('-b');
    expect(result).toContain('+B');
    expect(result).toContain('-d');
    expect(result).toContain('+D');
  });
});

describe('computeFileModifications', () => {
  function makeFileMap(entries: Record<string, string>): FileMap {
    const map: FileMap = {};

    for (const [path, content] of Object.entries(entries)) {
      map[path] = { type: 'file', content, isBinary: false };
    }

    return map;
  }

  it('should return undefined when there are no modified files', () => {
    const files = makeFileMap({ 'test.txt': 'hello' });
    const modifiedFiles = new Map<string, string>();
    expect(computeFileModifications(files, modifiedFiles)).toBeUndefined();
  });

  it('should return undefined when files are identical (no changes)', () => {
    const content = 'same content\n';
    const files = makeFileMap({ 'test.txt': content });
    const modifiedFiles = new Map([['test.txt', content]]);
    expect(computeFileModifications(files, modifiedFiles)).toBeUndefined();
  });

  it('should return diff type when diff is smaller than full content', () => {
    // A large file with a small change → diff should be smaller
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const newLines = lines.replace('line 50', 'line 50 modified');

    const files = makeFileMap({ 'big.txt': newLines });
    const modifiedFiles = new Map([['big.txt', lines]]);
    const result = computeFileModifications(files, modifiedFiles);

    expect(result).toBeDefined();
    expect(result!['big.txt']).toBeDefined();
    expect(result!['big.txt'].type).toBe('diff');
    expect(result!['big.txt'].content).toContain('-line 50');
    expect(result!['big.txt'].content).toContain('+line 50 modified');
  });

  it('should return file type when diff is larger than file content', () => {
    // Almost entirely different content → diff will be larger than the file itself
    const oldContent = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
    const newContent = 'x\n';

    const files = makeFileMap({ 'small.txt': newContent });
    const modifiedFiles = new Map([['small.txt', oldContent]]);
    const result = computeFileModifications(files, modifiedFiles);

    expect(result).toBeDefined();
    expect(result!['small.txt']).toBeDefined();
    expect(result!['small.txt'].type).toBe('file');
    expect(result!['small.txt'].content).toBe(newContent);
  });

  it('should skip entries where the file does not exist in the file map', () => {
    const files = makeFileMap({});
    const modifiedFiles = new Map([['missing.txt', 'old']]);
    expect(computeFileModifications(files, modifiedFiles)).toBeUndefined();
  });

  it('should skip entries where the file type is not "file" (e.g., folder)', () => {
    const files: FileMap = {
      '/dir': { type: 'folder' },
    };
    const modifiedFiles = new Map([['/dir', 'old content']]);
    expect(computeFileModifications(files, modifiedFiles)).toBeUndefined();
  });

  it('should handle multiple files with mixed diff/file types', () => {
    // File A: small change on big file → diff
    const bigOld = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n');
    const bigNew = bigOld.replace('line-25', 'line-25-changed');

    // File B: massive change on tiny file → file
    const tinyOld = 'aaa\nbbb\nccc\nddd\neee\nfff\n';
    const tinyNew = 'z\n';

    const files = makeFileMap({ 'big.txt': bigNew, 'tiny.txt': tinyNew });
    const modifiedFiles = new Map([
      ['big.txt', bigOld],
      ['tiny.txt', tinyOld],
    ]);
    const result = computeFileModifications(files, modifiedFiles);

    expect(result).toBeDefined();
    expect(result!['big.txt'].type).toBe('diff');
    expect(result!['tiny.txt'].type).toBe('file');
  });
});

describe('fileModificationsToHTML', () => {
  it('should return undefined for an empty modifications object', () => {
    expect(fileModificationsToHTML({})).toBeUndefined();
  });

  it('should wrap a single diff modification in the tag', () => {
    const result = fileModificationsToHTML({
      '/home/project/index.js': { type: 'diff', content: '-old\n+new' },
    });

    expect(result).toBeDefined();
    expect(result).toContain(`<${MODIFICATIONS_TAG_NAME}>`);
    expect(result).toContain(`</${MODIFICATIONS_TAG_NAME}>`);
    expect(result).toContain('<diff path="/home/project/index.js">');
    expect(result).toContain('-old\n+new');
    expect(result).toContain('</diff>');
  });

  it('should wrap a single file modification in the tag', () => {
    const result = fileModificationsToHTML({
      '/home/project/app.ts': { type: 'file', content: 'full file content' },
    });

    expect(result).toBeDefined();
    expect(result).toContain('<file path="/home/project/app.ts">');
    expect(result).toContain('full file content');
    expect(result).toContain('</file>');
  });

  it('should handle multiple modifications', () => {
    const result = fileModificationsToHTML({
      'a.js': { type: 'diff', content: 'diff-a' },
      'b.js': { type: 'file', content: 'file-b' },
    });

    expect(result).toBeDefined();
    expect(result).toContain('<diff path="a.js">');
    expect(result).toContain('diff-a');
    expect(result).toContain('</diff>');
    expect(result).toContain('<file path="b.js">');
    expect(result).toContain('file-b');
    expect(result).toContain('</file>');
  });

  it('should JSON-stringify the path (escaping quotes)', () => {
    const result = fileModificationsToHTML({
      'path/with"quotes.js': { type: 'file', content: 'x' },
    });

    expect(result).toBeDefined();

    // JSON.stringify will escape the inner quote
    expect(result).toContain('"path/with\\"quotes.js"');
  });
});

describe('modificationsRegex', () => {
  it('should match a modifications tag block at the start of a string', () => {
    const input = `<${MODIFICATIONS_TAG_NAME}>\nsome content\n</${MODIFICATIONS_TAG_NAME}>\n rest`;
    const matches = input.match(modificationsRegex);
    expect(matches).not.toBeNull();
    expect(matches).toHaveLength(1);
    expect(matches![0]).toContain(`<${MODIFICATIONS_TAG_NAME}>`);
    expect(matches![0]).toContain(`</${MODIFICATIONS_TAG_NAME}>`);
  });

  it('should not match when tag is not at the start of a line', () => {
    const input = `prefix <${MODIFICATIONS_TAG_NAME}>content</${MODIFICATIONS_TAG_NAME}> `;
    const matches = input.match(modificationsRegex);
    expect(matches).toBeNull();
  });

  it('should match only the first tag block when multiple exist (^ anchors to string start)', () => {
    const input =
      `<${MODIFICATIONS_TAG_NAME}>a</${MODIFICATIONS_TAG_NAME}>\n` +
      `<${MODIFICATIONS_TAG_NAME}>b</${MODIFICATIONS_TAG_NAME}>\n`;
    const matches = input.match(modificationsRegex);
    expect(matches).not.toBeNull();

    // ^ without the m flag matches only the start of the string, so only one match
    expect(matches).toHaveLength(1);
  });

  it('should handle multiline content inside the tag', () => {
    const input = `<${MODIFICATIONS_TAG_NAME}>\nline1\nline2\nline3\n</${MODIFICATIONS_TAG_NAME}>\n`;
    const matches = input.match(modificationsRegex);
    expect(matches).not.toBeNull();
    expect(matches).toHaveLength(1);
  });
});
