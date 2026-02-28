/**
 * Biologically-Inspired Salience Decay Configuration
 * 
 * Models synaptic plasticity, Ebbinghaus forgetting curves, and
 * norepinephrine-modulated memory consolidation effects.
 * 
 * Key biological principles:
 * 1. Long-Term Potentiation (LTP): Higher salience = slower decay
 * 2. Ebbinghaus Forgetting Curve: Steep initial decay that flattens over time
 * 3. Rehearsal Effect: Each access strengthens memory trace and resets decay timer
 * 4. Stress/Activity Modulation: High-activity periods slow decay (norepinephrine effect)
 * 5. Memory Type Differentiation: Episodic decays faster than semantic
 */

'use strict';

/**
 * Memory types with different decay characteristics
 * Based on memory systems theory:
 * - Episodic: Event-based memories (decay faster)
 * - Semantic: Fact-based memories (decay slower)
 * - Procedural: Skill-based (very slow decay)
 * - Emotional: High initial salience, moderate decay
 */
const MEMORY_TYPE_DECAY_RATES = {
  episodic: {
    baseHalfLifeHours: 24,      // Episodic memories fade within a day without rehearsal
    minimumSalience: 0.1,       // Floor to prevent complete loss
    boostMultiplier: 1.2,       // Each rehearsal boosts more (vivid memories)
    description: 'Event-based memories with faster natural decay'
  },
  semantic: {
    baseHalfLifeHours: 168,     // Semantic knowledge lasts ~1 week
    minimumSalience: 0.15,      // Higher floor for factual knowledge
    boostMultiplier: 1.0,       // Standard rehearsal boost
    description: 'Fact-based knowledge with slower decay'
  },
  procedural: {
    baseHalfLifeHours: 720,     // Skills last ~1 month
    minimumSalience: 0.2,       // Highest floor for learned procedures
    boostMultiplier: 0.9,       // Diminishing returns on practice
    description: 'Skill-based memories with very slow decay'
  },
  emotional: {
    baseHalfLifeHours: 48,      // Emotional memories last ~2 days
    minimumSalience: 0.12,
    boostMultiplier: 1.3,       // Strong reinforcement from recall
    description: 'Emotionally-charged memories with high initial impact'
  },
  default: {
    baseHalfLifeHours: 72,      // Default: 3 days
    minimumSalience: 0.1,
    boostMultiplier: 1.0,
    description: 'Default memory decay parameters'
  }
};

/**
 * Environmental context modifiers
 * Mimics norepinephrine effects on memory consolidation
 */
const ENVIRONMENTAL_CONTEXTS = {
  lowActivity: {
    decayRateMultiplier: 1.0,   // Baseline decay
    description: 'Normal activity levels'
  },
  highActivity: {
    decayRateMultiplier: 0.7,   // 30% slower decay (norepinephrine effect)
    description: 'High activity/stress periods enhance consolidation'
  },
  restPeriod: {
    decayRateMultiplier: 1.3,   // 30% faster decay during rest
    description: 'Rest periods allow normal forgetting'
  },
  focusedLearning: {
    decayRateMultiplier: 0.5,   // 50% slower decay during focused periods
    description: 'Deep focus/learning mode maximizes retention'
  }
};

/**
 * Ebbinghaus forgetting curve parameters
 * Models the characteristic steep initial decay that flattens over time
 * Formula: retention = e^(-t/S) where S is the memory strength
 */
const EBBINGHAUS_PARAMS = {
  // Curve steepness: how quickly initial decay happens
  initialDecaySteepness: 1.5,
  
  // Flattening point: when curve becomes more gradual (in hours)
  flatteningPointHours: 24,
  
  // Asymptotic retention: minimum retention even after long periods
  asymptoticRetention: 0.15,
  
  // Spacing effect: distributed practice is more effective
  spacingFactor: 0.85
};

/**
 * Long-Term Potentiation (LTP) parameters
 * Higher salience memories decay slower (synaptic strengthening)
 */
const LTP_PARAMS = {
  // Salience levels and their decay resistance
  // Higher salience = higher resistance factor (slower decay)
  salienceDecayResistance: {
    veryLow: { maxSalience: 0.2, resistanceFactor: 0.5 },    // Decays 2x faster
    low: { maxSalience: 0.4, resistanceFactor: 0.75 },       // Decays 1.33x faster
    medium: { maxSalience: 0.6, resistanceFactor: 1.0 },     // Normal decay
    high: { maxSalience: 0.8, resistanceFactor: 1.5 },      // Decays 1.5x slower
    veryHigh: { maxSalience: 1.0, resistanceFactor: 2.0 }    // Decays 2x slower
  },
  
  // Recall count effect: more recalls = stronger memory trace
  recallBoostPerAccess: 0.02,
  maxRecallBoost: 0.3
};

/**
 * Batch processing configuration for performance
 */
const BATCH_CONFIG = {
  batchSize: 100,               // Process 100 items per batch
  cursorTimeoutMs: 30000,       // 30 second timeout for cursor operations
  maxConcurrentBatches: 3,      // Limit concurrent database operations
  processingIntervalMs: 900000,  // 15 minutes default (900 seconds)
  lowTrafficCheckWindowMs: 60000 // Check for low traffic in 1-minute windows
};

/**
 * Observability configuration
 */
const OBSERVABILITY_CONFIG = {
  logLevel: process.env.SALIENCE_DECAY_LOG_LEVEL || 'info',
  enableMetrics: true,
  metricsRetentionHours: 168,   // Keep metrics for 1 week
  alertThresholds: {
    highDecayRate: 0.5,         // Alert if >50% decay in single run
    processingErrorRate: 0.1,   // Alert if >10% errors
    entropySpike: 0.3           // Alert if entropy increases >30%
  }
};

/**
 * Calculate current environmental context based on system metrics
 * This would be hooked into actual system monitoring
 */
function getCurrentEnvironmentalContext() {
  // Default to low activity
  // In production, this would check CPU, memory, user activity, etc.
  const hour = new Date().getHours();
  
  // Assume focused learning during work hours (9-17)
  if (hour >= 9 && hour <= 17) {
    return ENVIRONMENTAL_CONTEXTS.focusedLearning;
  }
  
  // High activity during evening hours (18-22)
  if (hour >= 18 && hour <= 22) {
    return ENVIRONMENTAL_CONTEXTS.highActivity;
  }
  
  // Rest period during night/early morning
  return ENVIRONMENTAL_CONTEXTS.restPeriod;
}

/**
 * Get decay parameters for a specific memory type
 */
function getDecayParamsForType(memoryType) {
  const type = memoryType?.toLowerCase() || 'default';
  return MEMORY_TYPE_DECAY_RATES[type] || MEMORY_TYPE_DECAY_RATES.default;
}

/**
 * Calculate LTP resistance factor based on current salience
 */
function getLTPResistanceFactor(salience) {
  const levels = Object.values(LTP_PARAMS.salienceDecayResistance);
  
  for (const level of levels) {
    if (salience <= level.maxSalience) {
      return level.resistanceFactor;
    }
  }
  
  return LTP_PARAMS.salienceDecayResistance.veryHigh.resistanceFactor;
}

/**
 * Calculate recall-based strengthening bonus
 */
function getRecallBoost(recallCount) {
  const boost = recallCount * LTP_PARAMS.recallBoostPerAccess;
  return Math.min(boost, LTP_PARAMS.maxRecallBoost);
}

module.exports = {
  MEMORY_TYPE_DECAY_RATES,
  ENVIRONMENTAL_CONTEXTS,
  EBBINGHAUS_PARAMS,
  LTP_PARAMS,
  BATCH_CONFIG,
  OBSERVABILITY_CONFIG,
  getCurrentEnvironmentalContext,
  getDecayParamsForType,
  getLTPResistanceFactor,
  getRecallBoost
};
