import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Message, DataStreamWriter, ToolSet } from 'ai';
import {
  TOOL_EXECUTION_APPROVAL,
  TOOL_EXECUTION_DENIED,
  TOOL_EXECUTION_ERROR,
  TOOL_NO_EXECUTE_FUNCTION,
} from '~/utils/constants';

// Mock the AI SDK
vi.mock('ai', async () => {
  const actual = await vi.importActual('ai');
  return {
    ...actual,
    experimental_createMCPClient: vi.fn(),
    convertToCoreMessages: vi.fn((m) => m),
    formatDataStreamPart: vi.fn((_type, data) => JSON.stringify(data)),
  };
});
vi.mock('ai/mcp-stdio', () => ({
  Experimental_StdioMCPTransport: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

// Import after mocks
import { MCPService } from './mcpService';

// Helper to create a fresh MCPService instance for isolated tests
function createFreshMCPService(): MCPService {
  // Access private constructor workaround: reset singleton

  (MCPService as any)._instance = undefined;
  return MCPService.getInstance();
}

function createMockDataStream(): DataStreamWriter {
  return {
    write: vi.fn(),
    writeData: vi.fn(),
    writeMessageAnnotation: vi.fn(),
    merge: vi.fn(),
  } as unknown as DataStreamWriter;
}

function createMockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'test',
    ...overrides,
  } as Message;
}

describe('MCPService', () => {
  let service: MCPService;

  beforeEach(() => {
    service = createFreshMCPService();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getInstance', () => {
    it('should return a singleton instance', () => {
      const instance1 = MCPService.getInstance();
      const instance2 = MCPService.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should create a new instance after reset', () => {
      const instance1 = MCPService.getInstance();

      (MCPService as any)._instance = undefined;

      const instance2 = MCPService.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('isValidToolName', () => {
    it('should return false for unknown tool', () => {
      expect(service.isValidToolName('nonexistent-tool')).toBe(false);
    });

    it('should return true for registered tool', () => {
      // Manually register a tool via internal state
      const mockTool = {
        description: 'A test tool',
        parameters: { jsonSchema: { type: 'object', properties: {} } },
        execute: vi.fn(),
      };

      (service as any)._tools = { 'test-tool': mockTool };
      expect(service.isValidToolName('test-tool')).toBe(true);
    });
  });

  describe('toolsWithoutExecute', () => {
    it('should return tools with execute set to undefined', () => {
      const mockTool = {
        description: 'A test tool',
        parameters: { jsonSchema: { type: 'object', properties: {} } },
        execute: vi.fn(),
      };

      (service as any)._toolsWithoutExecute = { 'test-tool': { ...mockTool, execute: undefined } };

      const tools = service.toolsWithoutExecute;
      expect(tools['test-tool']).toBeDefined();
      expect(tools['test-tool'].execute).toBeUndefined();
    });

    it('should return empty object when no tools registered', () => {
      expect(service.toolsWithoutExecute).toEqual({});
    });
  });

  describe('processToolCall', () => {
    it('should write annotation for known tool', () => {
      const mockDataStream = createMockDataStream();

      const mockTool = {
        description: 'Test tool description',
        parameters: { jsonSchema: { type: 'object', properties: {} } },
      };

      (service as any)._tools = { 'my-tool': mockTool };

      (service as any)._toolsWithoutExecute = { 'my-tool': { ...mockTool, execute: undefined } };

      (service as any)._toolNamesToServerNames.set('my-tool', 'test-server');

      service.processToolCall(
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'my-tool', args: {} },
        mockDataStream,
      );

      expect(mockDataStream.writeMessageAnnotation).toHaveBeenCalledWith({
        type: 'toolCall',
        toolCallId: 'call-1',
        serverName: 'test-server',
        toolName: 'my-tool',
        toolDescription: 'Test tool description',
      });
    });

    it('should not write annotation for unknown tool', () => {
      const mockDataStream = createMockDataStream();

      service.processToolCall(
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'unknown-tool', args: {} },
        mockDataStream,
      );

      expect(mockDataStream.writeMessageAnnotation).not.toHaveBeenCalled();
    });

    it('should use "No description available" for tools without description', () => {
      const mockDataStream = createMockDataStream();

      const mockTool = {
        parameters: { jsonSchema: { type: 'object', properties: {} } },
      };

      (service as any)._tools = { 'no-desc-tool': mockTool };

      (service as any)._toolsWithoutExecute = { 'no-desc-tool': { ...mockTool, execute: undefined } };

      (service as any)._toolNamesToServerNames.set('no-desc-tool', 'server-a');

      service.processToolCall(
        { type: 'tool-call', toolCallId: 'call-2', toolName: 'no-desc-tool', args: {} },
        mockDataStream,
      );

      expect(mockDataStream.writeMessageAnnotation).toHaveBeenCalledWith(
        expect.objectContaining({
          toolDescription: 'No description available',
        }),
      );
    });
  });

  describe('processToolInvocations', () => {
    function setupToolForInvocation(toolName: string, executeFn?: (...args: unknown[]) => unknown) {
      const mockTool = {
        description: 'Test tool',
        parameters: { jsonSchema: { type: 'object', properties: {} } },
        execute: executeFn,
      };

      (service as any)._tools = { [toolName]: mockTool };

      (service as any)._toolsWithoutExecute = { [toolName]: { ...mockTool, execute: undefined } };

      (service as any)._toolNamesToServerNames.set(toolName, 'test-server');
    }

    it('should return messages unchanged when no parts present', async () => {
      const messages: Message[] = [createMockMessage({ content: 'hello' })];
      const dataStream = createMockDataStream();

      const result = await service.processToolInvocations(messages, dataStream);
      expect(result).toEqual(messages);
    });

    it('should return messages unchanged when parts is empty array', async () => {
      const messages: Message[] = [createMockMessage({ parts: [] } as unknown as Partial<Message>)];
      const dataStream = createMockDataStream();

      const result = await service.processToolInvocations(messages, dataStream);
      expect(result).toEqual(messages);
    });

    it('should skip non-tool-invocation parts', async () => {
      const messages: Message[] = [
        createMockMessage({
          parts: [{ type: 'text', text: 'hello' }],
        } as unknown as Partial<Message>),
      ];
      const dataStream = createMockDataStream();

      const result = await service.processToolInvocations(messages, dataStream);
      expect(result[0].parts![0]).toEqual({ type: 'text', text: 'hello' });
    });

    it('should execute approved tool and forward result', async () => {
      const executeFn = vi.fn().mockResolvedValue({ data: 'tool result' });
      setupToolForInvocation('my-tool', executeFn);

      const messages: Message[] = [
        createMockMessage({
          parts: [
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolName: 'my-tool',
                toolCallId: 'call-1',
                state: 'result',
                result: TOOL_EXECUTION_APPROVAL.APPROVE,
                args: { query: 'test' },
              },
            },
          ],
        } as unknown as Partial<Message>),
      ];
      const dataStream = createMockDataStream();

      const result = await service.processToolInvocations(messages, dataStream);

      expect(executeFn).toHaveBeenCalledWith({ query: 'test' }, expect.objectContaining({ toolCallId: 'call-1' }));
      expect(dataStream.write).toHaveBeenCalled();

      const lastPart = result[result.length - 1].parts![0] as { type: string; toolInvocation: { result: unknown } };
      expect(lastPart.toolInvocation.result).toEqual({ data: 'tool result' });
    });

    it('should handle rejected tool invocation', async () => {
      setupToolForInvocation('my-tool', vi.fn());

      const messages: Message[] = [
        createMockMessage({
          parts: [
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolName: 'my-tool',
                toolCallId: 'call-1',
                state: 'result',
                result: TOOL_EXECUTION_APPROVAL.REJECT,
                args: {},
              },
            },
          ],
        } as unknown as Partial<Message>),
      ];
      const dataStream = createMockDataStream();

      const result = await service.processToolInvocations(messages, dataStream);

      const lastPart = result[result.length - 1].parts![0] as { type: string; toolInvocation: { result: unknown } };
      expect(lastPart.toolInvocation.result).toBe(TOOL_EXECUTION_DENIED);
    });

    it('should return error result when tool execution throws', async () => {
      const executeFn = vi.fn().mockRejectedValue(new Error('Tool failed'));
      setupToolForInvocation('failing-tool', executeFn);

      const messages: Message[] = [
        createMockMessage({
          parts: [
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolName: 'failing-tool',
                toolCallId: 'call-1',
                state: 'result',
                result: TOOL_EXECUTION_APPROVAL.APPROVE,
                args: {},
              },
            },
          ],
        } as unknown as Partial<Message>),
      ];
      const dataStream = createMockDataStream();

      const result = await service.processToolInvocations(messages, dataStream);

      const lastPart = result[result.length - 1].parts![0] as { type: string; toolInvocation: { result: unknown } };
      expect(lastPart.toolInvocation.result).toBe(TOOL_EXECUTION_ERROR);
    });

    it('should return no-execute error when tool has no execute function', async () => {
      // Set up tool without execute function
      const mockTool = {
        description: 'No execute tool',
        parameters: { jsonSchema: { type: 'object', properties: {} } },
      };

      (service as any)._tools = { 'no-exec-tool': mockTool };

      (service as any)._toolNamesToServerNames.set('no-exec-tool', 'test-server');

      const messages: Message[] = [
        createMockMessage({
          parts: [
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolName: 'no-exec-tool',
                toolCallId: 'call-1',
                state: 'result',
                result: TOOL_EXECUTION_APPROVAL.APPROVE,
                args: {},
              },
            },
          ],
        } as unknown as Partial<Message>),
      ];
      const dataStream = createMockDataStream();

      const result = await service.processToolInvocations(messages, dataStream);

      const lastPart = result[result.length - 1].parts![0] as { type: string; toolInvocation: { result: unknown } };
      expect(lastPart.toolInvocation.result).toBe(TOOL_NO_EXECUTE_FUNCTION);
    });

    it('should return part as-is for unknown tool invocation', async () => {
      const originalPart = {
        type: 'tool-invocation',
        toolInvocation: {
          toolName: 'unknown-tool',
          toolCallId: 'call-1',
          state: 'result',
          result: TOOL_EXECUTION_APPROVAL.APPROVE,
          args: {},
        },
      };

      const messages: Message[] = [
        createMockMessage({
          parts: [originalPart],
        } as unknown as Partial<Message>),
      ];
      const dataStream = createMockDataStream();

      const result = await service.processToolInvocations(messages, dataStream);
      expect(result[result.length - 1].parts![0]).toEqual(originalPart);
    });

    it('should return part as-is when state is not result', async () => {
      setupToolForInvocation('my-tool', vi.fn());

      const callPart = {
        type: 'tool-invocation',
        toolInvocation: {
          toolName: 'my-tool',
          toolCallId: 'call-1',
          state: 'call',
          args: {},
        },
      };

      const messages: Message[] = [
        createMockMessage({
          parts: [callPart],
        } as unknown as Partial<Message>),
      ];
      const dataStream = createMockDataStream();

      const result = await service.processToolInvocations(messages, dataStream);
      expect(result[result.length - 1].parts![0]).toEqual(callPart);
    });

    it('should preserve prior messages unchanged', async () => {
      const executeFn = vi.fn().mockResolvedValue('done');
      setupToolForInvocation('my-tool', executeFn);

      const priorMessage = createMockMessage({ id: 'prior', role: 'user', content: 'hello' });
      const lastMessage = createMockMessage({
        id: 'last',
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              toolName: 'my-tool',
              toolCallId: 'call-1',
              state: 'result',
              result: TOOL_EXECUTION_APPROVAL.APPROVE,
              args: {},
            },
          },
        ],
      } as unknown as Partial<Message>);

      const messages: Message[] = [priorMessage, lastMessage];
      const dataStream = createMockDataStream();

      const result = await service.processToolInvocations(messages, dataStream);

      expect(result).toHaveLength(2);
      expect(result[0]).toBe(priorMessage);
    });

    it('should handle multiple tool invocations in single message', async () => {
      const executeFn1 = vi.fn().mockResolvedValue('result1');
      const executeFn2 = vi.fn().mockResolvedValue('result2');

      const mockTools: ToolSet = {
        'tool-a': {
          description: 'Tool A',
          parameters: { jsonSchema: { type: 'object', properties: {} } },
          execute: executeFn1,
        },
        'tool-b': {
          description: 'Tool B',
          parameters: { jsonSchema: { type: 'object', properties: {} } },
          execute: executeFn2,
        },
      };

      (service as any)._tools = mockTools;

      (service as any)._toolNamesToServerNames.set('tool-a', 'server-1');

      (service as any)._toolNamesToServerNames.set('tool-b', 'server-1');

      const messages: Message[] = [
        createMockMessage({
          parts: [
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolName: 'tool-a',
                toolCallId: 'call-a',
                state: 'result',
                result: TOOL_EXECUTION_APPROVAL.APPROVE,
                args: {},
              },
            },
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolName: 'tool-b',
                toolCallId: 'call-b',
                state: 'result',
                result: TOOL_EXECUTION_APPROVAL.APPROVE,
                args: {},
              },
            },
          ],
        } as unknown as Partial<Message>),
      ];
      const dataStream = createMockDataStream();

      const result = await service.processToolInvocations(messages, dataStream);

      expect(executeFn1).toHaveBeenCalled();
      expect(executeFn2).toHaveBeenCalled();
      expect(result[0].parts).toHaveLength(2);
      expect(dataStream.write).toHaveBeenCalledTimes(2);
    });
  });

  describe('_validateServerConfig (via updateConfig)', () => {
    it('should validate stdio config with command', () => {
      const validate = (service as any)._validateServerConfig.bind(service);

      const config = validate('test', { command: 'npx', args: ['-y', 'some-server'] });
      expect(config.type).toBe('stdio');
      expect(config.command).toBe('npx');
    });

    it('should validate streamable-http config', () => {
      const validate = (service as any)._validateServerConfig.bind(service);

      const config = validate('test', { type: 'streamable-http', url: 'https://example.com/mcp' });
      expect(config.type).toBe('streamable-http');
      expect(config.url).toBe('https://example.com/mcp');
    });

    it('should validate sse config', () => {
      const validate = (service as any)._validateServerConfig.bind(service);

      const config = validate('test', { type: 'sse', url: 'http://localhost:8000/sse' });
      expect(config.type).toBe('sse');
    });

    it('should throw for config with both command and url', () => {
      const validate = (service as any)._validateServerConfig.bind(service);

      expect(() => validate('test', { command: 'npx', url: 'http://localhost' })).toThrow(
        'cannot have "command" and "url"',
      );
    });

    it('should throw for url config without type', () => {
      const validate = (service as any)._validateServerConfig.bind(service);

      expect(() => validate('test', { url: 'http://localhost:3000' })).toThrow('missing "type" field');
    });

    it('should throw for invalid type', () => {
      const validate = (service as any)._validateServerConfig.bind(service);

      expect(() => validate('test', { type: 'websocket', url: 'ws://localhost' })).toThrow(
        'provided "type" is invalid',
      );
    });

    it('should throw for stdio type without command', () => {
      const validate = (service as any)._validateServerConfig.bind(service);

      expect(() => validate('test', { type: 'stdio' })).toThrow('missing "command" field');
    });

    it('should throw for sse type without url', () => {
      const validate = (service as any)._validateServerConfig.bind(service);

      expect(() => validate('test', { type: 'sse' })).toThrow('missing "url" field');
    });

    it('should throw for streamable-http type without url', () => {
      const validate = (service as any)._validateServerConfig.bind(service);

      expect(() => validate('test', { type: 'streamable-http' })).toThrow('missing "url" field');
    });
  });

  describe('_registerTools', () => {
    it('should register tools and create copies without execute', () => {
      const mockTool = {
        description: 'A tool',
        parameters: { jsonSchema: { type: 'object', properties: {} } },
        execute: vi.fn(),
      };

      (service as any)._registerTools('server-1', { 'my-tool': mockTool } as unknown as ToolSet);

      expect(service.tools['my-tool']).toBeDefined();
      expect(service.tools['my-tool'].execute).toBe(mockTool.execute);
      expect(service.toolsWithoutExecute['my-tool']).toBeDefined();
      expect(service.toolsWithoutExecute['my-tool'].execute).toBeUndefined();
    });

    it('should map tool name to server name', () => {
      const mockTool = {
        description: 'A tool',
        parameters: { jsonSchema: { type: 'object', properties: {} } },
        execute: vi.fn(),
      };

      (service as any)._registerTools('my-server', { 'my-tool': mockTool } as unknown as ToolSet);

      expect((service as any)._toolNamesToServerNames.get('my-tool')).toBe('my-server');
    });

    it('should override tool from different server and warn', () => {
      const tool1 = {
        description: 'Tool from server 1',
        parameters: { jsonSchema: { type: 'object', properties: {} } },
        execute: vi.fn(),
      };
      const tool2 = {
        description: 'Tool from server 2',
        parameters: { jsonSchema: { type: 'object', properties: {} } },
        execute: vi.fn(),
      };

      (service as any)._registerTools('server-1', { 'shared-tool': tool1 } as unknown as ToolSet);

      (service as any)._registerTools('server-2', { 'shared-tool': tool2 } as unknown as ToolSet);

      // Tool should now be from server-2
      expect(service.tools['shared-tool'].execute).toBe(tool2.execute);

      expect((service as any)._toolNamesToServerNames.get('shared-tool')).toBe('server-2');
    });
  });

  describe('schema sanitization (_sanitizeJsonSchema)', () => {
    // Helper to access the private method
    function sanitize(schema: Record<string, unknown>): Record<string, unknown> {
      return (service as any)._sanitizeJsonSchema(schema);
    }

    it('should pass through simple schemas unchanged', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['name'],
      };
      expect(sanitize(schema)).toEqual(schema);
    });

    it('should remove additionalProperties', () => {
      const schema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      };
      const result = sanitize(schema);
      expect(result).not.toHaveProperty('additionalProperties');
      expect(result).toEqual({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      });
    });

    it('should convert anyOf with string|array to first type (string)', () => {
      const schema = {
        type: 'object',
        properties: {
          repoName: {
            anyOf: [{ type: 'string' }, { items: { type: 'string' }, type: 'array' }],
          },
        },
        required: ['repoName'],
        additionalProperties: false,
      };
      const result = sanitize(schema);
      expect(result).toEqual({
        type: 'object',
        properties: {
          repoName: { type: 'string' },
        },
        required: ['repoName'],
      });
    });

    it('should handle anyOf with nullable type by picking first non-null', () => {
      const schema = {
        anyOf: [{ type: 'null' }, { type: 'string' }],
      };
      const result = sanitize(schema);
      expect(result).toEqual({ type: 'string' });
    });

    it('should convert oneOf to first non-null variant', () => {
      const schema = {
        oneOf: [{ type: 'number' }, { type: 'string' }],
      };
      const result = sanitize(schema);
      expect(result).toEqual({ type: 'number' });
    });

    it('should flatten allOf by merging all schemas', () => {
      const schema = {
        allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { required: ['a'] }],
      };
      const result = sanitize(schema);
      expect(result).toEqual({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
      });
    });

    it('should recursively sanitize nested properties', () => {
      const schema = {
        type: 'object',
        properties: {
          config: {
            type: 'object',
            properties: {
              value: {
                anyOf: [{ type: 'string' }, { type: 'number' }],
              },
            },
            additionalProperties: false,
          },
        },
      };
      const result = sanitize(schema);
      expect(result).toEqual({
        type: 'object',
        properties: {
          config: {
            type: 'object',
            properties: {
              value: { type: 'string' },
            },
          },
        },
      });
    });

    it('should recursively sanitize array items schema', () => {
      const schema = {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          additionalProperties: false,
        },
      };
      const result = sanitize(schema);
      expect(result).toEqual({
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
        },
      });
    });

    it('should handle DeepWiki ask_question schema (real-world case)', () => {
      const schema = {
        type: 'object',
        properties: {
          repoName: {
            anyOf: [{ type: 'string' }, { items: { type: 'string' }, type: 'array' }],
          },
          question: { type: 'string' },
        },
        required: ['repoName', 'question'],
        additionalProperties: false,
      };
      const result = sanitize(schema);
      expect(result).toEqual({
        type: 'object',
        properties: {
          repoName: { type: 'string' },
          question: { type: 'string' },
        },
        required: ['repoName', 'question'],
      });
    });

    it('should handle null/undefined input gracefully', () => {
      expect(sanitize(null as any)).toBeNull();

      expect(sanitize(undefined as any)).toBeUndefined();
    });

    it('should apply sanitization during _registerTools', () => {
      const mockTool = {
        description: 'DeepWiki ask',
        parameters: {
          jsonSchema: {
            type: 'object',
            properties: {
              repoName: {
                anyOf: [{ type: 'string' }, { items: { type: 'string' }, type: 'array' }],
              },
              question: { type: 'string' },
            },
            required: ['repoName', 'question'],
            additionalProperties: false,
          },
        },
        execute: vi.fn(),
      };

      (service as any)._registerTools('deepwiki', { ask_question: mockTool } as unknown as ToolSet);

      const registered = service.toolsWithoutExecute.ask_question;
      expect(registered).toBeDefined();

      const schema = (registered.parameters as { jsonSchema: Record<string, unknown> }).jsonSchema;
      expect(schema).not.toHaveProperty('additionalProperties');
      expect((schema as any).properties.repoName).toEqual({ type: 'string' });
      expect((schema as any).properties.repoName).not.toHaveProperty('anyOf');
    });
  });
});
