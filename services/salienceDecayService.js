/**
 * Salience Decay Service
 * 
 * Implements biologically-inspired memory decay through:
 * - Exponential decay with configurable half-life
 * - Ebbinghaus forgetting curve modeling
 * - Long-Term Potentiation (LTP) effects
 * - Cursor-based batch processing
 * - Scheduled cron job execution
 * - Observability and entropy metrics
 */

'use strict';

const { Pool } = require('pg');
const { 
  getDecayParamsForType, 
  getCurrentEnvironmentalContext, 
  getLTPResistanceFactor,
  getRecallBoost,
  EBBINGHAUS_PARAMS,
  BATCH_CONFIG,
  OBSERVABILITY_CONFIG
} = require('./salienceDecayConfig');

class SalienceDecayService {
  constructor(pool, options = {}) {
    this.pool = pool;
    this.options = {
      intervalMs: options.intervalMs || BATCH_CONFIG.processingIntervalMs,
      batchSize: options.batchSize || BATCH_CONFIG.batchSize,
      enableLogging: options.enableLogging !== false,
      enableMetrics: options.enableMetrics !== false,
      ...options
    };
    
    this.cronJob = null;
    this.isRunning = false;
    this.metrics = {
      totalProcessed: 0,
      totalDecayed: 0,
      lastRunTime: null,
      averageDecayAmount: 0,
      entropyHistory: []
    };
    
    this.processingStats = {
      batchesCompleted: 0,
      errors: [],
      startTime: null
    };
  }

  /**
   * Initialize the database schema for salience decay tracking
   */
  async initializeSchema() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      
      // Add last_accessed_at column if not exists
      await client.query(`
        ALTER TABLE chats 
        ADD COLUMN IF NOT EXISTS last_accessed_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
      `);
      
      // Add decay metadata column for tracking decay history
      await client.query(`
        ALTER TABLE chats 
        ADD COLUMN IF NOT EXISTS decay_metadata JSONB DEFAULT '{}'
      `);
      
      // Add index for efficient decay queries
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chats_last_accessed 
        ON chats(last_accessed_at) 
        WHERE salience > 0.1
      `);
      
      // Create decay metrics table for observability
      await client.query(`
        CREATE TABLE IF NOT EXISTS salience_decay_metrics (
          id SERIAL PRIMARY KEY,
          run_timestamp TIMESTAMPTZ DEFAULT NOW(),
          items_processed INTEGER DEFAULT 0,
          items_decayed INTEGER DEFAULT 0,
          average_decay_amount FLOAT DEFAULT 0,
          memory_entropy FLOAT DEFAULT 0,
          environmental_context TEXT,
          processing_duration_ms INTEGER,
          error_count INTEGER DEFAULT 0
        )
      `);
      
      // Create index on metrics for querying
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_decay_metrics_timestamp 
        ON salience_decay_metrics(run_timestamp DESC)
      `);
      
      // Add last_accessed_at to facts table as well
      await client.query(`
        ALTER TABLE facts 
        ADD COLUMN IF NOT EXISTS last_accessed_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
      `);
      
      await client.query(`
        ALTER TABLE facts 
        ADD COLUMN IF NOT EXISTS decay_metadata JSONB DEFAULT '{}'
      `);
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_facts_last_accessed 
        ON facts(last_accessed_at) 
        WHERE salience > 0.1
      `);
      
      await client.query('COMMIT');
      this._log('info', 'Salience decay schema initialized successfully');
    } catch (err) {
      await client.query('ROLLBACK');
      this._log('error', 'Failed to initialize decay schema:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Calculate exponential decay based on half-life
   * Formula: N(t) = N0 * (1/2)^(t/t_half)
   * 
   * Enhanced with Ebbinghaus curve and LTP effects
   */
  calculateDecay(currentSalience, hoursSinceAccess, memoryType, recallCount = 0) {
    const params = getDecayParamsForType(memoryType);
    const environmentalContext = getCurrentEnvironmentalContext();
    
    // Base half-life from memory type
    let effectiveHalfLife = params.baseHalfLifeHours;
    
    // Apply LTP resistance: higher salience = slower decay
    const ltpFactor = getLTPResistanceFactor(currentSalience);
    effectiveHalfLife *= ltpFactor;
    
    // Apply recall strengthening: each recall extends half-life
    const recallBoost = getRecallBoost(recallCount);
    effectiveHalfLife *= (1 + recallBoost);
    
    // Apply environmental context (norepinephrine effect)
    effectiveHalfLife /= environmentalContext.decayRateMultiplier;
    
    // Calculate base exponential decay
    const decayRatio = Math.pow(0.5, hoursSinceAccess / effectiveHalfLife);
    
    // Apply Ebbinghaus forgetting curve modifier
    // Steep initial decay that flattens over time
    const ebbinghausModifier = this._applyEbbinghausCurve(hoursSinceAccess, decayRatio);
    
    // Calculate new salience
    let newSalience = currentSalience * ebbinghausModifier;
    
    // Apply minimum salience floor
    newSalience = Math.max(newSalience, params.minimumSalience);
    
    // Calculate decay amount for metrics
    const decayAmount = currentSalience - newSalience;
    
    return {
      newSalience,
      decayAmount,
      effectiveHalfLife,
      hoursSinceAccess,
      modifiers: {
        ltpFactor,
        recallBoost,
        environmentalMultiplier: environmentalContext.decayRateMultiplier,
        ebbinghausModifier
      }
    };
  }

  /**
   * Apply Ebbinghaus forgetting curve modifier
   * Initial steep decay that flattens over time
   */
  _applyEbbinghausCurve(hoursSinceAccess, baseDecayRatio) {
    const { initialDecaySteepness, flatteningPointHours, asymptoticRetention } = EBBINGHAUS_PARAMS;
    
    // Normalize time relative to flattening point
    const normalizedTime = hoursSinceAccess / flatteningPointHours;
    
    // Ebbinghaus curve: exponential decay with asymptotic floor
    const forgettingFactor = asymptoticRetention + 
      (1 - asymptoticRetention) * Math.exp(-initialDecaySteepness * normalizedTime);
    
    // Blend base decay with Ebbinghaus curve
    // Weight: more Ebbinghaus influence early, more base decay later
    const ebbinghausWeight = Math.exp(-normalizedTime);
    const blendedDecay = (baseDecayRatio * (1 - ebbinghausWeight)) + 
                        (forgettingFactor * ebbinghausWeight);
    
    return Math.max(blendedDecay, asymptoticRetention);
  }

  /**
   * Process a single batch of items using cursor-based pagination
   */
  async processBatch(tableName, cursor = null) {
    const client = await this.pool.connect();
    const batchStartTime = Date.now();
    
    try {
      // Query items that need decay (salience > minimum and haven't been accessed recently)
      let query = `
        SELECT 
          id, 
          salience, 
          COALESCE(last_accessed_at, createdAt) as last_accessed,
          memory_type,
          recall_count,
          decay_metadata
        FROM ${tableName}
        WHERE salience > 0.1
        AND (decay_metadata->>'lastDecayRun' IS NULL 
             OR (EXTRACT(EPOCH FROM NOW()) * 1000 - 
                 (decay_metadata->>'lastDecayRun')::bigint) > 900000)
      `;
      
      if (cursor) {
        query += ` AND id > $1`;
      }
      
      query += `
        ORDER BY id
        LIMIT $${cursor ? 2 : 1}
      `;
      
      const params = cursor ? [cursor, this.options.batchSize] : [this.options.batchSize];
      const result = await client.query(query, params);
      
      const items = result.rows;
      if (items.length === 0) {
        return { processed: 0, nextCursor: null, decayed: 0 };
      }
      
      let decayedCount = 0;
      let batchDecayAmount = 0;
      const currentTime = Date.now();
      
      // Process each item
      for (const item of items) {
        const hoursSinceAccess = (currentTime - item.last_accessed) / (1000 * 60 * 60);
        
        // Skip if accessed very recently (< 15 minutes)
        if (hoursSinceAccess < 0.25) continue;
        
        const decayResult = this.calculateDecay(
          item.salience,
          hoursSinceAccess,
          item.memory_type,
          item.recall_count || 0
        );
        
        // Only update if salience actually changed
        if (decayResult.newSalience < item.salience) {
          batchDecayAmount += decayResult.decayAmount;
          
          const updatedMetadata = {
            lastDecayRun: currentTime,
            decayHistory: [
              ...(item.decay_metadata?.decayHistory || []).slice(-9), // Keep last 10 entries
              {
                timestamp: currentTime,
                previousSalience: item.salience,
                newSalience: decayResult.newSalience,
                hoursSinceAccess,
                modifiers: decayResult.modifiers
              }
            ]
          };
          
          await client.query(
            `UPDATE ${tableName} 
             SET salience = $1, 
                 decay_metadata = $2 
             WHERE id = $3`,
            [decayResult.newSalience, JSON.stringify(updatedMetadata), item.id]
          );
          
          decayedCount++;
        }
      }
      
      const nextCursor = items.length === this.options.batchSize ? 
        items[items.length - 1].id : null;
      
      return {
        processed: items.length,
        decayed: decayedCount,
        totalDecayAmount: batchDecayAmount,
        nextCursor,
        duration: Date.now() - batchStartTime
      };
      
    } catch (err) {
      this._log('error', `Batch processing error for ${tableName}:`, err);
      this.processingStats.errors.push({
        timestamp: new Date().toISOString(),
        table: tableName,
        cursor,
        error: err.message
      });
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Run full decay cycle on all eligible memory items
   */
  async runDecayCycle() {
    if (this.isRunning) {
      this._log('warn', 'Decay cycle already running, skipping...');
      return null;
    }
    
    this.isRunning = true;
    this.processingStats.startTime = Date.now();
    this.processingStats.batchesCompleted = 0;
    this.processingStats.errors = [];
    
    const runStartTime = Date.now();
    const environmentalContext = getCurrentEnvironmentalContext();
    
    this._log('info', 'Starting salience decay cycle...');
    
    try {
      let totalProcessed = 0;
      let totalDecayed = 0;
      let totalDecayAmount = 0;
      
      // Process chats
      let chatCursor = null;
      do {
        const result = await this.processBatch('chats', chatCursor);
        if (result.processed === 0) break;
        
        totalProcessed += result.processed;
        totalDecayed += result.decayed;
        totalDecayAmount += result.totalDecayAmount || 0;
        this.processingStats.batchesCompleted++;
        chatCursor = result.nextCursor;
        
        // Small delay between batches to prevent database load
        if (chatCursor) await this._sleep(100);
      } while (chatCursor);
      
      // Process facts
      let factCursor = null;
      do {
        const result = await this.processBatch('facts', factCursor);
        if (result.processed === 0) break;
        
        totalProcessed += result.processed;
        totalDecayed += result.decayed;
        totalDecayAmount += result.totalDecayAmount || 0;
        this.processingStats.batchesCompleted++;
        factCursor = result.nextCursor;
        
        if (factCursor) await this._sleep(100);
      } while (factCursor);
      
      // Calculate entropy metrics
      const entropy = await this.calculateMemoryEntropy();
      
      // Update metrics
      const runDuration = Date.now() - runStartTime;
      this.metrics.totalProcessed += totalProcessed;
      this.metrics.totalDecayed += totalDecayed;
      this.metrics.lastRunTime = new Date().toISOString();
      this.metrics.averageDecayAmount = totalDecayed > 0 ? 
        totalDecayAmount / totalDecayed : 0;
      this.metrics.entropyHistory.push({
        timestamp: this.metrics.lastRunTime,
        entropy
      });
      
      // Keep only recent entropy history
      if (this.metrics.entropyHistory.length > 100) {
        this.metrics.entropyHistory = this.metrics.entropyHistory.slice(-100);
      }
      
      // Log metrics to database
      await this._recordMetrics({
        itemsProcessed: totalProcessed,
        itemsDecayed: totalDecayed,
        averageDecayAmount: this.metrics.averageDecayAmount,
        memoryEntropy: entropy,
        environmentalContext: environmentalContext.description,
        processingDurationMs: runDuration,
        errorCount: this.processingStats.errors.length
      });
      
      this._log('info', `Decay cycle completed: ${totalProcessed} processed, ${totalDecayed} decayed, entropy: ${entropy.toFixed(4)}`);
      
      return {
        processed: totalProcessed,
        decayed: totalDecayed,
        entropy,
        duration: runDuration,
        batches: this.processingStats.batchesCompleted,
        errors: this.processingStats.errors.length
      };
      
    } catch (err) {
      this._log('error', 'Decay cycle failed:', err);
      throw err;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Calculate memory landscape entropy
   * Higher entropy = more uniform distribution = less structured memory
   */
  async calculateMemoryEntropy() {
    const client = await this.pool.connect();
    try {
      // Get salience distribution
      const salienceResult = await client.query(`
        SELECT salience FROM chats WHERE salience > 0.1
        UNION ALL
        SELECT salience FROM facts WHERE salience > 0.1
      `);
      
      if (salienceResult.rows.length === 0) return 0;
      
      // Bin salience values into 10 buckets
      const bins = new Array(10).fill(0);
      salienceResult.rows.forEach(row => {
        const binIndex = Math.min(Math.floor(row.salience * 10), 9);
        bins[binIndex]++;
      });
      
      // Calculate Shannon entropy
      const total = salienceResult.rows.length;
      let entropy = 0;
      
      bins.forEach(count => {
        if (count > 0) {
          const probability = count / total;
          entropy -= probability * Math.log2(probability);
        }
      });
      
      // Normalize to 0-1 range (max entropy for 10 bins is log2(10) ≈ 3.32)
      return Math.min(entropy / Math.log2(10), 1);
      
    } finally {
      client.release();
    }
  }

  /**
   * Reset decay timer for an item (called on access/view)
   * Models the "rehearsal" effect in memory consolidation
   */
  async onMemoryAccess(itemId, itemType = 'chat') {
    const client = await this.pool.connect();
    const tableName = itemType === 'fact' ? 'facts' : 'chats';
    
    try {
      const currentTime = Date.now();
      
      // Update last_accessed_at and increment recall_count
      await client.query(
        `UPDATE ${tableName} 
         SET last_accessed_at = $1,
             recall_count = COALESCE(recall_count, 0) + 1
         WHERE id = $2`,
        [currentTime, itemId]
      );
      
      this._log('debug', `Memory accessed: ${itemId}, decay timer reset`);
      
    } catch (err) {
      this._log('error', `Failed to update access time for ${itemId}:`, err);
    } finally {
      client.release();
    }
  }

  /**
   * Start the scheduled cron job
   */
  start() {
    if (this.cronJob) {
      this._log('warn', 'Cron job already running');
      return;
    }
    
    this._log('info', `Starting salience decay cron job (interval: ${this.options.intervalMs}ms)`);
    
    // Run initial cycle
    this.runDecayCycle().catch(err => {
      this._log('error', 'Initial decay cycle failed:', err);
    });
    
    // Schedule recurring runs
    this.cronJob = setInterval(() => {
      this.runDecayCycle().catch(err => {
        this._log('error', 'Scheduled decay cycle failed:', err);
      });
    }, this.options.intervalMs);
  }

  /**
   * Stop the scheduled cron job
   */
  stop() {
    if (this.cronJob) {
      clearInterval(this.cronJob);
      this.cronJob = null;
      this._log('info', 'Salience decay cron job stopped');
    }
  }

  /**
   * Get current metrics and statistics
   */
  getMetrics() {
    return {
      ...this.metrics,
      isRunning: this.isRunning,
      processingStats: this.processingStats
    };
  }

  /**
   * Record metrics to database for persistence
   */
  async _recordMetrics(metrics) {
    if (!this.options.enableMetrics) return;
    
    const client = await this.pool.connect();
    try {
      await client.query(`
        INSERT INTO salience_decay_metrics 
        (items_processed, items_decayed, average_decay_amount, memory_entropy, 
         environmental_context, processing_duration_ms, error_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        metrics.itemsProcessed,
        metrics.itemsDecayed,
        metrics.averageDecayAmount,
        metrics.memoryEntropy,
        metrics.environmentalContext,
        metrics.processingDurationMs,
        metrics.errorCount
      ]);
    } catch (err) {
      this._log('error', 'Failed to record metrics:', err);
    } finally {
      client.release();
    }
  }

  /**
   * Internal logging helper
   */
  _log(level, message, ...args) {
    if (!this.options.enableLogging) return;
    
    const timestamp = new Date().toISOString();
    const prefix = `[SalienceDecay ${timestamp}]`;
    
    switch (level) {
      case 'error':
        console.error(prefix, message, ...args);
        break;
      case 'warn':
        console.warn(prefix, message, ...args);
        break;
      case 'debug':
        if (OBSERVABILITY_CONFIG.logLevel === 'debug') {
          console.log(prefix, message, ...args);
        }
        break;
      default:
        console.log(prefix, message, ...args);
    }
  }

  /**
   * Sleep helper for async delays
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { SalienceDecayService };
