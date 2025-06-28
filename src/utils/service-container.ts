/**
 * Dependency Injection Container
 * 
 * Provides centralized service management and dependency injection
 * for improved testability and loose coupling.
 */

import { config, Config } from './config.js';
import { logger, Logger } from './logger.js';
import { cache, Cache } from './cache.js';
import { helpScoutClient, HelpScoutClient } from './helpscout-client.js';

/**
 * Service registry interface for type safety
 */
export interface ServiceRegistry {
  config: Config;
  logger: Logger;
  cache: Cache;
  helpScoutClient: HelpScoutClient;
}

/**
 * Service container for dependency injection
 */
export class ServiceContainer {
  private static instance: ServiceContainer;
  private services: Partial<ServiceRegistry> = {};
  private singletons: Set<keyof ServiceRegistry> = new Set();

  private constructor() {
    // Private constructor for singleton pattern
  }

  /**
   * Get the singleton instance of the service container
   */
  static getInstance(): ServiceContainer {
    if (!ServiceContainer.instance) {
      ServiceContainer.instance = new ServiceContainer();
      ServiceContainer.instance.registerDefaultServices();
    }
    return ServiceContainer.instance;
  }

  /**
   * Register a service in the container
   */
  register<K extends keyof ServiceRegistry>(
    key: K,
    service: ServiceRegistry[K],
    asSingleton: boolean = true
  ): void {
    this.services[key] = service;
    if (asSingleton) {
      this.singletons.add(key);
    }
  }

  /**
   * Register a service factory for lazy initialization
   */
  registerFactory<K extends keyof ServiceRegistry>(
    key: K,
    factory: () => ServiceRegistry[K],
    asSingleton: boolean = true
  ): void {
    // Store the factory function
    Object.defineProperty(this.services, key, {
      get: () => {
        const service = factory();
        if (asSingleton) {
          // Replace factory with actual instance for singleton behavior
          this.register(key, service, true);
        }
        return service;
      },
      configurable: true,
      enumerable: true
    });

    if (asSingleton) {
      this.singletons.add(key);
    }
  }

  /**
   * Get a service from the container
   */
  get<K extends keyof ServiceRegistry>(key: K): ServiceRegistry[K] {
    const service = this.services[key];
    if (!service) {
      throw new Error(`Service '${String(key)}' not found in container`);
    }
    return service;
  }

  /**
   * Check if a service is registered
   */
  has<K extends keyof ServiceRegistry>(key: K): boolean {
    return key in this.services;
  }

  /**
   * Remove a service from the container
   */
  remove<K extends keyof ServiceRegistry>(key: K): void {
    delete this.services[key];
    this.singletons.delete(key);
  }

  /**
   * Clear all services (useful for testing)
   */
  clear(): void {
    this.services = {};
    this.singletons.clear();
  }

  /**
   * Create a new isolated container (useful for testing)
   */
  static createTestContainer(): ServiceContainer {
    const container = new ServiceContainer();
    return container;
  }

  /**
   * Register default production services
   */
  private registerDefaultServices(): void {
    // Register core services
    this.register('config', config, true);
    this.register('logger', logger, true);
    this.register('cache', cache, true);
    this.register('helpScoutClient', helpScoutClient, true);
  }

  /**
   * Get all registered service names
   */
  getRegisteredServices(): Array<keyof ServiceRegistry> {
    return Object.keys(this.services) as Array<keyof ServiceRegistry>;
  }

  /**
   * Check if a service is registered as singleton
   */
  isSingleton<K extends keyof ServiceRegistry>(key: K): boolean {
    return this.singletons.has(key);
  }

  /**
   * Create a service resolver for dependency injection
   */
  createResolver(): ServiceResolver {
    return new ServiceResolver(this);
  }
}

/**
 * Service resolver for easier dependency injection
 */
export class ServiceResolver {
  constructor(private container: ServiceContainer) {}

  /**
   * Resolve multiple services at once
   */
  resolve<K extends keyof ServiceRegistry>(
    keys: Array<K>
  ): { [P in K]: ServiceRegistry[P] } {
    const result = {} as { [P in K]: ServiceRegistry[P] };
    
    for (const key of keys) {
      result[key] = this.container.get(key);
    }
    
    return result;
  }

  /**
   * Resolve all services
   */
  resolveAll(): ServiceRegistry {
    const keys = this.container.getRegisteredServices();
    return this.resolve(keys) as ServiceRegistry;
  }
}

/**
 * Decorator for automatic dependency injection
 */
export function inject<T extends keyof ServiceRegistry>(serviceName: T) {
  return function (target: any, propertyKey: string | symbol) {
    Object.defineProperty(target, propertyKey, {
      get() {
        return ServiceContainer.getInstance().get(serviceName);
      },
      configurable: true,
      enumerable: true
    });
  };
}

/**
 * Base class with dependency injection support
 */
export abstract class Injectable {
  protected services: ServiceResolver;

  constructor(container?: ServiceContainer) {
    this.services = (container || ServiceContainer.getInstance()).createResolver();
  }

  /**
   * Get a specific service
   */
  protected getService<K extends keyof ServiceRegistry>(key: K): ServiceRegistry[K] {
    return ServiceContainer.getInstance().get(key);
  }
}

/**
 * Factory function for creating services with dependencies
 */
export function createServiceFactory<T>(
  factory: (services: ServiceRegistry) => T
): () => T {
  return () => {
    const container = ServiceContainer.getInstance();
    const resolver = container.createResolver();
    const services = resolver.resolveAll();
    return factory(services);
  };
}

// Export singleton instance for convenience
export const serviceContainer = ServiceContainer.getInstance();