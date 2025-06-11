import { LRUCache } from 'lru-cache';
import crypto from 'crypto';
import { config } from './config.js';
import { logger } from './logger.js';

export interface CacheOptions {
  ttl?: number;
}

export class Cache {
  private cache: LRUCache<string, any>;
  private defaultTtl: number;

  constructor() {
    this.defaultTtl = config.cache.ttlSeconds * 1000; // Convert to milliseconds
    this.cache = new LRUCache<string, any>({
      max: config.cache.maxSize,
      ttl: this.defaultTtl,
    });
  }

  private generateKey(prefix: string, data: unknown): string {
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify({ prefix, data }));
    return hash.digest('hex');
  }

  get<T>(prefix: string, data: unknown): T | undefined {
    const key = this.generateKey(prefix, data);
    const value = this.cache.get(key) as T | undefined;
    
    if (value) {
      logger.debug('Cache hit', { key, prefix });
    } else {
      logger.debug('Cache miss', { key, prefix });
    }
    
    return value;
  }

  set<T>(prefix: string, data: unknown, value: T, options?: CacheOptions): void {
    const key = this.generateKey(prefix, data);
    const ttl = options?.ttl ? options.ttl * 1000 : this.defaultTtl;
    
    this.cache.set(key, value, { ttl });
    logger.debug('Cache set', { key, prefix, ttl: ttl / 1000 });
  }

  clear(): void {
    this.cache.clear();
    logger.info('Cache cleared');
  }

  getStats(): { size: number; max: number } {
    return {
      size: this.cache.size,
      max: this.cache.max,
    };
  }
}

export const cache = new Cache();