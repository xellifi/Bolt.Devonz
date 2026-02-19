import { describe, expect, it, beforeEach } from 'vitest';

/**
 * LLMManager is a singleton with private constructor, so we test it
 * via getInstance(). We need to reset the singleton between tests.
 */

// We need to access the private static _instance to reset. Use a hack:
function resetLLMManagerSingleton() {
  (LLMManager as any)._instance = undefined;
}

// Import after defining the reset helper
import { LLMManager } from './manager';
import { BaseProvider } from './base-provider';
import type { ModelInfo, ProviderConfig } from './types';
import type { LanguageModelV1 } from 'ai';
import type { IProviderSetting } from '~/types/model';

/**
 * Create a mock provider for testing
 */
class MockProvider extends BaseProvider {
  name: string;
  staticModels: ModelInfo[];
  config: ProviderConfig;
  private _dynamicModels?: ModelInfo[];

  constructor(name: string, staticModels: ModelInfo[] = [], config: ProviderConfig = {}, dynamicModels?: ModelInfo[]) {
    super();
    this.name = name;
    this.staticModels = staticModels;
    this.config = config;
    this._dynamicModels = dynamicModels;
  }

  getModelInstance(): LanguageModelV1 {
    throw new Error('Not implemented in test');
  }

  getDynamicModels = this._dynamicModels ? async () => this._dynamicModels! : undefined;
}

describe('LLMManager', () => {
  beforeEach(() => {
    resetLLMManagerSingleton();
  });

  describe('singleton pattern', () => {
    it('should return the same instance on repeated calls', () => {
      const instance1 = LLMManager.getInstance();
      const instance2 = LLMManager.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should accept env parameter', () => {
      const env = { GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' };
      const instance = LLMManager.getInstance(env as Env);
      expect(instance.env).toEqual(env);
    });

    it('should use empty env by default', () => {
      const instance = LLMManager.getInstance();
      expect(instance.env).toEqual({});
    });
  });

  describe('provider registration', () => {
    it('should register built-in providers on init', () => {
      const manager = LLMManager.getInstance();
      const providers = manager.getAllProviders();
      expect(providers.length).toBeGreaterThan(0);
    });

    it('should register all 19 expected providers', () => {
      const manager = LLMManager.getInstance();
      const providerNames = manager.getAllProviders().map((p) => p.name);

      const expectedProviders = [
        'Anthropic',
        'Cohere',
        'Deepseek',
        'Google',
        'Groq',
        'HuggingFace',
        'Hyperbolic',
        'Mistral',
        'Moonshot',
        'Ollama',
        'OpenAI',
        'OpenRouter',
        'OpenAILike',
        'Perplexity',
        'xAI',
        'Together',
        'LMStudio',
        'AmazonBedrock',
        'Github',
      ];

      for (const name of expectedProviders) {
        expect(providerNames).toContain(name);
      }
    });

    it('should not register duplicate providers', () => {
      const manager = LLMManager.getInstance();
      const initialCount = manager.getAllProviders().length;

      // Try to register an existing provider again
      const existingProvider = manager.getAllProviders()[0];
      manager.registerProvider(existingProvider);

      expect(manager.getAllProviders().length).toBe(initialCount);
    });

    it('should get provider by name', () => {
      const manager = LLMManager.getInstance();
      const google = manager.getProvider('Google');
      expect(google).toBeDefined();
      expect(google!.name).toBe('Google');
    });

    it('should return undefined for unknown provider', () => {
      const manager = LLMManager.getInstance();
      const unknown = manager.getProvider('NonExistentProvider');
      expect(unknown).toBeUndefined();
    });
  });

  describe('model list', () => {
    it('should have static models populated after init', () => {
      const manager = LLMManager.getInstance();
      const models = manager.getModelList();
      expect(models.length).toBeGreaterThan(0);
    });

    it('should return static models via getStaticModelList', () => {
      const manager = LLMManager.getInstance();
      const staticModels = manager.getStaticModelList();
      expect(staticModels.length).toBeGreaterThan(0);

      // Every model should have required fields
      for (const model of staticModels) {
        expect(model.name).toBeDefined();
        expect(model.label).toBeDefined();
        expect(model.provider).toBeDefined();
        expect(model.maxTokenAllowed).toBeGreaterThan(0);
      }
    });

    it('should return static models from specific provider', () => {
      const manager = LLMManager.getInstance();
      const google = manager.getProvider('Google');
      expect(google).toBeDefined();

      const googleModels = manager.getStaticModelListFromProvider(google!);
      expect(googleModels.length).toBeGreaterThan(0);

      for (const model of googleModels) {
        expect(model.provider).toBe('Google');
      }
    });

    it('should throw for unknown provider in getStaticModelListFromProvider', () => {
      const manager = LLMManager.getInstance();
      const fakeProvider = new MockProvider('FakeProvider');

      expect(() => manager.getStaticModelListFromProvider(fakeProvider)).toThrow('Provider FakeProvider not found');
    });
  });

  describe('updateModelList', () => {
    it('should skip providers without API key', async () => {
      const manager = LLMManager.getInstance();

      // No API keys provided — all dynamic fetches should be skipped
      const models = await manager.updateModelList({
        apiKeys: {},
        providerSettings: {},
        serverEnv: {} as Env,
      });

      // Should still have static models
      expect(models.length).toBeGreaterThan(0);
    });

    it('should filter disabled providers', async () => {
      const manager = LLMManager.getInstance();

      // Only enable Google
      const providerSettings: Record<string, IProviderSetting> = {};

      for (const p of manager.getAllProviders()) {
        providerSettings[p.name] = { enabled: p.name === 'Google' };
      }

      const models = await manager.updateModelList({
        apiKeys: {},
        providerSettings,
        serverEnv: {} as Env,
      });

      // Should have at least Google's static models
      const googleModels = models.filter((m) => m.provider === 'Google');
      expect(googleModels.length).toBeGreaterThan(0);
    });

    it('should return sorted model list', async () => {
      const manager = LLMManager.getInstance();

      const models = await manager.updateModelList({
        apiKeys: {},
        providerSettings: {},
        serverEnv: {} as Env,
      });

      // Verify models are sorted alphabetically by name
      for (let i = 1; i < models.length; i++) {
        expect(models[i].name.localeCompare(models[i - 1].name)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('getDefaultProvider', () => {
    it('should return the first registered provider', () => {
      const manager = LLMManager.getInstance();
      const defaultProvider = manager.getDefaultProvider();
      expect(defaultProvider).toBeDefined();
      expect(defaultProvider.name).toBeDefined();
    });
  });

  describe('getModelListFromProvider', () => {
    it('should throw for unknown provider', async () => {
      const manager = LLMManager.getInstance();
      const fake = new MockProvider('NotRegistered');

      await expect(manager.getModelListFromProvider(fake, { apiKeys: {}, serverEnv: {} as Env })).rejects.toThrow(
        'Provider NotRegistered not found',
      );
    });

    it('should return static models for provider without dynamic models', async () => {
      const manager = LLMManager.getInstance();

      // Find a provider that has static models but no dynamic models
      const providers = manager.getAllProviders();
      const staticOnly = providers.find((p) => !p.getDynamicModels);

      if (staticOnly) {
        const models = await manager.getModelListFromProvider(staticOnly, {
          apiKeys: {},
          serverEnv: {} as Env,
        });
        expect(models.length).toBeGreaterThan(0);
      }
    });
  });
});
