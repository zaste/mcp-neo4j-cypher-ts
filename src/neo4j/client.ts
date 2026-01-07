/**
 * Neo4j HTTP Client
 *
 * HTTP-based client for Neo4j that works in Cloudflare Workers.
 * Uses the Neo4j HTTP API instead of Bolt protocol since
 * Workers don't support TCP sockets.
 */

import type {
  Neo4jConnectionConfig,
  Neo4jHttpRequest,
  Neo4jHttpResponse,
  Neo4jClientConfig,
  QueryOptions,
} from './types.js';
import { Neo4jConnectionError, Neo4jQueryError } from '../utils/errors.js';
import * as logger from '../utils/logger.js';

/**
 * Neo4j HTTP Client
 *
 * Provides methods to execute Cypher queries against Neo4j
 * using the HTTP Query API.
 */
export class Neo4jClient {
  private readonly httpUrl: string;
  private readonly authHeader: string;
  private readonly database: string;
  private readonly defaultTimeout: number;

  constructor(config: Neo4jClientConfig) {
    this.httpUrl = this.convertToHttpUrl(config.connection.uri);
    this.authHeader = this.createAuthHeader(
      config.connection.username,
      config.connection.password
    );
    this.database = config.connection.database;
    this.defaultTimeout = config.defaultTimeout;
  }

  /**
   * Convert Neo4j URI to HTTP URL
   *
   * neo4j+s://xxx.databases.neo4j.io -> https://xxx.databases.neo4j.io
   * neo4j://localhost:7687 -> http://localhost:7474
   * bolt://localhost:7687 -> http://localhost:7474
   */
  private convertToHttpUrl(uri: string): string {
    let url = uri.trim();

    // Handle neo4j+s:// (Aura and other TLS connections)
    if (url.startsWith('neo4j+s://')) {
      url = url.replace('neo4j+s://', 'https://');
    }
    // Handle neo4j+ssc:// (self-signed certificates)
    else if (url.startsWith('neo4j+ssc://')) {
      url = url.replace('neo4j+ssc://', 'https://');
    }
    // Handle neo4j:// (plain)
    else if (url.startsWith('neo4j://')) {
      url = url.replace('neo4j://', 'http://');
    }
    // Handle bolt+s://
    else if (url.startsWith('bolt+s://')) {
      url = url.replace('bolt+s://', 'https://');
    }
    // Handle bolt://
    else if (url.startsWith('bolt://')) {
      url = url.replace('bolt://', 'http://');
    }
    // Handle already http/https URLs
    else if (!url.startsWith('http://') && !url.startsWith('https://')) {
      // Assume https if no protocol
      url = 'https://' + url;
    }

    // Remove trailing slash if present
    url = url.replace(/\/$/, '');

    // Handle port conversion for local instances
    // Bolt default port is 7687, HTTP default is 7474
    if (url.includes(':7687')) {
      url = url.replace(':7687', ':7474');
    }

    return url;
  }

  /**
   * Create Basic Auth header
   */
  private createAuthHeader(username: string, password: string): string {
    const credentials = btoa(`${username}:${password}`);
    return `Basic ${credentials}`;
  }

  /**
   * Get the HTTP API endpoint URL
   */
  private getQueryUrl(): string {
    return `${this.httpUrl}/db/${this.database}/query/v2`;
  }

  /**
   * Execute a Cypher query
   */
  async query(
    cypher: string,
    parameters?: Record<string, unknown>,
    options?: QueryOptions
  ): Promise<Neo4jHttpResponse> {
    const timeout = options?.timeout ?? this.defaultTimeout;
    const includeCounters = options?.includeCounters ?? false;

    const requestBody: Neo4jHttpRequest = {
      statement: cypher,
      parameters: parameters ?? {},
      includeCounters,
    };

    const url = this.getQueryUrl();

    logger.debug('Neo4j query', {
      url,
      cypher: cypher.substring(0, 100),
      hasParams: !!parameters,
    });

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.authHeader,
          Accept: 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle HTTP errors
      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Neo4j HTTP error', {
          status: response.status,
          statusText: response.statusText,
          body: errorText.substring(0, 500),
        });

        if (response.status === 401) {
          throw new Neo4jConnectionError('Authentication failed. Check your Neo4j credentials.');
        }
        if (response.status === 403) {
          throw new Neo4jConnectionError('Access denied. Check your database permissions.');
        }
        if (response.status === 404) {
          throw new Neo4jConnectionError(
            `Database "${this.database}" not found or HTTP API not available.`
          );
        }

        throw new Neo4jConnectionError(
          `Neo4j HTTP error: ${response.status} ${response.statusText}`
        );
      }

      const result = (await response.json()) as Neo4jHttpResponse;

      // Check for Neo4j query errors in the response
      if (result.errors && result.errors.length > 0) {
        const firstError = result.errors[0];
        if (firstError) {
          logger.error('Neo4j query error', {
            code: firstError.code,
            message: firstError.message,
          });
          throw new Neo4jQueryError(firstError.message, firstError.code);
        }
      }

      return result;
    } catch (error) {
      // Handle abort/timeout
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Neo4jQueryError(`Query timed out after ${timeout} seconds`);
      }

      // Handle fetch errors (network issues)
      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new Neo4jConnectionError(
          `Failed to connect to Neo4j at ${this.httpUrl}. Check your connection settings.`
        );
      }

      // Re-throw known errors
      if (error instanceof Neo4jConnectionError || error instanceof Neo4jQueryError) {
        throw error;
      }

      // Wrap unknown errors
      throw new Neo4jConnectionError(
        `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Test the connection to Neo4j
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.query('RETURN 1 AS test', {}, { timeout: 10 });
      return true;
    } catch (error) {
      logger.error('Connection test failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Get database information
   */
  async getDatabaseInfo(): Promise<{ name: string; version: string } | null> {
    try {
      const result = await this.query(
        'CALL dbms.components() YIELD name, versions RETURN name, versions[0] AS version',
        {},
        { timeout: 10 }
      );

      if (result.data?.values?.length) {
        const row = result.data.values[0];
        if (row) {
          return {
            name: String(row[0] ?? 'Neo4j'),
            version: String(row[1] ?? 'unknown'),
          };
        }
      }

      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Create a Neo4j client from connection config
 */
export function createNeo4jClient(
  connection: Neo4jConnectionConfig,
  options?: Partial<Omit<Neo4jClientConfig, 'connection'>>
): Neo4jClient {
  return new Neo4jClient({
    connection,
    defaultTimeout: options?.defaultTimeout ?? 30,
    tokenLimit: options?.tokenLimit ?? 10000,
    schemaSampleSize: options?.schemaSampleSize ?? 1000,
  });
}
