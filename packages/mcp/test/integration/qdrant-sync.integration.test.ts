import type { StartedQdrantContainer } from '@testcontainers/qdrant'
import * as path from 'node:path'
import { Context, QdrantVectorDatabase } from '@pleaseai/context-please-core'
import { QdrantContainer } from '@testcontainers/qdrant'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeEmbedding } from '../../../core/test/doubles/fake-embedding.js'
import { ToolHandlers } from '../../src/handlers.js'
import { FakeSnapshotManager } from '../doubles/fake-snapshot-manager.js'

/**
 * Integration test for Qdrant sync during background indexing.
 * Uses Testcontainers to automatically manage Qdrant instances.
 */
describe('qdrant Sync During Background Indexing', () => {
  let container: StartedQdrantContainer | undefined
  let handlers: ToolHandlers
  let context: Context
  let snapshotManager: FakeSnapshotManager
  let qdrantDb: QdrantVectorDatabase
  let fixturesPath: string

  // Docker availability check - tests will be skipped if Docker is not available
  let skipTests = false

  beforeAll(async () => {
    try {
      // Start Qdrant container with specific version for test determinism
      container = await new QdrantContainer('qdrant/qdrant:v1.12.5').start()
    }
    catch (error) {
      console.warn('⚠️ Docker not available, skipping Qdrant tests:', (error as Error).message)
      skipTests = true
    }
  }, 120000) // 120 second timeout for image download

  beforeEach(async () => {
    if (skipTests || !container) {
      return
    }

    // Get dynamic port from container
    const host = container.getHost()
    const grpcPort = container.getMappedPort(6334)
    const qdrantUrl = `http://${host}:${grpcPort}`

    // Create real Qdrant connection
    qdrantDb = new QdrantVectorDatabase({
      address: qdrantUrl,
    })

    // Create Context with fake embedding and real Qdrant
    const fakeEmbedding = new FakeEmbedding()
    context = new Context({
      embedding: fakeEmbedding,
      vectorDatabase: qdrantDb,
    })

    // Create fake snapshot manager
    snapshotManager = new FakeSnapshotManager()

    // Create handlers
    handlers = new ToolHandlers(context, snapshotManager)

    // Path to test fixtures
    fixturesPath = path.join(__dirname, '../../../core/test/fixtures/sample-codebase')
  })

  afterEach(async () => {
    if (skipTests || !container) {
      return
    }

    // Clean up: Clear any test collections
    try {
      await context.clearIndex(fixturesPath)
    }
    catch {
      // Ignore if collection doesn't exist
    }

    snapshotManager.reset()
  })

  afterAll(async () => {
    await container?.stop()
  })

  it.skipIf(() => skipTests)('should reproduce: syncIndexedCodebasesFromCloud removes indexing codebase from snapshot', async () => {
    // Arrange: Simulate background indexing starting
    // 1. Create collection (happens during indexing initialization)
    const collectionName = context.getCollectionName(fixturesPath)
    await qdrantDb.createCollection(collectionName, 1536, { useSparse: true })

    // 2. Mark as indexing in snapshot
    snapshotManager.setCodebaseIndexing(fixturesPath, 10) // 10% progress

    // 3. Collection exists but is empty (no documents inserted yet)
    const collections = await qdrantDb.listCollections()
    expect(collections).toContain(collectionName)

    // Act: Call syncIndexedCodebasesFromCloud (happens in handleSearchCode)
    // This simulates what happens when search_code is called during indexing
    await (handlers as any).syncIndexedCodebasesFromCloud()

    // Assert: Codebase should NOT be removed from snapshot
    // (This is where the bug occurs - it gets removed because collection is empty)
    const indexingCodebases = snapshotManager.getIndexingCodebases()
    expect(indexingCodebases).toContain(fixturesPath)
  })

  it.skipIf(() => skipTests)('should fix: syncIndexedCodebasesFromCloud preserves indexing codebases', async () => {
    // Arrange: Same setup as above
    const collectionName = context.getCollectionName(fixturesPath)
    await qdrantDb.createCollection(collectionName, 1536, { useSparse: true })
    snapshotManager.setCodebaseIndexing(fixturesPath, 25)

    // Act: Call sync
    await (handlers as any).syncIndexedCodebasesFromCloud()

    // Assert: With the fix, indexing codebases should be preserved
    const indexingCodebases = snapshotManager.getIndexingCodebases()
    expect(indexingCodebases).toContain(fixturesPath)

    // Verify snapshot is not empty
    const allCodebases = [...snapshotManager.getIndexedCodebases(), ...indexingCodebases]
    expect(allCodebases.length).toBeGreaterThan(0)
  })

  it.skipIf(() => skipTests)('should allow search during indexing after sync', async () => {
    // Arrange: Fully index a codebase
    await context.indexCodebase(fixturesPath)
    snapshotManager.setCodebaseIndexing(fixturesPath, 50)

    // Act 1: Sync (should preserve indexing status)
    await (handlers as any).syncIndexedCodebasesFromCloud()

    // Act 2: Try to search
    const searchResult = await handlers.handleSearchCode({
      path: fixturesPath,
      query: 'user service',
      limit: 5,
    })

    // Assert: Search should work (not return "not indexed" error)
    expect(searchResult.isError).not.toBe(true)
    expect(searchResult.content[0].text).not.toContain('not indexed')
    expect(searchResult.content[0].text).toContain('Indexing in Progress')
  })

  it.skipIf(() => skipTests)('should handle completed indexing correctly after sync', async () => {
    // Arrange: Fully index and mark as completed
    await context.indexCodebase(fixturesPath)
    snapshotManager.setCodebaseIndexed(fixturesPath, {
      indexedFiles: 3,
      totalChunks: 28,
      status: 'completed',
    })

    // Act: Sync
    await (handlers as any).syncIndexedCodebasesFromCloud()

    // Assert: Indexed status should be preserved
    const indexedCodebases = snapshotManager.getIndexedCodebases()
    expect(indexedCodebases).toContain(fixturesPath)

    // Search should work
    const searchResult = await handlers.handleSearchCode({
      path: fixturesPath,
      query: 'user',
      limit: 5,
    })

    expect(searchResult.isError).not.toBe(true)
    expect(searchResult.content[0].text).toContain('Found')
  })

  it.skipIf(() => skipTests)('should remove truly orphaned indexed codebases from snapshot', async () => {
    // Arrange: Add a codebase to snapshot that has NO collection in Qdrant
    // This codebase is marked as "indexed" (not "indexing"), so it should be removed
    const orphanedPath = '/tmp/orphaned-codebase-that-never-existed'
    snapshotManager.setCodebaseIndexed(orphanedPath, {
      indexedFiles: 10,
      totalChunks: 50,
      status: 'completed',
    })

    // Verify it's in snapshot before sync
    expect(snapshotManager.getIndexedCodebases()).toContain(orphanedPath)

    // Act: Sync
    await (handlers as any).syncIndexedCodebasesFromCloud()

    // Assert: Orphaned codebase should be removed (because it's not indexing)
    const indexedCodebases = snapshotManager.getIndexedCodebases()
    expect(indexedCodebases).not.toContain(orphanedPath)
  })

  it.skipIf(() => skipTests)('should NOT remove orphaned indexing codebases from snapshot', async () => {
    // Arrange: Add a codebase that is currently "indexing" but has no collection yet
    // This simulates the race condition where sync happens before collection is created
    const indexingOrphanPath = '/tmp/indexing-orphan-codebase'
    snapshotManager.setCodebaseIndexing(indexingOrphanPath, 5)

    // Verify it's in snapshot before sync
    expect(snapshotManager.getIndexingCodebases()).toContain(indexingOrphanPath)

    // Act: Sync
    await (handlers as any).syncIndexedCodebasesFromCloud()

    // Assert: Indexing codebase should NOT be removed (this is the fix)
    const indexingCodebases = snapshotManager.getIndexingCodebases()
    expect(indexingCodebases).toContain(indexingOrphanPath)
  })

  it.skipIf(() => skipTests)('should handle empty collections during indexing gracefully', async () => {
    // Arrange: Create collection but don't insert any documents yet
    const collectionName = context.getCollectionName(fixturesPath)
    await qdrantDb.createCollection(collectionName, 1536, { useSparse: true })
    snapshotManager.setCodebaseIndexing(fixturesPath, 0) // Just started

    // Act: Multiple syncs (simulates multiple search attempts)
    await (handlers as any).syncIndexedCodebasesFromCloud()
    await (handlers as any).syncIndexedCodebasesFromCloud()
    await (handlers as any).syncIndexedCodebasesFromCloud()

    // Assert: Codebase should still be in snapshot
    const indexingCodebases = snapshotManager.getIndexingCodebases()
    expect(indexingCodebases).toContain(fixturesPath)
  })
})
