/**
 * Neo4j Schema Extraction
 *
 * Provides functions to extract and format the database schema
 * for LLM consumption.
 */

import type { Neo4jClient } from './client.js';
import type {
  ProcessedSchema,
  ProcessedLabel,
  ProcessedRelationship,
  ProcessedRelationshipType,
  ApocSchemaResult,
} from './types.js';
import * as logger from '../utils/logger.js';

/**
 * Extract schema from Neo4j database
 *
 * Tries APOC meta.schema first, falls back to manual extraction
 * if APOC is not available.
 */
export async function extractSchema(
  client: Neo4jClient,
  sampleSize: number = 1000
): Promise<ProcessedSchema> {
  logger.info('Extracting Neo4j schema', { sampleSize });

  try {
    // Try APOC first
    return await extractSchemaWithApoc(client, sampleSize);
  } catch (error) {
    logger.warn('APOC schema extraction failed, using fallback', {
      error: error instanceof Error ? error.message : String(error),
    });

    // Fallback to manual extraction
    return await extractSchemaManually(client, sampleSize);
  }
}

/**
 * Extract schema using APOC meta.schema
 */
async function extractSchemaWithApoc(
  client: Neo4jClient,
  sampleSize: number
): Promise<ProcessedSchema> {
  const result = await client.query(
    `CALL apoc.meta.schema({sample: $sample})`,
    { sample: sampleSize },
    { timeout: 60 }
  );

  if (!result.data?.values?.length) {
    throw new Error('Empty schema result from APOC');
  }

  const schemaData = result.data.values[0]?.[0] as ApocSchemaResult | undefined;
  if (!schemaData) {
    throw new Error('Invalid schema format from APOC');
  }

  return processApocSchema(schemaData);
}

/**
 * Process APOC schema result into our format
 */
function processApocSchema(schema: ApocSchemaResult): ProcessedSchema {
  const labels: ProcessedLabel[] = [];
  const relationshipTypes: ProcessedRelationshipType[] = [];

  for (const [name, entry] of Object.entries(schema)) {
    if (entry.type === 'node') {
      const label: ProcessedLabel = {
        name,
        count: entry.count,
        properties: [],
        outgoingRelationships: [],
        incomingRelationships: [],
      };

      // Process properties
      if (entry.properties) {
        for (const [propName, propInfo] of Object.entries(entry.properties)) {
          const propType = Array.isArray(propInfo.type)
            ? propInfo.type.join(' | ')
            : propInfo.type;

          label.properties.push({
            name: propName,
            type: propType,
            indexed: propInfo.indexed,
            unique: propInfo.unique,
          });
        }
      }

      // Process relationships
      if (entry.relationships) {
        for (const [relType, relInfo] of Object.entries(entry.relationships)) {
          const direction = relInfo.direction ?? 'out';
          const targets = relInfo.labels ?? [];

          for (const target of targets) {
            const rel: ProcessedRelationship = {
              type: relType,
              targetLabel: target,
              count: relInfo.count,
            };

            if (direction === 'out' || direction === 'both') {
              label.outgoingRelationships.push(rel);
            }
            if (direction === 'in' || direction === 'both') {
              label.incomingRelationships.push({ ...rel, targetLabel: target });
            }
          }
        }
      }

      labels.push(label);
    } else if (entry.type === 'relationship') {
      const relType: ProcessedRelationshipType = {
        name,
        count: entry.count,
        properties: [],
        startLabels: [],
        endLabels: [],
      };

      // Process properties
      if (entry.properties) {
        for (const [propName, propInfo] of Object.entries(entry.properties)) {
          const propType = Array.isArray(propInfo.type)
            ? propInfo.type.join(' | ')
            : propInfo.type;

          relType.properties.push({
            name: propName,
            type: propType,
            indexed: propInfo.indexed,
            unique: propInfo.unique,
          });
        }
      }

      relationshipTypes.push(relType);
    }
  }

  // Generate summary
  const summary = generateSchemaSummary(labels, relationshipTypes);

  return { labels, relationshipTypes, summary };
}

/**
 * Extract schema manually without APOC
 */
async function extractSchemaManually(
  client: Neo4jClient,
  sampleSize: number
): Promise<ProcessedSchema> {
  const labels: ProcessedLabel[] = [];
  const relationshipTypes: ProcessedRelationshipType[] = [];

  // Get all labels
  const labelsResult = await client.query('CALL db.labels()', {}, { timeout: 30 });
  const labelNames: string[] = [];

  if (labelsResult.data?.values) {
    for (const row of labelsResult.data.values) {
      if (row[0] && typeof row[0] === 'string') {
        labelNames.push(row[0]);
      }
    }
  }

  // Get properties for each label
  for (const labelName of labelNames) {
    const label: ProcessedLabel = {
      name: labelName,
      properties: [],
      outgoingRelationships: [],
      incomingRelationships: [],
    };

    // Get sample properties
    try {
      const propsResult = await client.query(
        `MATCH (n:\`${labelName}\`)
         WITH n LIMIT $limit
         UNWIND keys(n) AS key
         WITH key, n[key] AS value
         RETURN DISTINCT key,
                CASE
                  WHEN value IS NULL THEN 'NULL'
                  WHEN value IS :: BOOLEAN THEN 'Boolean'
                  WHEN value IS :: INTEGER THEN 'Integer'
                  WHEN value IS :: FLOAT THEN 'Float'
                  WHEN value IS :: STRING THEN 'String'
                  WHEN value IS :: DATE THEN 'Date'
                  WHEN value IS :: DATETIME THEN 'DateTime'
                  WHEN value IS :: LIST THEN 'List'
                  ELSE 'Unknown'
                END AS type`,
        { limit: sampleSize },
        { timeout: 30 }
      );

      if (propsResult.data?.values) {
        for (const row of propsResult.data.values) {
          if (row[0] && typeof row[0] === 'string') {
            label.properties.push({
              name: row[0],
              type: String(row[1] ?? 'Unknown'),
            });
          }
        }
      }
    } catch {
      // Continue with empty properties if query fails
    }

    // Get outgoing relationships
    try {
      const relsResult = await client.query(
        `MATCH (n:\`${labelName}\`)-[r]->(m)
         WITH type(r) AS relType, labels(m) AS targetLabels
         LIMIT $limit
         UNWIND targetLabels AS target
         RETURN DISTINCT relType, target`,
        { limit: sampleSize },
        { timeout: 30 }
      );

      if (relsResult.data?.values) {
        for (const row of relsResult.data.values) {
          if (row[0] && typeof row[0] === 'string' && row[1] && typeof row[1] === 'string') {
            label.outgoingRelationships.push({
              type: row[0],
              targetLabel: row[1],
            });
          }
        }
      }
    } catch {
      // Continue without relationships if query fails
    }

    labels.push(label);
  }

  // Get relationship types
  const relTypesResult = await client.query(
    'CALL db.relationshipTypes()',
    {},
    { timeout: 30 }
  );

  if (relTypesResult.data?.values) {
    for (const row of relTypesResult.data.values) {
      if (row[0] && typeof row[0] === 'string') {
        relationshipTypes.push({
          name: row[0],
          properties: [],
          startLabels: [],
          endLabels: [],
        });
      }
    }
  }

  // Generate summary
  const summary = generateSchemaSummary(labels, relationshipTypes);

  return { labels, relationshipTypes, summary };
}

/**
 * Generate a human-readable schema summary
 */
function generateSchemaSummary(
  labels: ProcessedLabel[],
  relationshipTypes: ProcessedRelationshipType[]
): string {
  const lines: string[] = [];

  lines.push(`Database Schema Summary:`);
  lines.push(`- ${labels.length} node label(s)`);
  lines.push(`- ${relationshipTypes.length} relationship type(s)`);
  lines.push('');

  if (labels.length > 0) {
    lines.push('Node Labels:');
    for (const label of labels) {
      const propCount = label.properties.length;
      const relCount = label.outgoingRelationships.length + label.incomingRelationships.length;
      lines.push(`  - ${label.name}: ${propCount} properties, ${relCount} relationships`);
    }
    lines.push('');
  }

  if (relationshipTypes.length > 0) {
    lines.push('Relationship Types:');
    for (const relType of relationshipTypes) {
      lines.push(`  - ${relType.name}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format schema for LLM consumption
 */
export function formatSchemaForLLM(schema: ProcessedSchema): string {
  const sections: string[] = [];

  sections.push(schema.summary);
  sections.push('\n---\n');
  sections.push('Detailed Schema:\n');

  // Node labels with properties
  if (schema.labels.length > 0) {
    sections.push('## Node Labels\n');

    for (const label of schema.labels) {
      sections.push(`### ${label.name}`);

      if (label.count !== undefined) {
        sections.push(`Count: ~${label.count} nodes`);
      }

      if (label.properties.length > 0) {
        sections.push('Properties:');
        for (const prop of label.properties) {
          let propLine = `  - ${prop.name}: ${prop.type}`;
          if (prop.indexed) propLine += ' [indexed]';
          if (prop.unique) propLine += ' [unique]';
          sections.push(propLine);
        }
      }

      if (label.outgoingRelationships.length > 0) {
        sections.push('Outgoing Relationships:');
        for (const rel of label.outgoingRelationships) {
          sections.push(`  - (${label.name})-[:${rel.type}]->(${rel.targetLabel})`);
        }
      }

      if (label.incomingRelationships.length > 0) {
        sections.push('Incoming Relationships:');
        for (const rel of label.incomingRelationships) {
          sections.push(`  - (${rel.targetLabel})-[:${rel.type}]->(${label.name})`);
        }
      }

      sections.push('');
    }
  }

  // Relationship types
  if (schema.relationshipTypes.length > 0) {
    sections.push('## Relationship Types\n');

    for (const relType of schema.relationshipTypes) {
      sections.push(`### ${relType.name}`);

      if (relType.count !== undefined) {
        sections.push(`Count: ~${relType.count} relationships`);
      }

      if (relType.properties.length > 0) {
        sections.push('Properties:');
        for (const prop of relType.properties) {
          sections.push(`  - ${prop.name}: ${prop.type}`);
        }
      }

      sections.push('');
    }
  }

  return sections.join('\n');
}
