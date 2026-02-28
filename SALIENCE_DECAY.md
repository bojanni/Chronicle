# Biologically-Inspired Salience Decay System

## Overview

This system implements a comprehensive memory decay mechanism modeled on synaptic plasticity and the Ebbinghaus forgetting curve. It counterbalances the existing salience boost system to create a dynamic equilibrium that mimics biological memory consolidation and forgetting.

## Core Biological Principles

### 1. Long-Term Potentiation (LTP)
Memories with higher salience decay more slowly, mimicking how frequently-accessed neural pathways strengthen over time. The system applies a resistance factor based on current salience:

- Very Low (0.0-0.2): 2x faster decay
- Low (0.2-0.4): 1.33x faster decay  
- Medium (0.4-0.6): Normal decay (baseline)
- High (0.6-0.8): 1.5x slower decay
- Very High (0.8-1.0): 2x slower decay

### 2. Ebbinghaus Forgetting Curve
The system models Hermann Ebbinghaus's discovery that forgetting follows a characteristic curve:
- Steep initial decay in the first hours
- Gradual flattening over time
- Asymptotic minimum retention even after long periods

Formula: `retention = asymptotic + (1 - asymptotic) * e^(-steepness * time)`

### 3. Rehearsal Effect
Each time a memory is accessed (viewed), the decay timer resets and the memory trace strengthens:
- Updates `last_accessed_at` timestamp
- Increments `recall_count`
- Applies LTP boost (0.02 per access, max 0.3)

### 4. Memory Type Differentiation
Different memory types have distinct decay characteristics based on memory systems theory:

| Type | Half-Life | Min Salience | Description |
|------|-----------|--------------|-------------|
| Episodic | 24 hours | 0.1 | Event-based, fast decay |
| Semantic | 168 hours (7 days) | 0.15 | Fact-based, slow decay |
| Procedural | 720 hours (30 days) | 0.2 | Skill-based, very slow decay |
| Emotional | 48 hours | 0.12 | Emotionally-charged, high impact |
| Default | 72 hours (3 days) | 0.1 | Standard parameters |

### 5. Environmental Context (Norepinephrine Effect)
The system models how stress and activity levels affect memory consolidation:

- **Focused Learning** (work hours): 50% slower decay
- **High Activity** (evening): 30% slower decay  
- **Rest Period** (night): 30% faster decay
- **Low Activity** (baseline): Normal decay

This mimics norepinephrine's role in enhancing memory consolidation during active/stressful periods.

## Exponential Decay Algorithm

The core decay formula:
```
N(t) = N0 * (1/2)^(t / t_half) * ebbinghaus_modifier

Where:
- N(t) = salience at time t
- N0 = initial salience
- t = hours since last access
- t_half = effective half-life (adjusted for LTP, recalls, and context)
```

### Effective Half-Life Calculation
```
t_half_effective = t_half_base * LTP_factor * (1 + recall_boost) / environmental_multiplier
```

## Database Schema

### New Columns

**chats table:**
- `last_accessed_at` (BIGINT): Timestamp of last access for decay calculation
- `recall_count` (INTEGER): Number of times accessed (for LTP boost)
- `decay_metadata` (JSONB): Decay history and configuration

**facts table:**
- Same columns as chats for consistency

### New Tables

**salience_decay_metrics:**
- `run_timestamp`: When the decay cycle ran
- `items_processed`: Total items checked
- `items_decayed`: Items that actually decayed
- `average_decay_amount`: Mean salience reduction
- `memory_entropy`: Shannon entropy of salience distribution
- `environmental_context`: Which context was active
- `processing_duration_ms`: Time taken for cycle
- `error_count`: Processing errors encountered

## Cron Job Configuration

The decay service runs as a scheduled background task:

- **Default Interval**: 15 minutes (900,000ms)
- **Batch Size**: 100 items per batch
- **Cursor-based Pagination**: Efficiently processes large datasets
- **Configurable**: Via `SalienceDecayService` constructor options

```javascript
const decayService = new SalienceDecayService(pool, {
  intervalMs: 900000,    // 15 minutes
  batchSize: 100,        // Items per batch
  enableLogging: true,
  enableMetrics: true
});
```

## Observability and Metrics

### Memory Landscape Entropy
The system calculates Shannon entropy of the salience distribution to measure memory organization:

- **High entropy** (~1.0): Uniform distribution, less structured
- **Low entropy** (~0.0): Concentrated distribution, more organized

Formula: `H = -Σ(p(x) * log2(p(x)))` normalized to [0,1]

### Decay History Tracking
Each memory item stores its decay history in `decay_metadata`:

```json
{
  "lastDecayRun": 1709123456789,
  "decayHistory": [
    {
      "timestamp": 1709123456789,
      "previousSalience": 0.8,
      "newSalience": 0.75,
      "hoursSinceAccess": 24,
      "modifiers": {
        "ltpFactor": 1.5,
        "recallBoost": 0.1,
        "environmentalMultiplier": 0.7,
        "ebbinghausModifier": 0.98
      }
    }
  ]
}
```

## IPC API

### Renderer → Main Process

```javascript
// Get current decay metrics and recent runs
const metrics = await window.electronAPI.getDecayMetrics();

// Manually trigger a decay cycle
const result = await window.electronAPI.triggerDecayCycle();

// Change memory type (affects decay rate)
await window.electronAPI.updateMemoryType(chatId, 'semantic');

// Track a chat view (rehearsal event)
await window.electronAPI.trackChatView(chatId);

// Boost salience (existing, now also resets decay timer)
await window.electronAPI.boostSalience(chatId);
```

## Configuration Options

### Memory Type Decay Rates (salienceDecayConfig.js)

Modify `MEMORY_TYPE_DECAY_RATES` to adjust:
- `baseHalfLifeHours`: How long until 50% decay
- `minimumSalience`: Floor to prevent complete loss
- `boostMultiplier`: Reinforcement strength per rehearsal

### Ebbinghaus Parameters

Adjust curve characteristics:
- `initialDecaySteepness`: How rapid initial forgetting is
- `flatteningPointHours`: When curve becomes gradual
- `asymptoticRetention`: Minimum retention floor

### Environmental Contexts

Define custom contexts with:
- `decayRateMultiplier`: <1 for slower decay, >1 for faster
- `description`: Human-readable context name

## Usage Examples

### Setting Memory Type on Upload

```javascript
const chatEntry = {
  id: generateId(),
  type: 'chat',
  title: 'Project Planning Discussion',
  content: '...',
  memory_type: 'episodic',  // Will decay faster
  salience: 0.6,
  // ... other fields
};
```

### Querying with Salience Thresholds

```sql
-- Get high-salience semantic memories
SELECT * FROM chats 
WHERE memory_type = 'semantic' 
AND salience > 0.5
ORDER BY salience DESC;
```

### Accessing Decay Metrics

```javascript
// In your React component
useEffect(() => {
  const fetchMetrics = async () => {
    const { serviceMetrics, recentRuns } = await window.electronAPI.getDecayMetrics();
    
    console.log('Total processed:', serviceMetrics.totalProcessed);
    console.log('Current entropy:', serviceMetrics.entropyHistory.slice(-1)[0]?.entropy);
    console.log('Recent runs:', recentRuns);
  };
  
  fetchMetrics();
}, []);
```

## Performance Considerations

### Batch Processing
- Processes items in configurable batches (default 100)
- Uses cursor-based pagination to avoid large result sets
- Small delay (100ms) between batches to reduce database load

### Indexing
Key indexes for efficient queries:
```sql
CREATE INDEX idx_chats_last_accessed ON chats(last_accessed_at) WHERE salience > 0.1;
CREATE INDEX idx_chats_memory_type ON chats(memory_type);
CREATE INDEX idx_chats_salience ON chats(salience DESC);
```

### Minimum Salience Filtering
Items with salience ≤ 0.1 are excluded from decay processing, reducing unnecessary work for already-faded memories.

## Fine-Tuning Biological Fidelity

The system balances biological accuracy with practical retention. Adjust these parameters to shift the balance:

### More Biological (Faster Decay)
- Reduce `baseHalfLifeHours` for all types
- Increase `initialDecaySteepness`
- Lower `minimumSalience` values
- Reduce environmental protection multipliers

### More Practical (Slower Decay)
- Increase `baseHalfLifeHours`
- Decrease `initialDecaySteepness`  
- Raise `minimumSalience` floors
- Increase recall boost per access

## Integration with Existing Features

The decay system integrates seamlessly with:

1. **Boost System**: Accessing a memory boosts salience AND resets decay timer
2. **Search**: High-salience items rank higher in results
3. **Mind Map**: Salience affects visual prominence
4. **Facts Extraction**: Facts have their own decay tracking

## Testing the Decay System

Run the migration to add new columns:
```bash
node scripts/migrate.js
```

Trigger manual decay cycle:
```javascript
await window.electronAPI.triggerDecayCycle();
```

View decay metrics:
```javascript
const metrics = await window.electronAPI.getDecayMetrics();
console.log(JSON.stringify(metrics, null, 2));
```

## Future Enhancements

Potential additions to the system:

1. **Spaced Repetition Integration**: Automatic scheduling for review
2. **Sleep Consolidation**: Slower decay during "night" hours
3. **Emotional Tagging**: Explicit emotion weights on memories
4. **Contextual Priming**: Related memories decay slower together
5. **Machine Learning**: Learn optimal decay parameters from user behavior

## References

- Ebbinghaus, H. (1885). Memory: A Contribution to Experimental Psychology
- Kandel, E. R. (2001). The molecular biology of memory storage
- Squire, L. R. (2004). Memory systems of the brain
- McGaugh, J. L. (2000). Memory consolidation and the amygdala
