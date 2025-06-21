import { cache } from '../utils/cache.js';

describe('Cache', () => {
  beforeEach(() => {
    cache.clear();
  });

  afterEach(() => {
    cache.clear();
  });

  describe('basic operations', () => {
    it('should store and retrieve values', () => {
      const key = 'test-key';
      const params = { param1: 'value1' };
      const value = { data: 'test-data' };

      cache.set(key, params, value);
      const retrieved = cache.get(key, params);

      expect(retrieved).toEqual(value);
    });

    it('should return undefined for non-existent keys', () => {
      const result = cache.get('non-existent', {});
      expect(result).toBeUndefined();
    });

    it('should handle different parameters for same key', () => {
      const key = 'test-key';
      const params1 = { param: 'value1' };
      const params2 = { param: 'value2' };
      const value1 = { data: 'data1' };
      const value2 = { data: 'data2' };

      cache.set(key, params1, value1);
      cache.set(key, params2, value2);

      expect(cache.get(key, params1)).toEqual(value1);
      expect(cache.get(key, params2)).toEqual(value2);
    });
  });

  describe('TTL functionality', () => {
    it('should respect TTL and expire entries', async () => {
      const key = 'ttl-key';
      const params = {};
      const value = { data: 'test' };

      cache.set(key, params, value, { ttl: 0.01 }); // 0.01 seconds = 10ms TTL

      // Should be available immediately
      expect(cache.get(key, params)).toEqual(value);

      // Should be expired after TTL (wait longer to ensure expiration)
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(cache.get(key, params)).toBeUndefined();
    });

    it('should use default TTL when not specified', () => {
      const key = 'default-ttl';
      const params = {};
      const value = { data: 'test' };

      cache.set(key, params, value);
      expect(cache.get(key, params)).toEqual(value);
    });
  });

  describe('cache management', () => {
    it('should clear all entries', () => {
      cache.set('key1', {}, { data: '1' });
      cache.set('key2', {}, { data: '2' });

      expect(cache.get('key1', {})).toBeDefined();
      expect(cache.get('key2', {})).toBeDefined();

      cache.clear();

      expect(cache.get('key1', {})).toBeUndefined();
      expect(cache.get('key2', {})).toBeUndefined();
    });
  });

  describe('parameter hashing', () => {
    it('should handle complex parameter objects', () => {
      const key = 'complex-key';
      const params = {
        nested: { deep: { value: 'test' } },
        array: [1, 2, 3],
        number: 42,
        boolean: true,
        null: null,
      };
      const value = { data: 'complex' };

      cache.set(key, params, value);
      expect(cache.get(key, params)).toEqual(value);
    });

    it('should differentiate between similar but different parameters', () => {
      const key = 'param-key';
      const params1 = { a: 1, b: 2 };
      const params2 = { b: 2, a: 1 }; // Same content, different order
      const value1 = { data: '1' };
      const value2 = { data: '2' };

      cache.set(key, params1, value1);
      cache.set(key, params2, value2);

      // Should treat them as different since they maintain separate cache entries
      expect(cache.get(key, params1)).toEqual(value1);
      expect(cache.get(key, params2)).toEqual(value2);
    });
  });
});