import type { StartedQdrantContainer } from '@testcontainers/qdrant'
import type { VectorDocument } from '../../src/vectordb/types.js'
import { QdrantContainer } from '@testcontainers/qdrant'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { QdrantVectorDatabase } from '../../src/vectordb/qdrant-vectordb.js'

// Helper to create test documents with sensible defaults
function createTestDocument(overrides: Partial<VectorDocument> & { id: string }): VectorDocument {
  return {
    vector: Array.from({ length: 1536 }).fill(0.1) as number[],
    content: 'test content',
    relativePath: 'src/test.ts',
    startLine: 1,
    endLine: 10,
    fileExtension: '.ts',
    metadata: {
      language: 'typescript',
      codebasePath: '/home/user/test-project',
      chunkIndex: 0,
    },
    ...overrides,
  }
}

/**
 * Integration tests for Qdrant gRPC client functionality.
 *
 * Tests use Testcontainers to automatically manage Qdrant instances.
 * Docker is required; tests are automatically skipped if unavailable.
 */
describe('qdrant gRPC Client Integration', () => {
  let container: StartedQdrantContainer | undefined
  let qdrantDb: QdrantVectorDatabase
  const testCollectionName = 'test_grpc_integration'
  let skipTests = false

  // Helper to drop collection if it exists, ignoring errors
  async function dropCollectionIfExists(collectionName: string): Promise<void> {
    const exists = await qdrantDb.hasCollection(collectionName).catch(() => false)
    if (exists) {
      await qdrantDb.dropCollection(collectionName).catch(() => {})
    }
  }

  beforeAll(async () => {
    try {
      container = await new QdrantContainer('qdrant/qdrant:v1.12.5').start()
    }
    catch (error) {
      console.warn('Docker not available, skipping Qdrant tests:', (error as Error).message)
      skipTests = true
    }
  }, 120000)

  beforeEach(async () => {
    if (skipTests || !container) {
      return
    }

    const host = container.getHost()
    const grpcPort = container.getMappedPort(6334)
    qdrantDb = new QdrantVectorDatabase({ address: `http://${host}:${grpcPort}` })

    await dropCollectionIfExists(testCollectionName)
  })

  afterEach(async () => {
    if (skipTests || !container) {
      return
    }
    await dropCollectionIfExists(testCollectionName)
  })

  afterAll(async () => {
    await container?.stop()
  })

  describe('collection Operations', () => {
    it.skipIf(() => skipTests)('should list collections', async () => {
      expect(Array.isArray(await qdrantDb.listCollections())).toBe(true)
    })

    it.skipIf(() => skipTests)('should check if collection exists', async () => {
      expect(await qdrantDb.hasCollection(testCollectionName)).toBe(false)
    })

    it.skipIf(() => skipTests)('should create and drop collection', async () => {
      await qdrantDb.createHybridCollection(testCollectionName, 1536)

      expect(await qdrantDb.hasCollection(testCollectionName)).toBe(true)
      expect(await qdrantDb.listCollections()).toContain(testCollectionName)

      await qdrantDb.dropCollection(testCollectionName)

      expect(await qdrantDb.hasCollection(testCollectionName)).toBe(false)
    })
  })

  describe('document Insertion with Protobuf Structure', () => {
    it.skipIf(() => skipTests)('should insert documents with metadata using gRPC protobuf format', async () => {
      await qdrantDb.createHybridCollection(testCollectionName, 1536)

      const bm25 = qdrantDb.getBM25Generator()
      bm25.learn(['test content for indexing', 'another document'])

      const testDoc = createTestDocument({
        id: 'chunk_1234567890abcdef',
        content: 'test content for indexing',
      })

      await qdrantDb.insertHybrid(testCollectionName, [testDoc])

      const results = await qdrantDb.query(testCollectionName, '', ['metadata'], 1)

      expect(results.length).toBe(1)
      expect(results[0].id).toBeTruthy()
      expect(results[0].metadata).toBeDefined()
    })
  })

  describe('query with Metadata Extraction', () => {
    const metadataTestDocs = [
      { id: 'chunk_0000000000000001', content: 'user authentication service', relativePath: 'src/auth.ts', endLine: 20, chunkIndex: 0, vectorFill: 0.1 },
      { id: 'chunk_0000000000000002', content: 'database connection handler', relativePath: 'src/db.ts', endLine: 15, chunkIndex: 1, vectorFill: 0.2 },
      { id: 'chunk_0000000000000003', content: 'api endpoint controller', relativePath: 'src/api.ts', endLine: 25, chunkIndex: 2, vectorFill: 0.3 },
    ]

    beforeEach(async () => {
      if (skipTests || !container) {
        return
      }

      await qdrantDb.createHybridCollection(testCollectionName, 1536)

      const bm25 = qdrantDb.getBM25Generator()
      bm25.learn(metadataTestDocs.map((d) => d.content))

      const testDocs = metadataTestDocs.map((d) =>
        createTestDocument({
          id: d.id,
          vector: Array.from({ length: 1536 }).fill(d.vectorFill) as number[],
          content: d.content,
          relativePath: d.relativePath,
          endLine: d.endLine,
          metadata: {
            language: 'typescript',
            codebasePath: '/home/user/my-project',
            chunkIndex: d.chunkIndex,
          },
        }),
      )

      await qdrantDb.insertHybrid(testCollectionName, testDocs)
    })

    it.skipIf(() => skipTests)('should query and extract metadata.codebasePath correctly', async () => {
      const results = await qdrantDb.query(testCollectionName, '', ['metadata'], 3)

      expect(results.length).toBeGreaterThan(0)

      for (const result of results) {
        expect(result.metadata).toBeDefined()
        expect(typeof result.metadata).toBe('object')
        expect(result.metadata.codebasePath).toBe('/home/user/my-project')
        expect(result.metadata.language).toBe('typescript')
        expect(typeof result.metadata.chunkIndex).toBe('number')
      }
    })

    it.skipIf(() => skipTests)('should handle protobuf kind.case pattern for string values', async () => {
      const results = await qdrantDb.query(testCollectionName, '', ['content', 'relativePath', 'metadata'], 1)

      expect(results.length).toBe(1)
      const result = results[0]

      expect(typeof result.content).toBe('string')
      expect(result.content.length).toBeGreaterThan(0)
      expect(typeof result.relativePath).toBe('string')
      expect(result.relativePath).toContain('.ts')
      expect(typeof result.metadata).toBe('object')
      expect(result.metadata.codebasePath).toBeTruthy()
    })

    it.skipIf(() => skipTests)('should handle protobuf kind.case pattern for integer values', async () => {
      const results = await qdrantDb.query(testCollectionName, '', ['startLine', 'endLine'], 1)

      expect(results.length).toBe(1)
      const result = results[0]

      expect(typeof result.startLine).toBe('number')
      expect(result.startLine).toBeGreaterThanOrEqual(1)
      expect(typeof result.endLine).toBe('number')
      expect(result.endLine).toBeGreaterThan(result.startLine)
    })

    it.skipIf(() => skipTests)('should return all fields when outputFields is empty', async () => {
      const results = await qdrantDb.query(testCollectionName, '', [], 1)

      expect(results.length).toBe(1)
      const result = results[0]

      expect(result.id).toBeTruthy()
      expect(result.content).toBeTruthy()
      expect(result.relativePath).toBeTruthy()
      expect(typeof result.startLine).toBe('number')
      expect(typeof result.endLine).toBe('number')
      expect(result.fileExtension).toBeTruthy()
      expect(result.metadata).toBeDefined()
      expect(result.metadata.codebasePath).toBeTruthy()
    })

    it.skipIf(() => skipTests)('should filter by fileExtension correctly', async () => {
      const results = await qdrantDb.query(testCollectionName, 'fileExtension == \'.ts\'', ['relativePath'], 10)

      expect(results.length).toBeGreaterThan(0)

      for (const result of results) {
        expect(result.relativePath).toContain('.ts')
      }
    })

    it.skipIf(() => skipTests)('should handle empty collections gracefully', async () => {
      const emptyCollection = 'test_empty_collection'
      await qdrantDb.createHybridCollection(emptyCollection, 1536)

      try {
        const results = await qdrantDb.query(emptyCollection, '', ['metadata'], 10)

        expect(Array.isArray(results)).toBe(true)
        expect(results.length).toBe(0)
      }
      finally {
        await qdrantDb.dropCollection(emptyCollection)
      }
    })
  })

  describe('protobuf Backward Compatibility', () => {
    it.skipIf(() => skipTests)('should handle both kind.value and direct value access patterns', async () => {
      await qdrantDb.createHybridCollection(testCollectionName, 1536)

      const bm25 = qdrantDb.getBM25Generator()
      bm25.learn(['test content'])

      const testDoc = createTestDocument({
        id: 'chunk_aaaaaaaaaaaaaaaa',
        vector: Array.from({ length: 1536 }).fill(0.5) as number[],
        content: 'test content',
        relativePath: 'test.ts',
        metadata: { language: 'typescript', codebasePath: '/test/path', chunkIndex: 0 },
      })

      await qdrantDb.insertHybrid(testCollectionName, [testDoc])

      const results = await qdrantDb.query(testCollectionName, '', ['content', 'metadata'], 1)

      expect(results.length).toBe(1)
      expect(results[0].content).toBe('test content')
      expect(results[0].metadata.codebasePath).toBe('/test/path')
    })
  })

  describe('sync Integration', () => {
    it.skipIf(() => skipTests)('should allow sync to extract codebasePath from Qdrant collections', async () => {
      await qdrantDb.createHybridCollection(testCollectionName, 1536)

      const bm25 = qdrantDb.getBM25Generator()
      bm25.learn(['sync test'])

      const testDoc = createTestDocument({
        id: 'chunk_bbbbbbbbbbbbbbbb',
        content: 'sync test',
        relativePath: 'src/sync.ts',
        endLine: 5,
        metadata: { language: 'typescript', codebasePath: '/home/user/sync-project', chunkIndex: 0 },
      })

      await qdrantDb.insertHybrid(testCollectionName, [testDoc])

      const results = await qdrantDb.query(testCollectionName, '', ['metadata'], 1)

      expect(results.length).toBe(1)
      expect(results[0].metadata).toBeDefined()

      const metadata = typeof results[0].metadata === 'string'
        ? JSON.parse(results[0].metadata)
        : results[0].metadata

      expect(metadata.codebasePath).toBe('/home/user/sync-project')
      expect(typeof metadata.codebasePath).toBe('string')
    })
  })

  describe('hybrid Search with BM25', () => {
    const hybridTestDocs = [
      { id: 'chunk_0000000000000001', content: 'function get_resolver() { return new URLResolver(); }', relativePath: 'urls/resolvers.py', startLine: 1, endLine: 5, vectorFill: 0.1 },
      { id: 'chunk_0000000000000002', content: 'def get_resolver(): return URLResolver()', relativePath: 'urls/base.py', startLine: 10, endLine: 15, vectorFill: 0.2 },
      { id: 'chunk_0000000000000003', content: 'class URLResolver: pass', relativePath: 'urls/resolver.py', startLine: 20, endLine: 25, vectorFill: 0.3 },
    ]

    beforeEach(async () => {
      if (skipTests || !container) {
        return
      }

      await qdrantDb.createHybridCollection(testCollectionName, 384)

      const testDocs = hybridTestDocs.map((d) =>
        createTestDocument({
          id: d.id,
          vector: Array.from({ length: 384 }).fill(d.vectorFill) as number[],
          content: d.content,
          relativePath: d.relativePath,
          startLine: d.startLine,
          endLine: d.endLine,
          fileExtension: '.py',
          metadata: { codebasePath: '/test/django' },
        }),
      )

      const bm25Generator = qdrantDb.getBM25Generator()
      bm25Generator.learn(testDocs.map((doc) => doc.content))

      await qdrantDb.insertHybrid(testCollectionName, testDocs)
    })

    it.skipIf(() => skipTests)('should perform hybrid search successfully', async () => {
      const denseVector = Array.from({ length: 384 }).fill(0.15) as number[]

      const results = await qdrantDb.hybridSearch(
        testCollectionName,
        [{ data: denseVector, limit: 10 }, { data: 'get_resolver function', limit: 10 }],
        { limit: 3 },
      )

      expect(results).toBeDefined()
      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThan(0)
      expect(results.length).toBeLessThanOrEqual(3)

      for (const result of results) {
        expect(result.document).toBeDefined()
        expect(result.document.content).toBeTruthy()
        expect(result.score).toBeGreaterThan(0)
      }
    })

    it.skipIf(() => skipTests)('should handle query with empty sparse vector gracefully', async () => {
      const denseVector = Array.from({ length: 384 }).fill(0.15) as number[]

      const results = await qdrantDb.hybridSearch(
        testCollectionName,
        [{ data: denseVector, limit: 10 }, { data: 'nonexistent_unknown_term_xyz', limit: 10 }],
        { limit: 3 },
      )

      expect(results).toBeDefined()
      expect(Array.isArray(results)).toBe(true)
    })

    it.skipIf(() => skipTests)('should handle BM25 model persistence across searches', async () => {
      const denseVector1 = Array.from({ length: 384 }).fill(0.1) as number[]
      const results1 = await qdrantDb.hybridSearch(
        testCollectionName,
        [{ data: denseVector1, limit: 10 }, { data: 'get_resolver', limit: 10 }],
        { limit: 3 },
      )

      expect(results1).toBeDefined()
      expect(results1.length).toBeGreaterThan(0)

      const denseVector2 = Array.from({ length: 384 }).fill(0.2) as number[]
      const results2 = await qdrantDb.hybridSearch(
        testCollectionName,
        [{ data: denseVector2, limit: 10 }, { data: 'URLResolver class', limit: 10 }],
        { limit: 3 },
      )

      expect(results2).toBeDefined()
      expect(results2.length).toBeGreaterThan(0)
    })
  })
})
