/**
 * Test Script for Salience Decay System
 * 
 * This script demonstrates and validates the biologically-inspired
 * salience decay mechanism.
 */

'use strict';

const { Pool } = require('pg');
const { SalienceDecayService } = require('../services/salienceDecayService');
const { getDecayParamsForType, getLTPResistanceFactor, getRecallBoost } = require('../services/salienceDecayConfig');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/ai_chat_archive'
});

/**
 * Test 1: Verify decay calculation for different memory types
 */
async function testMemoryTypeDecayRates() {
  console.log('\n📊 Test 1: Memory Type Decay Rates\n');
  
  const service = new SalienceDecayService(pool);
  const initialSalience = 0.8;
  const hoursInactive = 48; // 2 days
  
  const types = ['episodic', 'semantic', 'procedural', 'emotional', 'default'];
  
  console.log('Initial salience:', initialSalience);
  console.log('Hours since access:', hoursInactive);
  console.log('\nDecay by memory type:');
  console.log('─'.repeat(50));
  
  for (const type of types) {
    const params = getDecayParamsForType(type);
    const result = service.calculateDecay(initialSalience, hoursInactive, type, 0);
    
    console.log(`${type.padEnd(12)} | Half-life: ${params.baseHalfLifeHours}h | New salience: ${result.newSalience.toFixed(4)} | Decay: ${result.decayAmount.toFixed(4)}`);
  }
}

/**
 * Test 2: Verify LTP resistance (higher salience = slower decay)
 */
async function testLTPResistance() {
  console.log('\n🧠 Test 2: Long-Term Potentiation (LTP) Resistance\n');
  
  const service = new SalienceDecayService(pool);
  const hoursInactive = 72; // 3 days
  
  const salienceLevels = [0.2, 0.4, 0.6, 0.8, 1.0];
  
  console.log('Testing LTP effect at 72 hours of inactivity:');
  console.log('─'.repeat(60));
  console.log('Initial | LTP Factor | New Salience | Decay %');
  console.log('─'.repeat(60));
  
  for (const salience of salienceLevels) {
    const ltpFactor = getLTPResistanceFactor(salience);
    const result = service.calculateDecay(salience, hoursInactive, 'semantic', 0);
    const decayPercent = ((result.decayAmount / salience) * 100).toFixed(1);
    
    console.log(`${salience.toFixed(1).padStart(7)} | ${ltpFactor.toFixed(2).padStart(10)} | ${result.newSalience.toFixed(4).padStart(12)} | ${decayPercent.padStart(6)}%`);
  }
}

/**
 * Test 3: Verify recall boost effect
 */
async function testRecallBoost() {
  console.log('\n🔄 Test 3: Recall Count Boost Effect\n');
  
  const recallCounts = [0, 1, 5, 10, 20];
  const initialSalience = 0.7;
  const hoursInactive = 48;
  
  console.log('Testing recall count effect on decay:');
  console.log('Initial salience:', initialSalience);
  console.log('Hours inactive:', hoursInactive);
  console.log('─'.repeat(50));
  console.log('Recalls | Boost | Effective Half-life | New Salience');
  console.log('─'.repeat(50));
  
  const service = new SalienceDecayService(pool);
  const params = getDecayParamsForType('semantic');
  
  for (const count of recallCounts) {
    const boost = getRecallBoost(count);
    const effectiveHalfLife = params.baseHalfLifeHours * (1 + boost);
    const result = service.calculateDecay(initialSalience, hoursInactive, 'semantic', count);
    
    console.log(`${count.toString().padStart(7)} | ${boost.toFixed(2).padStart(5)} | ${effectiveHalfLife.toFixed(0).padStart(19)}h | ${result.newSalience.toFixed(4)}`);
  }
}

/**
 * Test 4: Ebbinghaus curve demonstration
 */
async function testEbbinghausCurve() {
  console.log('\n📈 Test 4: Ebbinghaus Forgetting Curve\n');
  
  const service = new SalienceDecayService(pool);
  const initialSalience = 1.0;
  const memoryType = 'episodic';
  
  const timePoints = [1, 6, 24, 48, 168, 720]; // hours
  
  console.log('Ebbinghaus forgetting curve for episodic memory:');
  console.log('Initial salience:', initialSalience);
  console.log('─'.repeat(50));
  console.log('Hours | Base Decay | With Ebbinghaus | Retention %');
  console.log('─'.repeat(50));
  
  for (const hours of timePoints) {
    const result = service.calculateDecay(initialSalience, hours, memoryType, 0);
    const baseDecay = Math.pow(0.5, hours / 24) * initialSalience; // Without Ebbinghaus
    const retention = ((result.newSalience / initialSalience) * 100).toFixed(1);
    
    console.log(`${hours.toString().padStart(5)}h | ${baseDecay.toFixed(4).padStart(10)} | ${result.newSalience.toFixed(4).padStart(15)} | ${retention.padStart(9)}%`);
  }
}

/**
 * Test 5: Environmental context effects
 */
async function testEnvironmentalContext() {
  console.log('\n🌍 Test 5: Environmental Context Effects\n');
  
  const { ENVIRONMENTAL_CONTEXTS } = require('../services/salienceDecayConfig');
  
  console.log('Norepinephrine-modulated consolidation:');
  console.log('─'.repeat(60));
  console.log('Context            | Multiplier | Effect');
  console.log('─'.repeat(60));
  
  for (const [key, context] of Object.entries(ENVIRONMENTAL_CONTEXTS)) {
    const effect = context.decayRateMultiplier < 1 
      ? `${((1 - context.decayRateMultiplier) * 100).toFixed(0)}% slower decay`
      : `${((context.decayRateMultiplier - 1) * 100).toFixed(0)}% faster decay`;
    
    console.log(`${key.padEnd(18)} | ${context.decayRateMultiplier.toFixed(1).padStart(10)} | ${effect}`);
  }
}

/**
 * Test 6: Database integration test
 */
async function testDatabaseIntegration() {
  console.log('\n💾 Test 6: Database Integration\n');
  
  const client = await pool.connect();
  
  try {
    // Check if required columns exist
    const columnsResult = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'chats' 
      AND column_name IN ('last_accessed_at', 'decay_metadata', 'recall_count')
    `);
    
    console.log('Required columns in chats table:');
    columnsResult.rows.forEach(row => {
      console.log(`  ✓ ${row.column_name}`);
    });
    
    // Check salience_decay_metrics table
    const metricsTableResult = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'salience_decay_metrics'
      )
    `);
    
    console.log('\nSalience decay metrics table:', 
      metricsTableResult.rows[0].exists ? '✓ exists' : '✗ missing');
    
    // Check indexes
    const indexResult = await client.query(`
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename = 'chats' 
      AND indexname LIKE '%last_accessed%'
    `);
    
    console.log('Last accessed index:', 
      indexResult.rows.length > 0 ? '✓ exists' : '✗ missing');
    
  } finally {
    client.release();
  }
}

/**
 * Test 7: Full decay cycle (if database has data)
 */
async function testDecayCycle() {
  console.log('\n🔄 Test 7: Full Decay Cycle\n');
  
  const client = await pool.connect();
  
  try {
    // Check if we have test data
    const countResult = await client.query('SELECT COUNT(*) as count FROM chats WHERE salience > 0.1');
    const itemCount = parseInt(countResult.rows[0].count);
    
    console.log(`Found ${itemCount} items with salience > 0.1`);
    
    if (itemCount === 0) {
      console.log('⚠ No data to process. Add some chats first.');
      return;
    }
    
    const service = new SalienceDecayService(pool, {
      batchSize: 10,
      enableLogging: false
    });
    
    console.log('\nRunning decay cycle...');
    const result = await service.runDecayCycle();
    
    if (result) {
      console.log('✓ Decay cycle completed');
      console.log(`  Processed: ${result.processed} items`);
      console.log(`  Decayed: ${result.decayed} items`);
      console.log(`  Entropy: ${result.entropy.toFixed(4)}`);
      console.log(`  Duration: ${result.duration}ms`);
      console.log(`  Batches: ${result.batches}`);
    }
    
  } finally {
    client.release();
  }
}

/**
 * Test 8: Minimum salience floor
 */
async function testMinimumSalienceFloor() {
  console.log('\n🛡 Test 8: Minimum Salience Floor\n');
  
  const service = new SalienceDecayService(pool);
  
  console.log('Testing minimum salience floors by memory type:');
  console.log('─'.repeat(50));
  console.log('Memory Type  | Min Salience | Max Decay');
  console.log('─'.repeat(50));
  
  const types = ['episodic', 'semantic', 'procedural', 'emotional', 'default'];
  
  for (const type of types) {
    const params = getDecayParamsForType(type);
    const maxDecay = 1.0 - params.minimumSalience;
    
    console.log(`${type.padEnd(11)} | ${params.minimumSalience.toFixed(2).padStart(12)} | ${maxDecay.toFixed(2).padStart(9)}`);
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║     Salience Decay System - Test Suite                 ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  
  try {
    await testMemoryTypeDecayRates();
    await testLTPResistance();
    await testRecallBoost();
    await testEbbinghausCurve();
    await testEnvironmentalContext();
    await testDatabaseIntegration();
    await testMinimumSalienceFloor();
    await testDecayCycle();
    
    console.log('\n✅ All tests completed!\n');
    
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run tests if executed directly
if (require.main === module) {
  runAllTests();
}

module.exports = {
  runAllTests
};
